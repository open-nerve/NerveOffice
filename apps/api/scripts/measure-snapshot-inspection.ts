// DEF-018 的测量（M3-P3 设计 §3.3；不进 CI）：快照检查放进子进程池之后，内存与事件循环怎样。
// 对构建出来的后端（apps/api/dist）的 SnapshotInspector 提交 5 MiB 以内的真实形状快照与几种恶意形状：
// 1. 每种形状在不同的堆上限（--max-old-space-size）下单独检查一份：检查得完（结果与耗时），还是子进程的堆超限（too-complex）。
//    每个组合在单独的进程里跑；那个进程（子进程池所在的主进程）中止的话记"**主进程中止**"——子进程池之下不应出现；
// 2. 每种形状同时提交几份（默认 8 份，子进程池用配置的默认值），记每份的耗时（提交到拿到结果，含排队）、主进程的事件循环延迟的峰值、
//    主进程 RSS 与堆的峰值（进程里每 5 ms 取一次），每个子进程的峰值（场景结束时读：Linux 是 RSS 的峰值 VmHWM，
//    macOS 是 vmmap 的 Physical footprint (peak)），Linux 上另有容器（cgroup）实际占的内存的峰值（在这个脚本里从外面每 20 ms 读一次）；
//    不从外面每隔几毫秒起 ps 取 RSS：macOS 上它会拖慢被测的进程。同样的几份在主进程里直接检查（inspectSnapshot，两份之间让出一次事件循环）对照。
//    每个场景（形状 × 方式）一个进程：RSS 不会立刻还给系统，同一个进程里前面的场景会抬高后面的；
// 3. 子进程的冷启动（从无到检查完一份最小的快照）与空闲时每个子进程的 RSS；检查过一份 5 MiB 的真实快照之后，空闲的子进程的 RSS 怎样回落。
// 运行（仓库根目录，先构建后端）：
//   pnpm --filter "@nerve-office/api..." run build && node --expose-gc apps/api/scripts/measure-snapshot-inspection.ts
// 在生产镜像里跑（Linux、镜像里的构建产物；镜像按 deploy/Dockerfile 构建）：
//   docker run --rm -v "$PWD/apps/api/scripts:/app/apps/api/scripts:ro" --entrypoint node <镜像> --expose-gc scripts/measure-snapshot-inspection.ts
// 可选参数：--concurrency <n>（同时提交几份，默认 8）、--rounds <n>（每种形状几轮，默认 3）、--processes <n>、--heap-mb <n>（默认取配置的默认值）、
// --only <形状,…>、--heaps <MiB,…>（堆上限的候选）、--skip-heap-search、--skip-concurrency、--skip-idle、--retention（空闲回落，约 1 分钟）。
// 结果是 Markdown 的表，打印到标准输出
import type { DocumentProfile } from '@nerve-office/contracts'
import type { InspectionOutcome, SnapshotInspectionSettings } from '../src/modules/documents/snapshot-inspector.ts'
import type { AppLogger } from '../src/modules/logging/index.ts'
import { Buffer } from 'node:buffer'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { SHEET_TEMPLATE, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'

type InspectorModule = typeof import('../src/modules/documents/snapshot-inspector.ts')
type InspectionModule = typeof import('../src/modules/documents/snapshot-inspection.ts')
type ChecksModule = typeof import('../src/modules/documents/snapshot-checks.ts')
type ConfigModule = typeof import('../src/modules/config/config.ts')

/**
 * 构建产物里的模块：测的是构建出来的后端（子进程的入口是 .js，contracts 解析到它的构建产物）。类型取源码里的同一个模块
 */
async function built<Module>(path: string): Promise<Module> {
  // eslint-disable-next-line no-restricted-syntax -- 测的是构建产物（dist 里没有类型声明，不能静态引用）；这个脚本不进产物，不在任何模块的边界之内
  return await import(new URL(`../dist/${path}`, import.meta.url).href) as Module
}

const { SnapshotInspector, IDLE_PROCESS_TIMEOUT_MS } = await built<InspectorModule>('modules/documents/snapshot-inspector.js')
const { inspectSnapshot } = await built<InspectionModule>('modules/documents/snapshot-inspection.js')
const { SNAPSHOT_MAX_ENTRIES } = await built<ChecksModule>('modules/documents/snapshot-checks.js')
const { loadConfig } = await built<ConfigModule>('modules/config/config.js')

const { values: args } = parseArgs({
  options: {
    'concurrency': { type: 'string', default: '8' },
    'rounds': { type: 'string', default: '3' },
    'processes': { type: 'string' },
    'heap-mb': { type: 'string' },
    'only': { type: 'string' },
    'heaps': { type: 'string', default: '64,96,128,160,192,256,384,512' },
    'skip-heap-search': { type: 'boolean', default: false },
    'skip-concurrency': { type: 'boolean', default: false },
    'skip-idle': { type: 'boolean', default: false },
    'retention': { type: 'boolean', default: false },
    // 单独的进程：单独检查一份（堆上限的搜索用）、一个同时提交的场景（形状:pool 或 形状:main）、空闲的子进程、空闲之后的回落
    'child-shape': { type: 'string' },
    'child-heap': { type: 'string' },
    'child-scenario': { type: 'string' },
    'child-idle': { type: 'boolean', default: false },
    'child-retention': { type: 'boolean', default: false },
  },
})

const DEFAULTS = loadConfig({ NERVE_DATABASE_URL: 'postgres://measure@127.0.0.1/measure', NERVE_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }).snapshotInspection
const SETTINGS: SnapshotInspectionSettings = {
  ...DEFAULTS,
  processes: args.processes === undefined ? DEFAULTS.processes : Number(args.processes),
  heapMb: args['heap-mb'] === undefined ? DEFAULTS.heapMb : Number(args['heap-mb']),
}
const CONCURRENCY = Number(args.concurrency)
const ROUNDS = Number(args.rounds)
const PROFILE: DocumentProfile = 'sheet@1'
const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const MIB = 1024 * 1024
const SCRIPT = fileURLToPath(import.meta.url)

function write(line = ''): void {
  process.stdout.write(`${line}\n`)
}

/** 只把出错写到标准错误；其余的日志不要（测量自己打印结果） */
const logger = {
  with: () => logger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (message: string) => process.stderr.write(`[error] ${message}\n`),
} as unknown as AppLogger

/** 有 --expose-gc 时先回收一次，各轮从相近的起点开始 */
function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc
  collect?.()
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ---- 进程的内存：Linux 读 /proc 与 cgroup（镜像里没有 ps），macOS 用 ps 与 vmmap ----

interface ProcessRss {
  readonly pid: number
  readonly ppid: number
  /** 字节 */
  readonly rss: number
  /** 是 Node 的进程（macOS 上取样用的 ps、vmmap 也是这个脚本的子进程，不算） */
  readonly node: boolean
}

const execFileAsync = promisify(execFile)

async function processTable(): Promise<readonly ProcessRss[]> {
  if (process.platform === 'linux') {
    const rows: ProcessRss[] = []
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name))
        continue
      try {
        const status = await readFile(`/proc/${name}/status`, 'utf8')
        const ppid = /^PPid:\s+(\d+)/m.exec(status)?.[1]
        const rss = /^VmRSS:\s+(\d+) kB/m.exec(status)?.[1]
        // status 里的 Name 是主线程的名字（Node 把它叫 MainThread），按命令行的第一项认
        const [command = ''] = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0')
        if (ppid !== undefined && rss !== undefined)
          rows.push({ pid: Number(name), ppid: Number(ppid), rss: Number(rss) * 1024, node: /(?:^|\/)node$/.test(command) })
      }
      catch {
        // 进程刚好退出了
      }
    }
    return rows
  }
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='])
  return stdout.trim().split('\n').map((line) => {
    const [pid = '0', ppid = '0', rss = '0', ...command] = line.trim().split(/\s+/)
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, node: /(?:^|\/)node$/.test(command.join(' ')) }
  })
}

/** 这个进程与它的直接子进程（Node 的）的 RSS（字节） */
async function treeRss(pid: number): Promise<{ readonly own: number, readonly children: readonly { readonly pid: number, readonly rss: number }[] }> {
  const table = await processTable()
  return {
    own: table.find(row => row.pid === pid)?.rss ?? 0,
    children: table.filter(row => row.ppid === pid && row.node).map(row => ({ pid: row.pid, rss: row.rss })),
  }
}

const UNITS: Readonly<Record<string, number>> = { K: 1024, M: MIB, G: 1024 * MIB }

/**
 * 一个进程独占的内存（字节）：RSS 里有与别的进程共用的页（Node 的可执行文件、共享库），各进程的 RSS 相加会重复计算。
 * Linux 取 smaps_rollup 的 Private_Clean 加 Private_Dirty；macOS 取 vmmap 的 Physical footprint
 */
async function privateMemory(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
      const kib = (field: string): number => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(rollup)?.[1] ?? Number.NaN)
      return (kib('Private_Clean') + kib('Private_Dirty')) * 1024
    }
    const { stdout } = await execFileAsync('vmmap', ['-summary', String(pid)])
    const [, amount = '', unit = ''] = /^Physical footprint:\s+([\d.]+)([KMG])/m.exec(stdout) ?? []
    return Number(amount) * (UNITS[unit] ?? Number.NaN)
  }
  catch {
    return undefined
  }
}

/**
 * 一个进程的内存的峰值（字节）：Linux 取 /proc 的 VmHWM（RSS 的峰值）；macOS 取 vmmap 的 Physical footprint (peak)
 * （macOS 拿不到别的进程 RSS 的峰值）
 */
async function peakMemory(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      return Number(/^VmHWM:\s+(\d+) kB/m.exec(status)?.[1] ?? Number.NaN) * 1024
    }
    const { stdout } = await execFileAsync('vmmap', ['-summary', String(pid)])
    const [, amount = '', unit = ''] = /^Physical footprint \(peak\):\s+([\d.]+)([KMG])/m.exec(stdout) ?? []
    return Number(amount) * (UNITS[unit] ?? Number.NaN)
  }
  catch {
    return undefined
  }
}

/** 容器（cgroup）里全部进程实际占的内存（字节）：Linux 的 cgroup v2 才有；容器的内存上限按它算 */
async function cgroupMemory(): Promise<number | undefined> {
  try {
    return Number((await readFile('/sys/fs/cgroup/memory.current', 'utf8')).trim())
  }
  catch {
    return undefined
  }
}

// ---- 形状：都不超过 5 MiB（解压之后的上限）----

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CATEGORIES = ['华东', '华南', '华北', '西南', '西北', '东北', '华中', '海外', '线上', '其他']

/**
 * 真实形状（与 M0 的 big-5m、P3 设计前的探索 A 相同的生成法）：一张表，20 列明细，两位小数的数值，每 10 行一个合计公式，
 * 表头加粗；资源是模板的 10 项（都为空）。按字节数生成到目标附近
 */
function realWorkbook(targetBytes: number): string {
  const random = seededRandom(20260924)
  const columns = 20
  const round2 = (value: number): number => Math.round(value * 100) / 100
  const header = ['编号', '名称', '类别', ...Array.from({ length: columns - 4 }, (_, index) => `指标${index + 1}`), '合计']
  const cellData: Record<number, Record<number, unknown>> = { 0: Object.fromEntries(header.map((v, c) => [c, { v, s: 'bold', t: 1 }])) }
  let bytes = 4_000
  let row = 1
  for (; ; row += 1) {
    const cells: Record<number, unknown> = { 0: { v: row, t: 2 }, 1: { v: `项目-${String(row).padStart(6, '0')}`, t: 1 }, 2: { v: CATEGORIES[Math.floor(random() * 10)], t: 1 } }
    for (let column = 3; column < columns - 1; column += 1)
      cells[column] = { v: round2(random() * 10_000), t: 2 }
    cells[columns - 1] = row % 10 === 0 ? { f: `=SUM(D${row + 1}:S${row + 1})`, v: round2(random() * 100_000), t: 2 } : { v: round2(random() * 10_000), t: 2 }
    const size = Buffer.byteLength(JSON.stringify(cells)) + String(row).length + 4
    if (bytes + size > targetBytes)
      break
    cellData[row] = cells
    bytes += size
  }
  const template = SHEET_TEMPLATE.sheets['sheet-1']
  return JSON.stringify({
    ...SHEET_TEMPLATE,
    id: UNIT_ID,
    styles: { bold: { bl: 1 } },
    sheets: { 'sheet-1': { ...template, name: '明细', rowCount: row + 100, cellData } },
  })
}

/** 外壳之外留给内容的字节数 */
const ROOM = SNAPSHOT_MAX_RAW_BYTES - 256

/** 不在任何规则上失败的外壳：额外的东西放在顶层的 a 里（结构不限制多出的键） */
function shell(extra: string, resources = '[]'): string {
  return `{"id":"${UNIT_ID}","sheetOrder":[],"sheets":{},"resources":${resources},"a":${extra}}`
}

function repeated(item: string, count: number): string {
  return `[${Array.from({ length: count }).fill(item).join(',')}]`
}

/** 逐个生成，直到再加一个就超过 room：用逗号连起来 */
function fill(make: (index: number) => string, room = ROOM): string {
  const parts: string[] = []
  let size = 2
  for (let index = 0; ; index += 1) {
    const part = make(index)
    if (size + part.length + 1 > room)
      break
    parts.push(part)
    size += part.length + 1
  }
  return parts.join(',')
}

/** 备注资源里放一个大对象（每行一个备注）：合法，资源的规则与规范化都要再解析它 */
function bigResource(): string {
  const notes: Record<number, unknown> = {}
  let size = 32
  for (let row = 0; ; row += 1) {
    const note = { 0: { note: `备注 ${row}`, width: 160, height: 72, id: `n${row}`, row, col: 0 } }
    // data 写进 JSON 字符串时引号要转义：按转义之后的 UTF-8 字节数算，加上行号的键
    const entry = Buffer.byteLength(JSON.stringify(JSON.stringify(note))) + String(row).length + 6
    if (size + entry > ROOM)
      break
    notes[row] = note
    size += entry
  }
  return shell('0', JSON.stringify([{ name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ 'sheet-1': notes }) }]))
}

/** 极深、每层一个新键的对象（{"0":{"1":{"2":…}}}）：解析时每层一个新的隐藏类 */
function deepDistinct(): string {
  const keys = fill(index => `{"${index.toString(36)}":`, ROOM - 8).split(',')
  return shell(`${keys.join('')}0${'}'.repeat(keys.length)}`)
}

interface Shape {
  readonly name: string
  readonly note: string
  readonly text: () => string
}

/** 只由 [ 与 ] 组成时最多能嵌套几层 */
const DEPTH_ROOM = Math.floor(ROOM / 2) - 16
/** 数量上限之内留一点余量（外壳本身的几个元素） */
const UNDER_ENTRIES = SNAPSHOT_MAX_ENTRIES - 64

const SHAPES: readonly Shape[] = [
  { name: 'real-1mib', note: '真实形状 1 MiB', text: () => realWorkbook(1 * MIB) },
  { name: 'real-5mib', note: '真实形状 5 MiB（约 61 万个元素）', text: () => realWorkbook(SNAPSHOT_MAX_RAW_BYTES) },
  { name: 'resource-big', note: '备注资源里一个约 5 MiB 的对象（合法）', text: bigResource },
  { name: 'many-keys', note: '一个约 60 万个键的对象', text: () => shell(`{${fill(index => `"${index.toString(36)}":0`)}}`) },
  { name: 'distinct-maps', note: '约 47 万个对象、每个一个新键（每个对象一个新的隐藏类）', text: () => shell(`[${fill(index => `{"${index.toString(36)}":0}`)}]`) },
  { name: 'empty-objects', note: `数量上限之内的空对象数组（${UNDER_ENTRIES} 个）`, text: () => shell(repeated('{}', UNDER_ENTRIES)) },
  { name: 'nested-arrays', note: '数量上限之内的 [[0],[0],…]', text: () => shell(repeated('[0]', Math.floor(UNDER_ENTRIES / 2))) },
  { name: 'empty-strings', note: '数量上限之内的空串数组', text: () => shell(repeated('""', UNDER_ENTRIES)) },
  { name: 'cjk-string', note: '一个约 170 万个汉字的字符串', text: () => shell(`"${'汉'.repeat(Math.floor(ROOM / 3))}"`) },
  { name: 'zeros', note: '约 260 万个 0（超过数量上限）', text: () => shell(repeated('0', Math.floor(ROOM / 2))) },
  { name: 'empty-objects-all', note: '约 175 万个空对象（超过数量上限）', text: () => shell(repeated('{}', Math.floor(ROOM / 3))) },
  { name: 'deep', note: '只有方括号、嵌套约 260 万层', text: () => shell(`${'['.repeat(DEPTH_ROOM)}${']'.repeat(DEPTH_ROOM)}`) },
  { name: 'deep-distinct', note: '嵌套约 75 万层、每层一个新键的对象', text: deepDistinct },
  { name: 'resource-deep', note: '资源 data 里嵌套约 260 万层', text: () => shell('0', JSON.stringify([{ name: 'SHEET_NOTE_PLUGIN', data: `${'['.repeat(DEPTH_ROOM - 64)}${']'.repeat(DEPTH_ROOM - 64)}` }])) },
  { name: 'resource-objects', note: '资源 data 里约 175 万个空对象', text: () => shell('0', JSON.stringify([{ name: 'SHEET_NOTE_PLUGIN', data: repeated('{}', Math.floor((ROOM - 200) / 3)) }])) },
]

function describe(outcome: InspectionOutcome | string): string {
  if (typeof outcome === 'string')
    return outcome
  return outcome.ok ? 'ok' : outcome.rule
}

function failed(error: unknown): string {
  return `error: ${error instanceof Error ? error.message : String(error)}`
}

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function bytesOf(shape: Shape): Buffer {
  const bytes = Buffer.from(shape.text(), 'utf8')
  if (bytes.byteLength > SNAPSHOT_MAX_RAW_BYTES)
    throw new Error(`${shape.name} 超过 5 MiB：${bytes.byteLength}`)
  return bytes
}

function shapeNamed(name: string | undefined): Shape {
  const shape = SHAPES.find(item => item.name === name)
  if (shape === undefined)
    throw new Error(`没有这个形状：${name}`)
  return shape
}

const only = args.only?.split(',')
const shapes = SHAPES.filter(shape => only === undefined || only.includes(shape.name))

type Inspector = InstanceType<InspectorModule['SnapshotInspector']>

/** 子进程池的子进程都起来、加载好 */
async function warmed(settings: SnapshotInspectionSettings = SETTINGS): Promise<Inspector> {
  const inspector = new SnapshotInspector(settings, logger)
  await Promise.all(Array.from({ length: settings.processes }, async () => inspector.inspect(Buffer.from('{}'), PROFILE)))
  return inspector
}

async function settle(): Promise<void> {
  gc()
  await sleep(300)
}

// ---- 单独的进程：在给定的堆上限下单独检查一份，打印结果与耗时 ----
if (args['child-shape'] !== undefined) {
  const bytes = bytesOf(shapeNamed(args['child-shape']))
  const inspector = await warmed({ ...SETTINGS, processes: 1, heapMb: Number(args['child-heap']), timeoutMs: 120_000 })
  const start = performance.now()
  const outcome = await inspector.inspect(bytes, PROFILE).then(describe, failed)
  write(`${outcome} ${(performance.now() - start).toFixed(0)}ms`)
  await inspector.onApplicationShutdown()
  process.exit(0)
}

// ---- 同时提交：子进程池与主进程对照 ----

interface RoundResult {
  readonly totalMs: number
  readonly taskMs: readonly number[]
  readonly outcomes: readonly string[]
  readonly loopDelayMaxMs: number
  readonly rssPeak: number
  readonly heapPeak: number
}

/** 一个场景的结果：开始之前主进程的 RSS（子进程池的子进程已经起来）、各轮、各轮之后每个子进程的峰值（见 peakMemory） */
interface ScenarioResult {
  readonly rssBefore: number
  readonly rounds: readonly RoundResult[]
  readonly childPeaks: readonly (number | undefined)[]
}

/** 一轮：同时提交 CONCURRENCY 份（子进程池），或者在主进程里一份接一份地检查（每份之间让出一次事件循环） */
async function round(bytes: Buffer, inspector: Inspector | undefined): Promise<RoundResult> {
  gc()
  let rssPeak = process.memoryUsage().rss
  let heapPeak = process.memoryUsage().heapUsed
  const sample = (): void => {
    const usage = process.memoryUsage()
    rssPeak = Math.max(rssPeak, usage.rss)
    heapPeak = Math.max(heapPeak, usage.heapUsed)
  }
  const sampler = setInterval(sample, 5)
  const delay = monitorEventLoopDelay({ resolution: 1 })
  delay.enable()
  const start = performance.now()
  const taskMs: number[] = []
  const outcomes: string[] = []
  if (inspector !== undefined) {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      const submitted = performance.now()
      const outcome = await inspector.inspect(bytes, PROFILE).then(describe, failed)
      taskMs.push(performance.now() - submitted)
      outcomes.push(outcome)
    }))
  }
  else {
    for (let index = 0; index < CONCURRENCY; index += 1) {
      const begun = performance.now()
      const outcome = inspectSnapshot(bytes, PROFILE)
      sample()
      taskMs.push(performance.now() - begun)
      outcomes.push(outcome.ok ? 'ok' : outcome.rule)
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const totalMs = performance.now() - start
  delay.disable()
  clearInterval(sampler)
  sample()
  return { totalMs, taskMs, outcomes, loopDelayMaxMs: delay.max / 1e6, rssPeak, heapPeak }
}

// ---- 单独的进程：一个场景（形状 × 方式），结果写成一行 JSON ----
if (args['child-scenario'] !== undefined) {
  const [name, mode] = args['child-scenario'].split(':')
  const bytes = bytesOf(shapeNamed(name))
  const inspector = mode === 'pool' ? await warmed() : undefined
  await settle()
  const rssBefore = process.memoryUsage().rss
  const rounds: RoundResult[] = []
  for (let index = 0; index < ROUNDS; index += 1)
    rounds.push(await round(bytes, inspector))
  const { children } = await treeRss(process.pid)
  const childPeaks = await Promise.all(children.map(async child => peakMemory(child.pid)))
  await inspector?.onApplicationShutdown()
  write(JSON.stringify({ rssBefore, rounds, childPeaks } satisfies ScenarioResult))
  process.exit(0)
}

// ---- 单独的进程：冷启动的耗时，空闲时每个子进程占多少 ----

/** 一个子进程的内存：RSS 与独占的部分（见 privateMemory） */
interface ChildMemory {
  readonly rss: number
  readonly private: number | undefined
}

async function childMemory(): Promise<readonly ChildMemory[]> {
  const { children } = await treeRss(process.pid)
  return Promise.all(children.map(async child => ({ rss: child.rss, private: await privateMemory(child.pid) })))
}

interface IdleResult {
  readonly coldStartMs: readonly number[]
  readonly parentBefore: number
  readonly parentAfter: number
  readonly children: readonly ChildMemory[]
  readonly cgroupBefore: number | undefined
  readonly cgroupAfter: number | undefined
}

if (args['child-idle'] === true) {
  // 冷启动：从没有子进程到检查完一份最小的快照（起子进程、加载入口与 contracts、检查）
  const coldStartMs: number[] = []
  for (let index = 0; index < 5; index += 1) {
    const inspector = new SnapshotInspector({ ...SETTINGS, processes: 1 }, logger)
    const start = performance.now()
    await inspector.inspect(Buffer.from('{}'), PROFILE)
    coldStartMs.push(performance.now() - start)
    await inspector.onApplicationShutdown()
  }
  await settle()
  await sleep(1_000)
  const parentBefore = process.memoryUsage().rss
  const cgroupBefore = await cgroupMemory()
  const inspector = await warmed()
  await settle()
  await sleep(1_000)
  const parentAfter = process.memoryUsage().rss
  const cgroupAfter = await cgroupMemory()
  const children = await childMemory()
  write(JSON.stringify({ coldStartMs, parentBefore, parentAfter, children, cgroupBefore, cgroupAfter } satisfies IdleResult))
  await inspector.onApplicationShutdown()
  process.exit(0)
}

// ---- 单独的进程：检查过一份 5 MiB 的真实快照之后，空闲的子进程的内存怎样回落 ----

interface RetentionResult {
  readonly idle: ChildMemory | undefined
  readonly samples: readonly { readonly seconds: number, readonly memory: ChildMemory | undefined }[]
}

if (args['child-retention'] === true) {
  const inspector = await warmed({ ...SETTINGS, processes: 1 })
  const [idle] = await childMemory()
  await inspector.inspect(bytesOf(shapeNamed('real-5mib')), PROFILE)
  const finished = performance.now()
  const samples: { readonly seconds: number, readonly memory: ChildMemory | undefined }[] = []
  for (const seconds of [0, 1, 5, 10, 20, 30, 45, (IDLE_PROCESS_TIMEOUT_MS / 1000) - 5]) {
    await sleep(Math.max(0, finished + seconds * 1000 - performance.now()))
    const [memory] = await childMemory()
    samples.push({ seconds, memory })
  }
  write(JSON.stringify({ idle, samples } satisfies RetentionResult))
  await inspector.onApplicationShutdown()
  process.exit(0)
}

/** 在单独的进程里跑，取它打印的最后一行 JSON；Linux 上同时从外面每 20 ms 读一次容器（cgroup）实际占的内存，记峰值 */
async function scenario<T>(extra: readonly string[]): Promise<{ readonly result: T, readonly cgroupPeak: number | undefined }> {
  const passThrough = ['--concurrency', String(CONCURRENCY), '--rounds', String(ROUNDS), '--processes', String(SETTINGS.processes), '--heap-mb', String(SETTINGS.heapMb)]
  const child = spawn(process.execPath, ['--expose-gc', SCRIPT, ...passThrough, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const state = { running: true }
  let cgroupPeak: number | undefined
  const sampling = (async () => {
    while (state.running) {
      const cgroup = await cgroupMemory()
      if (cgroup === undefined)
        return
      cgroupPeak = Math.max(cgroupPeak ?? 0, cgroup)
      await sleep(20)
    }
  })()
  const { code, signal } = await closed
  state.running = false
  await sampling
  if (code !== 0)
    throw new Error(`场景的进程失败（${String(code ?? signal)}）：${stderr.slice(-2_000)}`)
  return { result: JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as T, cgroupPeak }
}

function memoryOf(memory: ChildMemory | undefined): string {
  if (memory === undefined)
    return '（没有子进程）'
  return `RSS ${mib(memory.rss)} MiB（独占 ${memory.private === undefined ? '?' : mib(memory.private)} MiB）`
}

write(`# 快照检查的测量（${new Date().toISOString()}，Node ${process.version}，${process.platform}/${process.arch}）`)
write()
write(`子进程池：${SETTINGS.processes} 个子进程，每个子进程的堆上限 ${SETTINGS.heapMb} MiB，排队 ${SETTINGS.queue.maxWaiting} 个 / ${SETTINGS.queue.maxWaitMs} ms，`
  + `时限 ${SETTINGS.timeoutMs} ms，空闲 ${IDLE_PROCESS_TIMEOUT_MS} ms 之后结束；每轮同时提交 ${CONCURRENCY} 份，${ROUNDS} 轮；数量上限 ${SNAPSHOT_MAX_ENTRIES}`)

if (args['skip-heap-search'] !== true) {
  const heaps = args.heaps.split(',')
  write()
  write('## 单独检查一份：不同的堆上限下的结果与耗时')
  write()
  write('"子进程超限"是子进程的堆撞上上限、V8 中止了它，这份快照按 too-complex 拒绝；"**主进程中止**"是子进程池所在的进程也退出了（不应出现）。')
  write()
  write(`| 形状 | 说明 | 字节（MiB） | ${heaps.map(heap => `${heap} MiB`).join(' | ')} |`)
  write(`|---|---|---|${heaps.map(() => '---').join('|')}|`)
  for (const shape of shapes) {
    const cells = heaps.map((heap) => {
      const attempt = spawnSync(process.execPath, [SCRIPT, '--child-shape', shape.name, '--child-heap', heap], { encoding: 'utf8', timeout: 300_000 })
      if (attempt.signal !== null)
        return `**主进程中止**（${attempt.signal}）`
      return attempt.stdout.trim().replace('too-complex', '子进程超限') || `退出码 ${attempt.status}`
    })
    write(`| ${shape.name} | ${shape.note} | ${mib(bytesOf(shape).byteLength)} | ${cells.join(' | ')} |`)
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN
}

function summarize(outcomes: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const outcome of outcomes)
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  return [...counts].map(([outcome, count]) => (counts.size === 1 ? outcome : `${outcome}×${count}`)).join('、')
}

if (args['skip-idle'] !== true) {
  const { result: idle } = await scenario<IdleResult>(['--child-idle'])
  write()
  write('## 子进程的冷启动与空闲时的内存')
  write()
  write(`冷启动（从没有子进程到检查完一份最小的快照，5 次）：${idle.coldStartMs.map(ms => ms.toFixed(0)).join('、')} ms。`)
  write(`空闲时：起子进程之前主进程的 RSS ${mib(idle.parentBefore)} MiB，${idle.children.length} 个子进程加载好之后主进程 ${mib(idle.parentAfter)} MiB；`
    + `子进程各 ${idle.children.map(memoryOf).join('、')}。`
    + `RSS 里有与主进程共用的页（Node 的可执行文件与共享库），独占的部分 Linux 取 smaps_rollup 的 Private_*，macOS 取 vmmap 的 Physical footprint`)
  if (idle.cgroupBefore !== undefined && idle.cgroupAfter !== undefined)
    write(`容器（cgroup）实际占的内存：起子进程之前 ${mib(idle.cgroupBefore)} MiB，之后 ${mib(idle.cgroupAfter)} MiB（每个子进程约 ${mib((idle.cgroupAfter - idle.cgroupBefore) / Math.max(1, idle.children.length))} MiB）`)
}

if (args.retention === true) {
  const { result } = await scenario<RetentionResult>(['--child-retention'])
  write()
  write('## 检查过一份 5 MiB 的真实快照之后，空闲的子进程的内存')
  write()
  write(`检查之前（加载好、空闲）${memoryOf(result.idle)}；检查之后：${result.samples.map(sample => `${sample.seconds} 秒 ${memoryOf(sample.memory)}`).join('，')}`)
}

if (args['skip-concurrency'] !== true) {
  const linux = process.platform === 'linux'
  write()
  write('## 同时提交：子进程池与主进程对照（每个场景一个进程）')
  write()
  const peakNote = linux ? 'RSS 的峰值（VmHWM）' : 'vmmap 的 Physical footprint (peak)（macOS 拿不到别的进程 RSS 的峰值）'
  const cgroupNote = linux ? '容器实际占的内存（cgroup）每个页只算一次，含这个测量脚本自己（约 50 MiB）。' : ''
  write(`子进程的峰值：${peakNote}；合计是主进程 RSS 的峰值加子进程的峰值之和，各自的峰值未必同时出现，是上界；`
    + `RSS 里共用的页（Node 的可执行文件与共享库）每个进程各算一遍。${cgroupNote}`)
  write()
  write(`| 形状 | 方式 | 结果 | 每轮总耗时（ms） | 每份耗时 p50 / 最大（ms，子进程池含排队） | 事件循环延迟的峰值（ms） | 主进程 RSS：开始时 → 峰值（MiB） | 子进程的峰值（MiB） | 合计（MiB） |${linux ? ' 容器实际占的内存的峰值（MiB） |' : ''} 主进程堆的峰值（MiB） |`)
  write(`|---|---|---|---|---|---|---|---|---|${linux ? '---|' : ''}---|`)
  for (const shape of shapes) {
    for (const mode of ['pool', 'main'] as const) {
      const { result: { rssBefore, rounds, childPeaks }, cgroupPeak } = await scenario<ScenarioResult>(['--child-scenario', `${shape.name}:${mode}`])
      const tasks = rounds.flatMap(result => result.taskMs)
      const worst = (pick: (result: RoundResult) => number): number => Math.max(...rounds.map(pick))
      const parentPeak = worst(result => result.rssPeak)
      const peaks = childPeaks.map(peak => peak ?? Number.NaN)
      write(`| ${shape.name} | ${mode === 'pool' ? `子进程池（${SETTINGS.processes} 个）` : '主进程'} | ${summarize(rounds.flatMap(result => result.outcomes))} | `
        + `${percentile(rounds.map(result => result.totalMs), 0.5).toFixed(0)} | ${percentile(tasks, 0.5).toFixed(0)} / ${Math.max(...tasks).toFixed(0)} | `
        + `${worst(result => result.loopDelayMaxMs).toFixed(1)} | ${mib(rssBefore)} → ${mib(parentPeak)} | ${peaks.length === 0 ? '—' : peaks.map(mib).join('、')} | ${mib(parentPeak + sum(peaks))} |`
        + `${linux ? ` ${cgroupPeak === undefined ? '?' : mib(cgroupPeak)} |` : ''} ${mib(worst(result => result.heapPeak))} |`)
    }
  }
}

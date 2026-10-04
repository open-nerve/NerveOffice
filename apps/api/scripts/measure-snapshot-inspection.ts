// DEF-018 的测量（M3-P3 设计 §3.3；不进 CI）：快照检查放进工作线程池之后，内存与事件循环怎样。
// 对构建出来的后端（apps/api/dist）的 SnapshotInspector 提交 5 MiB 以内的真实形状快照与几种恶意形状：
// 1. 每种形状在不同的堆上限（resourceLimits.maxOldGenerationSizeMb）下单独检查一份：检查得完（结果与耗时）、线程超限被结束
//    （too-complex），还是整个进程中止——V8 在内置函数（JSON.parse 建对象、Object.keys 等）里撞上上限时，Node 结束不了线程，
//    直接中止进程（FATAL ERROR: Reached heap limit）。每个组合在单独的子进程里跑，中止不影响测量；
// 2. 每种形状同时提交几份（默认 8 份，线程池用配置的默认值），记每份的耗时（提交到拿到结果，含排队）、进程 RSS 的峰值、
//    主线程堆的峰值、事件循环延迟的峰值；同样的几份在主线程里直接检查（inspectSnapshot，两份之间让出一次事件循环）对照。
//    每个场景（形状 × 方式）一个子进程：RSS 不会立刻还给系统，同一个进程里前面的场景会抬高后面的。
// 运行（仓库根目录，先构建后端）：
//   pnpm --filter "@nerve-office/api..." run build && node --expose-gc apps/api/scripts/measure-snapshot-inspection.ts
// 在生产镜像里跑（Linux、镜像里的构建产物；镜像按 deploy/Dockerfile 构建）：
//   docker run --rm -v "$PWD/apps/api/scripts:/app/apps/api/scripts:ro" --entrypoint node <镜像> --expose-gc scripts/measure-snapshot-inspection.ts
// 可选参数：--concurrency <n>（同时提交几份，默认 8）、--rounds <n>（每种形状几轮，默认 3）、--threads <n>、--heap-mb <n>（默认取配置的默认值）、
// --only <形状,…>、--heaps <MiB,…>（堆上限的候选）、--skip-heap-search、--skip-concurrency。结果是 Markdown 的表，打印到标准输出
import type { DocumentProfile } from '@nerve-office/contracts'
import type { InspectionOutcome, SnapshotInspectionSettings } from '../src/modules/documents/snapshot-inspector.ts'
import type { AppLogger } from '../src/modules/logging/index.ts'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SHEET_TEMPLATE, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'

type InspectorModule = typeof import('../src/modules/documents/snapshot-inspector.ts')
type InspectionModule = typeof import('../src/modules/documents/snapshot-inspection.ts')
type ChecksModule = typeof import('../src/modules/documents/snapshot-checks.ts')
type ConfigModule = typeof import('../src/modules/config/config.ts')

/**
 * 构建产物里的模块：测的是构建出来的后端（工作线程的入口是 .js，contracts 解析到它的构建产物）。类型取源码里的同一个模块
 */
async function built<Module>(path: string): Promise<Module> {
  // eslint-disable-next-line no-restricted-syntax -- 测的是构建产物（dist 里没有类型声明，不能静态引用）；这个脚本不进产物，不在任何模块的边界之内
  return await import(new URL(`../dist/${path}`, import.meta.url).href) as Module
}

const { SnapshotInspector } = await built<InspectorModule>('modules/documents/snapshot-inspector.js')
const { inspectSnapshot } = await built<InspectionModule>('modules/documents/snapshot-inspection.js')
const { SNAPSHOT_MAX_ENTRIES } = await built<ChecksModule>('modules/documents/snapshot-checks.js')
const { loadConfig } = await built<ConfigModule>('modules/config/config.js')

const { values: args } = parseArgs({
  options: {
    'concurrency': { type: 'string', default: '8' },
    'rounds': { type: 'string', default: '3' },
    'threads': { type: 'string' },
    'heap-mb': { type: 'string' },
    'only': { type: 'string' },
    'heaps': { type: 'string', default: '64,96,128,160,192,256,384,512' },
    'skip-heap-search': { type: 'boolean', default: false },
    'skip-concurrency': { type: 'boolean', default: false },
    // 子进程：单独检查一份（堆上限的搜索用）、一个同时提交的场景（形状:pool 或 形状:main）、空闲的线程
    'child-shape': { type: 'string' },
    'child-heap': { type: 'string' },
    'child-scenario': { type: 'string' },
    'child-idle': { type: 'boolean', default: false },
  },
})

const DEFAULTS = loadConfig({ NERVE_DATABASE_URL: 'postgres://measure@127.0.0.1/measure', NERVE_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }).snapshotInspection
const SETTINGS: SnapshotInspectionSettings = {
  ...DEFAULTS,
  threads: args.threads === undefined ? DEFAULTS.threads : Number(args.threads),
  heapMb: args['heap-mb'] === undefined ? DEFAULTS.heapMb : Number(args['heap-mb']),
}
const CONCURRENCY = Number(args.concurrency)
const ROUNDS = Number(args.rounds)
const PROFILE: DocumentProfile = 'sheet@1'
const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const MIB = 1024 * 1024

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

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1)
}

function bytesOf(shape: Shape): Buffer {
  const bytes = Buffer.from(shape.text(), 'utf8')
  if (bytes.byteLength > SNAPSHOT_MAX_RAW_BYTES)
    throw new Error(`${shape.name} 超过 5 MiB：${bytes.byteLength}`)
  return bytes
}

const only = args.only?.split(',')
const shapes = SHAPES.filter(shape => only === undefined || only.includes(shape.name))

// ---- 子进程：在给定的堆上限下单独检查一份，打印结果与耗时 ----
if (args['child-shape'] !== undefined) {
  const shape = SHAPES.find(item => item.name === args['child-shape'])
  if (shape === undefined)
    throw new Error(`没有这个形状：${args['child-shape']}`)
  const bytes = bytesOf(shape)
  const inspector = new SnapshotInspector({ ...SETTINGS, threads: 1, heapMb: Number(args['child-heap']), timeoutMs: 120_000 }, logger)
  // 先让线程加载好，耗时只算检查本身
  await inspector.inspect(Buffer.from('{}'), PROFILE).catch(() => undefined)
  const start = performance.now()
  const outcome = await inspector.inspect(bytes, PROFILE).then(describe, (error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
  write(`${outcome} ${(performance.now() - start).toFixed(0)}ms`)
  await inspector.onApplicationShutdown()
  process.exit(0)
}

// ---- 同时提交：线程池与主线程对照（每个场景一个子进程：RSS 不会还给系统，同一个进程里前面的场景会抬高后面的） ----

interface RoundResult {
  readonly totalMs: number
  readonly taskMs: readonly number[]
  readonly outcomes: readonly string[]
  readonly loopDelayMaxMs: number
  readonly rssPeak: number
  readonly heapPeak: number
}

/** 一个场景的结果：开始之前的 RSS（线程池的线程已经建好）与各轮 */
interface ScenarioResult {
  readonly rssBefore: number
  readonly rounds: readonly RoundResult[]
}

type Inspector = InstanceType<InspectorModule['SnapshotInspector']>

/** 一轮：同时提交 CONCURRENCY 份（线程池），或者在主线程里一份接一份地检查（每份之间让出一次事件循环） */
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
      const outcome = await inspector.inspect(bytes, PROFILE).then(describe, (error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
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

/** 线程池的线程都建起来、加载好 */
async function warmed(): Promise<Inspector> {
  const inspector = new SnapshotInspector(SETTINGS, logger)
  await Promise.all(Array.from({ length: SETTINGS.threads }, async () => inspector.inspect(Buffer.from('{}'), PROFILE)))
  return inspector
}

async function settle(): Promise<void> {
  gc()
  await new Promise(resolve => setTimeout(resolve, 300))
}

// ---- 子进程：一个场景（形状 × 方式），结果写成一行 JSON ----
if (args['child-scenario'] !== undefined) {
  const [name, mode] = args['child-scenario'].split(':')
  const shape = SHAPES.find(item => item.name === name)
  if (shape === undefined)
    throw new Error(`没有这个形状：${name}`)
  const bytes = bytesOf(shape)
  const inspector = mode === 'pool' ? await warmed() : undefined
  await settle()
  const rssBefore = process.memoryUsage().rss
  const rounds: RoundResult[] = []
  for (let index = 0; index < ROUNDS; index += 1)
    rounds.push(await round(bytes, inspector))
  await inspector?.onApplicationShutdown()
  write(JSON.stringify({ rssBefore, rounds } satisfies ScenarioResult))
  process.exit(0)
}

// ---- 子进程：空闲时每个线程占多少 ----
if (args['child-idle'] === true) {
  await settle()
  const before = process.memoryUsage().rss
  const inspector = await warmed()
  await settle()
  const after = process.memoryUsage().rss
  write(JSON.stringify({ before, after, threads: inspector.liveThreads }))
  await inspector.onApplicationShutdown()
  process.exit(0)
}

write(`# 快照检查的测量（${new Date().toISOString()}，Node ${process.version}，${process.platform}/${process.arch}）`)
write()
write(`线程池：${SETTINGS.threads} 个线程，每个线程的堆上限 ${SETTINGS.heapMb} MiB，排队 ${SETTINGS.queue.maxWaiting} 个 / ${SETTINGS.queue.maxWaitMs} ms，`
  + `时限 ${SETTINGS.timeoutMs} ms；每轮同时提交 ${CONCURRENCY} 份，${ROUNDS} 轮；数量上限 ${SNAPSHOT_MAX_ENTRIES}`)

if (args['skip-heap-search'] !== true) {
  const heaps = args.heaps.split(',')
  write()
  write('## 单独检查一份：不同的堆上限下的结果与耗时')
  write()
  write('"线程超限"是线程被结束、这份快照按 too-complex 拒绝；"**进程中止**"是 V8 在内置函数里撞上上限、整个进程退出（SIGABRT）。')
  write()
  write(`| 形状 | 说明 | 字节（MiB） | ${heaps.map(heap => `${heap} MiB`).join(' | ')} |`)
  write(`|---|---|---|${heaps.map(() => '---').join('|')}|`)
  const script = fileURLToPath(import.meta.url)
  for (const shape of shapes) {
    const cells = heaps.map((heap) => {
      const attempt = spawnSync(process.execPath, [script, '--child-shape', shape.name, '--child-heap', heap], { encoding: 'utf8', timeout: 300_000 })
      if (attempt.signal === 'SIGABRT')
        return '**进程中止**'
      if (attempt.signal !== null)
        return `信号 ${attempt.signal}`
      return attempt.stdout.trim().replace('too-complex', '线程超限') || `退出码 ${attempt.status}`
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

/** 在子进程里跑，取它打印的那一行 JSON */
function child<T>(extra: readonly string[]): T {
  const passThrough = ['--concurrency', String(CONCURRENCY), '--rounds', String(ROUNDS), '--threads', String(SETTINGS.threads), '--heap-mb', String(SETTINGS.heapMb)]
  const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...passThrough, ...extra], { encoding: 'utf8', timeout: 600_000 })
  if (result.status !== 0)
    throw new Error(`子进程失败（${String(result.status ?? result.signal)}）：${result.stderr.slice(-2_000)}`)
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as T
}

if (args['skip-concurrency'] !== true) {
  const idle = child<{ before: number, after: number, threads: number }>(['--child-idle'])
  write()
  write(`空闲的线程：建线程池之前进程的 RSS ${mib(idle.before)} MiB，${idle.threads} 个线程加载好之后 ${mib(idle.after)} MiB（每个线程约 ${mib((idle.after - idle.before) / Math.max(1, idle.threads))} MiB）`)
  write()
  write('## 同时提交：线程池与主线程对照（每个场景一个子进程）')
  write()
  write('| 形状 | 方式 | 结果 | 每轮总耗时（ms） | 每份耗时 p50 / 最大（ms，线程池含排队） | 事件循环延迟的峰值（ms） | RSS：开始时 → 峰值（MiB） | 主线程堆的峰值（MiB） |')
  write('|---|---|---|---|---|---|---|---|')
  for (const shape of shapes) {
    for (const mode of ['pool', 'main'] as const) {
      const { rssBefore, rounds } = child<ScenarioResult>(['--child-scenario', `${shape.name}:${mode}`])
      const tasks = rounds.flatMap(result => result.taskMs)
      const worst = (pick: (result: RoundResult) => number): number => Math.max(...rounds.map(pick))
      write(`| ${shape.name} | ${mode === 'pool' ? `线程池（${SETTINGS.threads} 个）` : '主线程'} | ${summarize(rounds.flatMap(result => result.outcomes))} | `
        + `${percentile(rounds.map(result => result.totalMs), 0.5).toFixed(0)} | ${percentile(tasks, 0.5).toFixed(0)} / ${Math.max(...tasks).toFixed(0)} | `
        + `${worst(result => result.loopDelayMaxMs).toFixed(1)} | ${mib(rssBefore)} → ${mib(worst(result => result.rssPeak))} | ${mib(worst(result => result.heapPeak))} |`)
    }
  }
}

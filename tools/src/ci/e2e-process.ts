// 只供 Linux CI 的 E2E 分片使用。只记录 PID、内核启动身份与随机运行标记，绝不记录命令行或环境。
// 浏览器/API 会另起进程组；serve.ts 的 CI 预加载设施在 fork 时保留标记，组/后代跟踪只作为补充。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

export const OWNER_VARIABLE = 'NERVE_CI_E2E_OWNER'
export const CI_BUDGETS = { runMs: 90 * 60_000, cleanupMs: 15 * 60_000, forceMs: 60_000, pollMs: 250 }
const budgetsSchema = z.object({ runMs: z.number().positive(), cleanupMs: z.number().positive(), forceMs: z.number().positive(), pollMs: z.number().positive() })
const identitySchema = z.object({ pid: z.number().int().positive(), start: z.string().regex(/^\d+$/), uid: z.number().int().nonnegative(), group: z.number().int().positive() })
const ownerSchema = z.object({ version: z.literal(1), token: z.uuid(), root: z.string(), uid: z.number().int().nonnegative(), budgets: budgetsSchema })
const runtimeSchema = z.object({ startedAt: z.number(), supervisor: identitySchema, leader: identitySchema.optional(), owned: z.array(identitySchema) })
const stopSchema = z.object({ at: z.number(), reason: z.enum(['deadline', 'signal', 'recovery']) })
const resultSchema = z.object({ exitCode: z.number().int(), stopped: z.boolean(), forced: z.boolean(), quiescent: z.boolean() })
const quiescenceSchema = z.object({ quiescent: z.literal(true), forced: z.boolean() })
type Identity = z.infer<typeof identitySchema>
type Owner = z.infer<typeof ownerSchema>
type Runtime = z.infer<typeof runtimeSchema>
type Stop = z.infer<typeof stopSchema>
interface ProcessRow extends Identity { parent: number, state: string }
export interface RunResult { exitCode: number, stopped: boolean, forced: boolean, quiescent: boolean }

function linux(): number {
  if (process.platform !== 'linux' || process.getuid === undefined)
    throw new Error('CI E2E 进程监督只支持 Linux /proc；本机与容器入口不使用此工具')
  return process.getuid()
}

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')
}

function writeJson(directory: string, name: string, value: unknown): void {
  const temporary = join(directory, `${name}.${randomUUID()}.partial`)
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, join(directory, name))
}

function readJson(directory: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown
  }
  catch (error) {
    if (absent(error))
      return undefined
    // 不转发文件正文或底层异常；运行目录不存放凭据，错误输出也不回显外部内容。
    throw new Error(`无法读取 CI 运行记录 ${name}`)
  }
}

export function prepareRun(directory: string, root: string, budgets = CI_BUDGETS): void {
  const uid = linux()
  if (!isAbsolute(directory))
    throw new Error('CI 运行目录必须是绝对路径')
  // 独占创建；已有运行不得覆盖，包括另一 worktree 或上次重试留下的证据。
  mkdirSync(directory, { mode: 0o700 })
  const owner: Owner = { version: 1, token: randomUUID(), root: realpathSync(root), uid, budgets: budgetsSchema.parse(budgets) }
  writeFileSync(join(directory, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 })
}

function readOwner(directory: string, root: string): Owner {
  const uid = linux()
  const directoryStat = lstatSync(directory)
  const ownerStat = lstatSync(join(directory, 'owner.json'))
  if (!directoryStat.isDirectory() || directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0
    || !ownerStat.isFile() || ownerStat.uid !== uid || (ownerStat.mode & 0o077) !== 0) {
    throw new Error('CI 运行目录不是本用户独占的普通目录/记录')
  }
  const owner = ownerSchema.parse(readJson(directory, 'owner.json'))
  if (owner.root !== realpathSync(root) || owner.uid !== uid)
    throw new Error('CI 运行记录不属于当前 worktree/用户')
  return owner
}

/** /proc/stat 的 comm 可以含空格和括号；starttime 是内核启动 tick，不用秒级墙钟猜 PID 复用。 */
export function parseProcessStat(text: string, uid: number): ProcessRow | undefined {
  const end = text.lastIndexOf(')')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const fields = text.slice(end + 2).trim().split(/\s+/)
  const group = Number(fields[2])
  // 内核线程不属于任何用户进程组，不是本工具可授权发信号的对象。
  if (group === 0)
    return undefined
  const identity = identitySchema.parse({ pid, uid, group, start: fields[19] })
  if (end < 0 || !/^[A-Z]$/.test(fields[0] ?? '') || !Number.isSafeInteger(Number(fields[1])))
    throw new Error('Linux 进程身份格式无效')
  return { ...identity, parent: Number(fields[1]), state: fields[0] ?? '' }
}

function readProcess(pid: number, uid?: number): ProcessRow | undefined {
  try {
    const path = `/proc/${pid}/stat`
    const actualUid = statSync(path).uid
    // 先过滤用户，不能让宿主内核线程（PGID=0）的不可发信号身份干扰本轮扫描。
    if (uid !== undefined && actualUid !== uid)
      return undefined
    return parseProcessStat(readFileSync(path, 'utf8'), actualUid)
  }
  catch (error) {
    if (absent(error))
      return undefined
    throw new Error('无法读取 Linux 进程身份；不能宣告已无写入者')
  }
}

function same(a: Identity, b: Identity): boolean {
  return a.pid === b.pid && a.start === b.start && a.uid === b.uid && a.group === b.group
}

function live(row: ProcessRow): boolean {
  return row.state !== 'Z' && row.state !== 'X'
}

function identity(row: Identity): Identity {
  return { pid: row.pid, start: row.start, uid: row.uid, group: row.group }
}

function scanOwned(owner: Owner, known: readonly Identity[]): Identity[] {
  const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => readProcess(Number(name), owner.uid)).filter((row): row is ProcessRow => row !== undefined)
  const owned = new Map<number, ProcessRow>()
  for (const row of rows) {
    if (known.some(previous => same(previous, row))) {
      owned.set(row.pid, row)
      continue
    }
    try {
      const environment = readFileSync(`/proc/${row.pid}/environ`)
      if (environment.toString().split('\0').includes(`${OWNER_VARIABLE}=${owner.token}`))
        owned.set(row.pid, row)
    }
    catch (error) {
      // 非 dumpable 的同用户进程（例如系统代理）不可读；本轮已登记身份仍从上面的 known 识别。
      if (!absent(error) && !(error instanceof Error && 'code' in error && error.code === 'EACCES'))
        throw new Error('无法扫描本轮 CI 进程')
    }
  }
  // 每个根都由 detached spawn 创建独占组。只扩展仍与本轮内核身份相连的组/后代，
  // 不持久授权一个裸 PGID（旧组消失后 PGID 可以被其他运行复用）。
  let changed = true
  while (changed) {
    changed = false
    const groups = new Set([...owned.values()].map(row => row.group))
    for (const row of rows) {
      if (!owned.has(row.pid) && (owned.has(row.parent) || groups.has(row.group))) {
        owned.set(row.pid, row)
        changed = true
      }
    }
  }
  return [...owned.values()].filter(live).map(identity).sort((a, b) => a.pid - b.pid)
}

function signal(target: Identity | undefined, value: NodeJS.Signals): void {
  if (!target)
    return
  const current = readProcess(target.pid)
  if (!current || !live(current) || !same(current, target))
    return
  try {
    process.kill(target.pid, value)
  }
  catch (error) {
    if (!absent(error))
      throw new Error('无法停止本轮 CI 进程')
  }
}

/** 原子文件只记录一次停止，重复的外层 SIGINT/TERM/HUP 不缩短清理预算，也不重复 SIGINT。 */
function requestStop(directory: string, runtime: Runtime, owner: Owner, reason: Stop['reason']): Stop {
  const stop: Stop = { at: Math.min(Date.now(), runtime.startedAt + owner.budgets.runMs), reason }
  try {
    writeFileSync(join(directory, 'stop.json'), JSON.stringify(stop), { flag: 'wx', mode: 0o600 })
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error
  }
  return stopSchema.parse(readJson(directory, 'stop.json'))
}

function softStop(directory: string, leader: Identity | undefined): void {
  // 恢复收尾可能赶在 spawn 前；还没有实际 CLI 时不能先占用“已发一次”记录。
  if (leader === undefined)
    return
  try {
    writeFileSync(join(directory, 'soft-stop.json'), JSON.stringify({ at: Date.now(), leader }), { flag: 'wx', mode: 0o600 })
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return
    throw error
  }
  signal(leader, 'SIGINT')
}

export async function runOwnedCommand(directory: string, root: string, command: string, args: readonly string[], options: { cwd: string, env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  const owner = readOwner(directory, root)
  const supervisor = readProcess(process.pid)
  if (supervisor === undefined)
    throw new Error('无法登记 CI 监督进程身份')
  const runtime: Runtime = { startedAt: Date.now(), supervisor: identity(supervisor), owned: [] }
  // 重复执行必须在 spawn 前拒绝。
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify(runtime), { flag: 'wx', mode: 0o600 })
  let stopped = false
  const stop = () => {
    requestStop(directory, runtime, owner, 'signal')
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const name of signals)
    process.on(name, stop)
  let status: number | undefined
  let exitAt: number | undefined
  let forced = false
  let forceAt: number | undefined
  let emptyScans = 0
  try {
    const child = spawn(command, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env, [OWNER_VARIABLE]: owner.token }, detached: true, stdio: 'inherit' })
    child.once('error', () => {
      status = 1
      exitAt = Date.now()
    })
    child.once('exit', (code) => {
      status = code ?? 1
      exitAt = Date.now()
    })
    if (child.pid !== undefined)
      runtime.leader = readProcess(child.pid)
    writeJson(directory, 'runtime.json', runtime)
    for (;;) {
      const owned = scanOwned(owner, runtime.owned)
      if (JSON.stringify(owned) !== JSON.stringify(runtime.owned)) {
        runtime.owned = owned
        writeJson(directory, 'runtime.json', runtime)
      }
      let stopRecord = stopSchema.optional().parse(readJson(directory, 'stop.json'))
      if (!stopRecord && Date.now() >= runtime.startedAt + owner.budgets.runMs)
        stopRecord = requestStop(directory, runtime, owner, 'deadline')
      if (stopRecord) {
        stopped = true
        softStop(directory, runtime.leader)
      }
      emptyScans = status !== undefined && owned.length === 0 ? emptyScans + 1 : 0
      if (emptyScans >= 2) {
        const result = { exitCode: stopped || forced ? 1 : status ?? 1, stopped, forced, quiescent: true }
        writeJson(directory, 'result.json', result)
        return result
      }
      const cleanupAt = stopRecord?.at ?? exitAt
      if (cleanupAt !== undefined && Date.now() >= cleanupAt + owner.budgets.cleanupMs) {
        forced = true
        forceAt ??= Date.now()
        for (const target of owned)
          signal(target, 'SIGKILL')
        if (Date.now() >= forceAt + owner.budgets.forceMs)
          throw new Error('强制停止后仍未确认本轮写入者退出；禁止归档')
      }
      await delay(owner.budgets.pollMs)
    }
  }
  finally {
    for (const name of signals)
      process.off(name, stop)
  }
}

/** 每次归档前运行；上一步被平台终止时也能用原运行身份恢复停止，而非直接读取活 profiles。 */
export async function settleRun(directory: string, root: string): Promise<{ quiescent: true, forced: boolean }> {
  const owner = readOwner(directory, root)
  let runtime = runtimeSchema.optional().parse(readJson(directory, 'runtime.json'))
  if (runtime === undefined)
    throw new Error('缺少本轮启动记录，无法排除尚在启动的监督器；禁止归档')
  let known = runtime.owned
  let forced = false
  let forceAt: number | undefined
  let emptyScans = 0
  for (;;) {
    runtime = runtimeSchema.optional().parse(readJson(directory, 'runtime.json')) ?? runtime
    const owned = scanOwned(owner, [...known, ...runtime.owned])
    known = owned
    const current = readProcess(runtime.supervisor.pid)
    const supervisorAlive = current !== undefined && live(current) && same(current, runtime.supervisor)
    emptyScans = owned.length === 0 && !supervisorAlive ? emptyScans + 1 : 0
    if (emptyScans >= 2) {
      const result = { quiescent: true as const, forced }
      writeJson(directory, 'quiescence.json', result)
      return result
    }
    // 正常退出后的两次空扫描只作确认，不制造“已请求停止”的恢复记录。
    if (emptyScans > 0) {
      await delay(owner.budgets.pollMs)
      continue
    }
    const stop = requestStop(directory, runtime, owner, 'recovery')
    softStop(directory, runtime.leader)
    if (Date.now() >= stop.at + owner.budgets.cleanupMs) {
      forced = true
      forceAt ??= Date.now()
      for (const target of [...owned, runtime.supervisor])
        signal(target, 'SIGKILL')
      if (Date.now() >= forceAt + owner.budgets.forceMs)
        throw new Error('CI 恢复停止未能确认全部写入者退出；禁止归档')
    }
    await delay(owner.budgets.pollMs)
  }
}

/** 即使停止核验失败，也只上传一份独立静态快照，不能让上传器遍历仍在变化的运行目录。 */
export function snapshotDiagnostics(directory: string, root: string): string {
  const owner = readOwner(directory, root)
  const destination = `${directory}-diagnostics`
  mkdirSync(destination, { mode: 0o700 })
  const snapshot: Record<string, unknown> = { capturedAt: Date.now(), snapshotOnly: true, owner }
  const unavailable: string[] = []
  for (const [name, schema] of [
    ['runtime.json', runtimeSchema],
    ['stop.json', stopSchema],
    ['soft-stop.json', z.object({ at: z.number(), leader: identitySchema.optional() })],
    ['result.json', resultSchema],
    ['quiescence.json', quiescenceSchema],
  ] as const) {
    try {
      const value = readJson(directory, name)
      if (value === undefined && (name === 'stop.json' || name === 'soft-stop.json'))
        continue
      snapshot[name] = schema.parse(value)
    }
    catch { unavailable.push(name) }
  }
  snapshot.unavailable = unavailable
  writeJson(destination, 'snapshot.json', snapshot)
  return destination
}

// 崩溃工具（./browser-crash.ts）认进程的部分（M4-P1 设计 §3.7）：读进程表（Linux 读 /proc，macOS 读 ps）、认出这次启动的全部进程、按角色分类、
// 核对结束之后还活着的。不碰进程的部分是纯函数，单元测试覆盖（./browser-processes.test.ts）；读进程表与打开的文件的几个函数在最后。
//
// 怎样认——只从 Playwright 这次起的根往下认，绝不按名字模糊匹配：chrome 项目的可执行文件就是需求方自己在用的 Google Chrome，系统的 WebKit
// 与真实 Safari 的进程也一律不碰；名字只用来给已经认出来的进程分角色。
// - 根：测试的工作进程的子进程，命令行带 --user-data-dir=<资料目录>。Playwright 以 detached 起浏览器，根是新的进程组（与会话）的头；
//   Chromium 系的根是浏览器本身，WebKit 的根是启动脚本 pw_run.sh（bash，不 exec：macOS 起 Playwright.app，Linux 起 MiniBrowser）；
// - 进程树（按 ppid 往下）∪ 进程组（pgid 等于根）∪ 命令行里提到资料目录的（例如守护进程化的 crashpad）；
// - macOS 上的 WebKit：XPC 服务（WebContent、Networking、GPU）由 launchd 拉起（父进程是 1、各自一个进程组），不在树里。Networking 承载
//   IndexedDB 与 Cookie，按它打开着资料目录里的文件认（调用方只对安装目录下的 XPC 跑 lsof；这里另外只认安装目录下的 XPC，Spotlight 一类
//   打开着文件的系统进程不会被认进来）；WebContent 与 GPU 只能按安装目录与启动时刻（不早于启动之前 2 秒）认，前提是机器上只有这一个
//   Playwright WebKit 实例（同一个安装目录的 UI 进程只有这次的）——有别的实例时记成问题、不按这条认，由调用方报错说明，不静默跳过。
// Linux（CI 是 ubuntu-24.04）上三个浏览器的进程都在根的进程树里（读 /proc，不依赖 ps 的列宽与区域设置）。
import type { Cookie } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import process from 'node:process'

export type CrashPlatform = 'darwin' | 'linux'
export type BrowserFamily = 'chromium' | 'webkit'

/** 进程表的一行 */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  /** 状态的第一个字母：R、S、T（停住）、Z（僵尸）、X（已死）……；Z 与 X 算已经退出（isExited） */
  readonly state: string
  /** 启动时刻（毫秒，Date.now 的口径）：Linux 由开机时刻与时钟滴答推出；macOS 由读的时刻减去 etime 推出，精度 1 秒 */
  readonly startedAt: number
  /** 完整的命令行（参数以空格连接） */
  readonly command: string
}

/** 已经退出：僵尸（Z，等父进程回收）或已死（X，Linux 上一闪而过） */
export function isExited(row: Pick<ProcessRow, 'state'>): boolean {
  return row.state === 'Z' || row.state === 'X'
}

/** /proc/<pid>/stat 的一行：comm 可能含空格与括号，从最后一个右括号之后切；starttime 是第 22 项（开机以来的时钟滴答） */
export function parseProcStat(stat: string): { pid: number, comm: string, state: string, ppid: number, pgid: number, startTicks: number } | undefined {
  const open = stat.indexOf(' (')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close < open)
    return undefined
  const pid = Number(stat.slice(0, open))
  const fields = stat.slice(close + 1).trim().split(/\s+/)
  const [state, ppid, pgid] = [fields[0], Number(fields[1]), Number(fields[2])]
  const startTicks = Number(fields[19])
  if (!Number.isInteger(pid) || state === undefined || state === '' || !Number.isInteger(ppid) || !Number.isInteger(pgid) || fields[19] === undefined || !Number.isInteger(startTicks))
    return undefined
  return { pid, comm: stat.slice(open + 2, close), state: state.slice(0, 1), ppid, pgid, startTicks }
}

/** /proc/stat 里的开机时刻（btime，秒） */
export function bootTimeSecondsIn(procStat: string): number | undefined {
  const match = /^btime (\d+)$/m.exec(procStat)
  return match === null ? undefined : Number(match[1])
}

/** Linux 的一个进程：stat 与 cmdline（NUL 分隔）；命令行是空的（僵尸、内核线程）时同 ps 写成 [comm] */
export function procRow(stat: string, cmdline: string, bootTimeMs: number, clockTicks: number): ProcessRow | undefined {
  const parsed = parseProcStat(stat)
  if (parsed === undefined)
    return undefined
  const args = cmdline.split('\0').filter(arg => arg !== '')
  return {
    pid: parsed.pid,
    ppid: parsed.ppid,
    pgid: parsed.pgid,
    state: parsed.state,
    startedAt: bootTimeMs + parsed.startTicks * 1000 / clockTicks,
    command: args.length === 0 ? `[${parsed.comm}]` : args.join(' '),
  }
}

/** ps 的 etime（[[dd-]hh:]mm:ss，时、分、秒都是两位）换成毫秒 */
export function elapsedMs(etime: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d{2}):)?(\d{2}):(\d{2})$/.exec(etime)
  if (match === null)
    return undefined
  const [, days, hours, minutes, seconds] = match
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

/** macOS：ps -axww -o pid=,ppid=,pgid=,stat=,etime=,command= 的输出（UTF-8 的区域设置），sampledAt 是读的时刻；认不出的行跳过 */
export function parsePsOutput(text: string, sampledAt: number): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s(.*)$/.exec(line)
    const elapsed = match === null ? undefined : elapsedMs(match[5] ?? '')
    if (match === null || elapsed === undefined)
      continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: (match[4] ?? '').slice(0, 1), startedAt: sampledAt - elapsed, command: (match[6] ?? '').trim() })
  }
  return rows
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 命令行里提到资料目录：--user-data-dir=<目录>、目录本身或目录下的文件。只认整段路径，前缀相同的别的目录不算 */
export function mentionsProfile(command: string, profileDir: string): boolean {
  return new RegExp(`(?:^|[\\s=])${escapeRegExp(profileDir)}(?=$|[\\s/])`).test(command)
}

/** lsof -F pn 的输出：打开着 dir 里的文件（或 dir 本身）的进程 */
export function pidsHoldingFilesIn(lsofOutput: string, dir: string): Set<number> {
  const holders = new Set<number>()
  let pid: number | undefined
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p'))
      pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined && isWithin(line.slice(1), dir))
      holders.add(pid)
  }
  return holders
}

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

/** 命令行带 --user-data-dir=<资料目录> 这一整段参数 */
function hasProfileFlag(command: string, profileDir: string): boolean {
  return new RegExp(`(?:^|\\s)--user-data-dir=${escapeRegExp(profileDir)}(?=$|\\s)`).test(command)
}

/** Playwright 这次起的根：测试的工作进程的子进程、命令行带 --user-data-dir=<资料目录>，恰好一个 */
export function launchRootIn(table: readonly ProcessRow[], workerPid: number, profileDir: string): { kind: 'found', pid: number } | { kind: 'missing' } | { kind: 'ambiguous', pids: number[] } {
  const roots = table.filter(row => row.ppid === workerPid && !isExited(row) && hasProfileFlag(row.command, profileDir))
  const [only] = roots
  if (only === undefined)
    return { kind: 'missing' }
  return roots.length === 1 ? { kind: 'found', pid: only.pid } : { kind: 'ambiguous', pids: roots.map(row => row.pid) }
}

/** 进程树：根与它一层层的子进程（按 ppid） */
export function descendantsOf(table: readonly ProcessRow[], rootPid: number): Set<number> {
  const tree = new Set([rootPid])
  const children = new Map<number, number[]>()
  for (const row of table)
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
  const queue = [rootPid]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (!tree.has(child)) {
        tree.add(child)
        queue.push(child)
      }
    }
  }
  return tree
}

/** 一次持久化的启动：认进程所需的全部事实 */
export interface InstanceSpec {
  readonly platform: CrashPlatform
  readonly family: BrowserFamily
  /** 测试的工作进程（根的父进程；它自己不算） */
  readonly workerPid: number
  readonly rootPid: number
  readonly profileDir: string
  /** 启动之前的时刻：macOS 上按启动时刻认 WebKit 的 XPC 服务 */
  readonly launchedAt: number
  /** Playwright WebKit 的安装目录（pw_run.sh 所在的目录，真实路径）；Chromium 系为 undefined */
  readonly webkitInstallDir: string | undefined
}

export type ProcessRole
  // Chromium 系
  = | 'browser' | 'renderer' | 'gpu' | 'network' | 'storage' | 'utility' | 'zygote' | 'crashpad'
  // WebKit（gpu 两边共用）
    | 'launcher' | 'ui' | 'web-content' | 'networking' | 'sandbox'
    | 'other'

/** 怎样认出来的：进程树、进程组、命令行提到资料目录、打开着资料目录里的文件（macOS 的 WebKit Networking）、安装目录与启动时刻（macOS 的 WebKit XPC） */
export type ProcessVia = 'tree' | 'group' | 'profile-arg' | 'profile-files' | 'webkit-xpc'

export interface InstanceProcess extends ProcessRow {
  readonly role: ProcessRole
  readonly via: ProcessVia
}

/** 安装目录下的 XPC 服务（macOS 的 Playwright WebKit：<安装目录>/com.apple.WebKit.<服务>.xpc/…） */
function isWebkitXpc(command: string, installDir: string): boolean {
  return command.startsWith(`${installDir}/com.apple.WebKit.`)
}

function isWebkitUi(command: string, installDir: string): boolean {
  return command.startsWith(`${installDir}/Playwright.app/Contents/MacOS/Playwright`)
}

/** Chromium 系的帮手进程按 --type 分角色；工具进程（utility）再按 --utility-sub-type 分 */
const CHROMIUM_TYPES: Readonly<Record<string, ProcessRole>> = {
  'renderer': 'renderer',
  'gpu-process': 'gpu',
  'zygote': 'zygote',
  'crashpad-handler': 'crashpad',
  'utility': 'utility',
}
const CHROMIUM_UTILITIES: Readonly<Record<string, ProcessRole>> = {
  'network.mojom.NetworkService': 'network',
  'storage.mojom.StorageService': 'storage',
}

function chromiumRole(row: ProcessRow, spec: InstanceSpec): ProcessRole {
  if (row.pid === spec.rootPid)
    return 'browser'
  if (/(?:^|\s)--monitor-self-annotation=ptype=crashpad-handler(?:\s|$)/.test(row.command))
    return 'crashpad'
  const role = CHROMIUM_TYPES[/(?:^|\s)--type=(\S+)/.exec(row.command)?.[1] ?? ''] ?? 'other'
  return role === 'utility' ? CHROMIUM_UTILITIES[/(?:^|\s)--utility-sub-type=(\S+)/.exec(row.command)?.[1] ?? ''] ?? 'utility' : role
}

/** WebKit 的 XPC 服务（macOS）与 WPE 的进程（Linux）按服务名分角色 */
const WEBKIT_SERVICES: readonly (readonly [RegExp, ProcessRole])[] = [
  [/\/com\.apple\.WebKit\.WebContent[^/\s]*$/, 'web-content'],
  [/\/com\.apple\.WebKit\.Networking[^/\s]*$/, 'networking'],
  [/\/com\.apple\.WebKit\.GPU[^/\s]*$/, 'gpu'],
  [/(?:^|\/)WPEWebProcess$/, 'web-content'],
  [/(?:^|\/)WPENetworkProcess$/, 'networking'],
  [/(?:^|\/)WPEGPUProcess$/, 'gpu'],
  [/(?:^|\/)MiniBrowser$/, 'ui'],
  [/(?:^|\/)(?:bwrap|xdg-dbus-proxy)$/, 'sandbox'],
]

function webkitRole(row: ProcessRow, spec: InstanceSpec): ProcessRole {
  if (row.pid === spec.rootPid)
    return 'launcher'
  if (spec.webkitInstallDir !== undefined && isWebkitUi(row.command, spec.webkitInstallDir))
    return 'ui'
  // macOS 的 XPC 服务的命令行就是可执行文件的路径；Linux 的可执行文件是第一段（WPE 的路径里没有空格）
  const executable = spec.platform === 'darwin' && spec.webkitInstallDir !== undefined && isWebkitXpc(row.command, spec.webkitInstallDir)
    ? row.command
    : row.command.split(' ')[0] ?? ''
  return WEBKIT_SERVICES.find(([pattern]) => pattern.test(executable))?.[1] ?? 'other'
}

/**
 * macOS 的 WebKit：安装目录下的 Networking（可能有别的实例的）。调用方只对它们跑 lsof，打开着这次资料目录里文件的就是这次启动的
 * （identifyInstance 的 profileHolders）；别的情况交回空列表
 */
export function webkitNetworkingCandidates(table: readonly ProcessRow[], spec: InstanceSpec): ProcessRow[] {
  const installDir = spec.webkitInstallDir
  if (spec.platform !== 'darwin' || spec.family !== 'webkit' || installDir === undefined)
    return []
  return table.filter(row => !isExited(row) && isWebkitXpc(row.command, installDir) && webkitRole(row, spec) === 'networking')
}

/** 给已经认出来的进程分角色（只用来断言与报告，不用来认进程） */
export function roleOf(row: ProcessRow, spec: InstanceSpec): ProcessRole {
  return spec.family === 'chromium' ? chromiumRole(row, spec) : webkitRole(row, spec)
}

/** 认出来的这次启动的进程，以及认不准的原因（非空时调用方报错，不按缺了的那部分继续） */
export interface Identified {
  readonly processes: readonly InstanceProcess[]
  readonly problems: readonly string[]
}

/** 安装目录与启动时刻认 XPC 时，启动时刻允许早于记下的启动时刻多少（macOS 的 etime 精度 1 秒，读表与启动之间也有间隔） */
export const XPC_START_SLACK_MS = 2_000

/**
 * 认出这次启动的全部进程：进程树 ∪ 进程组 ∪ 命令行提到资料目录 ∪（macOS 的 WebKit）打开着资料目录里文件的安装目录下的 XPC
 * ∪ 安装目录下、启动不早于 launchedAt − 2 秒的 XPC——这一条要求机器上没有别的 Playwright WebKit 实例，有就记进 problems、不按它认；
 * 再加上它们各自的子进程。profileHolders 是打开着资料目录里文件的进程（调用方只对安装目录下的 XPC 查）。
 * 不认的：两次 fork、另起会话、命令行里又不带资料目录的进程（不承载存储；Playwright 自己关浏览器时同样碰不到它们）
 */
export function identifyInstance(table: readonly ProcessRow[], spec: InstanceSpec, profileHolders: ReadonlySet<number>): Identified {
  const tree = descendantsOf(table, spec.rootPid)
  const installDir = spec.platform === 'darwin' && spec.family === 'webkit' ? spec.webkitInstallDir : undefined
  const others = installDir === undefined ? [] : table.filter(row => isWebkitUi(row.command, installDir) && !tree.has(row.pid) && !isExited(row))
  const problems = others.length === 0
    ? []
    : [`机器上另有 ${others.length} 个 Playwright WebKit 实例（UI 进程 ${others.map(row => row.pid).join('、')}）：XPC 服务（WebContent、GPU）由 launchd 拉起，分不清是谁的，只有这一个实例时才能按安装目录与启动时刻认。等别的 WebKit（别的工作进程、别的 worktree 的 E2E）跑完再跑`]
  const viaOf = (row: ProcessRow): ProcessVia | undefined => {
    if (row.pid === spec.workerPid)
      return undefined
    if (tree.has(row.pid))
      return 'tree'
    if (row.pgid === spec.rootPid)
      return 'group'
    if (mentionsProfile(row.command, spec.profileDir))
      return 'profile-arg'
    if (installDir === undefined || !isWebkitXpc(row.command, installDir))
      return undefined
    if (profileHolders.has(row.pid))
      return 'profile-files'
    return others.length === 0 && row.startedAt >= spec.launchedAt - XPC_START_SLACK_MS ? 'webkit-xpc' : undefined
  }
  const found = new Map<number, ProcessVia>()
  for (const row of table) {
    const via = viaOf(row)
    if (via !== undefined)
      found.set(row.pid, via)
  }
  // 认出来的进程的子进程也是这次启动的：例如 Linux 上 Chrome 系的 crashpad 两次 fork、另起会话（不在根的树里、不在进程组里，
  // 凭命令行里的资料目录认出来），它再起的监视进程不一定带资料目录
  for (const pid of [...found.keys()]) {
    for (const descendant of descendantsOf(table, pid)) {
      if (!found.has(descendant) && descendant !== spec.workerPid)
        found.set(descendant, 'tree')
    }
  }
  const processes: InstanceProcess[] = []
  for (const row of table) {
    const via = found.get(row.pid)
    if (via !== undefined)
      processes.push({ ...row, role: roleOf(row, spec), via })
  }
  return { processes, problems }
}

/**
 * 每个浏览器要求结束的角色（设计 §3.7 的断言）：Chromium 系有根、渲染进程、网络服务（IndexedDB 在浏览器进程或存储服务里，Cookie 在网络服务里）；
 * WebKit 有启动脚本、UI、网络进程（承载 IndexedDB 与 Cookie）、页面进程。GPU 进程不一定有，不要求
 */
const REQUIRED_ROLES: Readonly<Record<BrowserFamily, readonly ProcessRole[]>> = {
  chromium: ['browser', 'renderer', 'network'],
  webkit: ['launcher', 'ui', 'networking', 'web-content'],
}

/** 要求的角色里，没在这些进程里出现的 */
export function missingRoles(processes: readonly InstanceProcess[], spec: Pick<InstanceSpec, 'family'>): ProcessRole[] {
  return REQUIRED_ROLES[spec.family].filter(role => !processes.some(process => process.role === role))
}

/**
 * 同一个进程：进程号相同、启动时刻相差不超过 2 秒（macOS 由 etime 推出，精度 1 秒；Linux 是开机以来的时钟滴答，精确到 10 毫秒）；进程号被别的
 * 进程重新用了就不是。不比命令行：Linux 上正在退出的进程的命令行读出来是空的（内存已经释放，写成 [comm]），它还是那个进程
 */
function sameProcess(row: ProcessRow, known: ProcessRow): boolean {
  return row.pid === known.pid && Math.abs(row.startedAt - known.startedAt) <= 2_000
}

/** 结束之后还活着的：在新读的进程表里还是同一个进程、而且没有退出（僵尸、已死不算） */
export function stillAlive(table: readonly ProcessRow[], processes: readonly ProcessRow[]): ProcessRow[] {
  return table.filter(row => !isExited(row) && processes.some(known => sameProcess(row, known)))
}

/** 新读的进程表里这些进程的现状：same 是还是同一个进程，gone 是已经退出，replaced 是进程号被别的进程用了 */
export function processStatus(table: readonly ProcessRow[], known: ProcessRow): 'same' | 'gone' | 'replaced' {
  const row = table.find(candidate => candidate.pid === known.pid)
  if (row === undefined)
    return 'gone'
  return sameProcess(row, known) ? 'same' : 'replaced'
}

/** 承载存储的角色：冻住与结束时排在前面（WebKit 的网络进程；Chromium 的浏览器进程与存储服务） */
const STORAGE_ROLES: readonly ProcessRole[] = ['networking', 'browser', 'storage']

/** 冻住与结束的先后：承载存储的在前，其余按原来的顺序 */
export function signalOrder<T extends Pick<InstanceProcess, 'role'>>(processes: readonly T[]): T[] {
  return [...processes.filter(process => STORAGE_ROLES.includes(process.role)), ...processes.filter(process => !STORAGE_ROLES.includes(process.role))]
}

/**
 * 冻住（SIGSTOP）的目标，按先后：承载存储的在前；进程组里的进程一次冻住整个组（目标写成负的进程组号，同 kill(2)），组外的逐个
 * （macOS 的 WebKit XPC、两次 fork 的 crashpad）。准备时没认出组里的进程也冻住整个组：组里只可能是这次启动的进程
 */
export function freezeTargets(rootPid: number, planned: readonly InstanceProcess[]): number[] {
  const targets: number[] = []
  for (const item of signalOrder(planned)) {
    const target = item.pgid === rootPid ? -rootPid : item.pid
    if (!targets.includes(target))
      targets.push(target)
  }
  return targets.includes(-rootPid) ? targets : [...targets, -rootPid]
}

/** 结束（SIGKILL）的目标：先整个进程组（组里冻住之后才出现的也在内），再逐个（承载存储的在前）。都冻住了，先后不影响落盘的结果 */
export function killTargets(rootPid: number, processes: readonly InstanceProcess[]): number[] {
  return [-rootPid, ...signalOrder(processes).map(item => item.pid)]
}

/**
 * 冻住之后核对准备时认出的进程：还是同一个的照常结束（kept）；进程号被别的进程用了的（准备之后它退出、号又分给了别人）要立即恢复（SIGCONT），
 * 不能结束（replaced）；已经退出的两边都不放
 */
export function reconcilePlanned(table: readonly ProcessRow[], planned: readonly InstanceProcess[]): { readonly kept: InstanceProcess[], readonly replaced: InstanceProcess[] } {
  const kept: InstanceProcess[] = []
  const replaced: InstanceProcess[] = []
  for (const item of planned) {
    const status = processStatus(table, item)
    if (status === 'same')
      kept.push(item)
    else if (status === 'replaced')
      replaced.push(item)
  }
  return { kept, replaced }
}

/** 结束之后还在跑的这次启动的进程：在新读的进程表里再认一遍（根已经不在，靠进程组、命令行里的资料目录、macOS 的 WebKit XPC），去掉已经退出的 */
export function stillRunning(table: readonly ProcessRow[], spec: InstanceSpec): Identified {
  const { processes, problems } = identifyInstance(table, spec, new Set())
  return { processes: processes.filter(item => !isExited(item)), problems }
}

/** 浏览器重开之后留下的 Cookie（只记录、不断言）：名字、域、路径、过期时刻、是不是会话 Cookie，不带值（令牌不进报告与日志，规范 §4） */
export function cookieSummary(cookies: readonly Cookie[]): { name: string, domain: string, path: string, expires: number, session: boolean }[] {
  return cookies.map(({ name, domain, path, expires }) => ({ name, domain, path, expires, session: expires === -1 }))
}

// ---- 读进程表与打开的文件（碰系统，不做单元测试）----

/** 这台机器的平台：崩溃工具只支持 macOS 与 Linux */
export function currentPlatform(): CrashPlatform {
  if (process.platform === 'darwin' || process.platform === 'linux')
    return process.platform
  throw new Error(`崩溃工具只支持 macOS 与 Linux，这里是 ${process.platform}`)
}

let linuxClock: { readonly bootTimeMs: number, readonly clockTicks: number } | undefined

/** Linux 的开机时刻与每秒的时钟滴答（getconf CLK_TCK），读一次 */
function linuxClockInfo(): { readonly bootTimeMs: number, readonly clockTicks: number } {
  if (linuxClock === undefined) {
    const bootTime = bootTimeSecondsIn(readFileSync('/proc/stat', 'utf8'))
    const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
    if (bootTime === undefined || !Number.isInteger(clockTicks) || clockTicks <= 0)
      throw new Error('读不出开机时刻（/proc/stat 的 btime）或每秒的时钟滴答（getconf CLK_TCK）')
    linuxClock = { bootTimeMs: bootTime * 1000, clockTicks }
  }
  return linuxClock
}

/** Linux：读 /proc；读的途中退出的进程跳过 */
function readProcTable(): ProcessRow[] {
  const { bootTimeMs, clockTicks } = linuxClockInfo()
  const rows: ProcessRow[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry))
      continue
    try {
      const row = procRow(readFileSync(`/proc/${entry}/stat`, 'utf8'), readFileSync(`/proc/${entry}/cmdline`, 'utf8'), bootTimeMs, clockTicks)
      if (row !== undefined)
        rows.push(row)
    }
    catch {
      // 读的途中退出了
    }
  }
  return rows
}

/** macOS：ps；区域设置用 UTF-8（C 的区域设置下 ps 把非 ASCII 的字节转义成 M-…，资料目录里有中文时认不出），输出不是终端时不截断 */
function readPsTable(): ProcessRow[] {
  const sampledAt = Date.now()
  const text = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,stat=,etime=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' }, maxBuffer: 64 * 1024 * 1024 })
  return parsePsOutput(text, sampledAt)
}

/** 现取进程表（同步：冻住之后、结束之前在同一段同步代码里读） */
export function readProcessTable(platform: CrashPlatform): ProcessRow[] {
  return platform === 'linux' ? readProcTable() : readPsTable()
}

/**
 * 打开着 dir 里文件的进程。macOS 用 lsof：给了 pids 只查这些进程（快，约 40 ms），没给时查整个目录（+D，约 200–400 ms）；
 * Linux 读 /proc/<pid>/fd（没有权限的进程跳过）。dir 要是真实路径（lsof 与 /proc 交回的都是真实路径）
 */
export function filesHeldIn(dir: string, platform: CrashPlatform, pids?: readonly number[]): Set<number> {
  if (pids !== undefined && pids.length === 0)
    return new Set()
  if (platform === 'darwin') {
    const args = ['-n', '-P', '-F', 'pn', ...(pids === undefined ? ['+D', dir] : ['-p', pids.join(',')])]
    let output: string
    try {
      output = execFileSync('lsof', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    }
    catch (error) {
      // 一个也没找到时 lsof 的退出码是 1，输出照样有效
      output = (error as { stdout?: string }).stdout ?? ''
    }
    return pidsHoldingFilesIn(output, dir)
  }
  const holders = new Set<number>()
  for (const entry of pids?.map(String) ?? readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (readdirSync(`/proc/${entry}/fd`).some(fd => isWithin(readlinkSync(`/proc/${entry}/fd/${fd}`), dir)))
        holders.add(Number(entry))
    }
    catch {
      // 没有权限或者已经退出
    }
  }
  return holders
}

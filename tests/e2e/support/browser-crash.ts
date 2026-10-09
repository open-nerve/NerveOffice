// 崩溃工具（M4-P1 设计 §3.7；P3 的崩溃恢复沿用）：持久化的浏览器目录、结束整棵浏览器进程、以同一个目录重开。认进程的部分在 ./browser-processes.ts。
//
// - 启动（launch）：持久上下文，资料目录在 test-results/crash-profiles/ 下（每条用例、每次重复与重试唯一，见 profileDirFor）。
//   持久上下文不经共用夹具的 context，夹具的那几样自己挂上：CSP 违规、页面错误（用例结束时断言，与共用夹具同一套收集）、自动保存的打开状态，
//   以及 locale、timezoneId、baseURL、ignoreHTTPSErrors。启动之后在进程表里认出根（测试的工作进程的子进程、命令行带资料目录）。
// - 结束（prepareCrash → crash）：prepare 现取进程表认出这次启动的全部进程（macOS 的 WebKit 另经 lsof 认承载存储的 Networking），核对要求的
//   角色都在、认得准（macOS 上另有 Playwright WebKit 实例时报错说明），存下 Cookie。crash 是一段同步代码：先冻住（SIGSTOP：承载存储的在前，
//   再整个进程组，再其余，不到 1 毫秒）——浏览器停在这一刻；再现取进程表（根停住了没死，进程树还在）认出这一刻的全部进程；然后在同一个循环里
//   结束（SIGKILL）。冻住之后浏览器不再前进，对存储来说等于在冻住的那一刻被结束，读进程表的几十毫秒不落在要测的时机上（"写入之前"的信号一到
//   就冻住）。之后等全部退出（僵尸算退出）、核对没有幸存者。
// - 重开（relaunch）：以同一个目录重开。Cookie 不一定已经落盘，走两条确定的路：restore（崩溃之前存下的加回去，模拟已落盘）、clear（清掉，用例
//   自己重新登录，模拟没落盘）；浏览器实际留下了哪些记成附件（不带值），不断言。
//
// 跑法：崩溃用例单独成项目（每个浏览器一个、workers: 1、等全部浏览器项目跑完，playwright.config.ts）。macOS 上认 WebKit 的 WebContent 与 GPU
// 要求机器上只有这一个 Playwright WebKit 实例，所以崩溃用例不经共用夹具：共用夹具的 context 会起一个共用的浏览器，在 WebKit 上就是第二个实例。
import type { BrowserContext, BrowserType, Cookie, Page, TestInfo } from '@playwright/test'
import type { AutosaveMode } from './autosave.ts'
import type { CrashPlatform, InstanceProcess, InstanceSpec, ProcessRole, ProcessRow } from './browser-processes.ts'
import type { CspViolations, PageErrors } from './fixtures.ts'
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test as base, expect } from '@playwright/test'
import {
  cookieSummary,
  currentPlatform,
  filesHeldIn,
  freezeTargets,
  identifyInstance,
  killTargets,
  launchRootIn,
  missingRoles,
  readProcessTable,
  reconcilePlanned,
  stillAlive,
  stillRunning,
  webkitNetworkingCandidates,
} from './browser-processes.ts'
import { chooseAutosave, cspViolationCollector, defaultAutosaveMode, pageErrorCollector } from './fixtures.ts'

/** 一次持久化的启动 */
export interface PersistentLaunch {
  readonly context: BrowserContext
  /** 持久上下文自带的那个页面 */
  readonly page: Page
  readonly spec: InstanceSpec
  /** 第几次启动（0 起，重开一次加一） */
  readonly generation: number
}

/** 一次结束的结果 */
export interface CrashReport {
  readonly spec: InstanceSpec
  /** 冻住的时刻（Date.now）：浏览器停在这一刻 */
  readonly frozenAt: number
  /** 结束的进程：准备时认出的 ∪ 冻住之后现取进程表认出的 */
  readonly killed: readonly InstanceProcess[]
  /** 其中准备之后才出现的（冻住之后认出来，同样结束了） */
  readonly late: readonly InstanceProcess[]
  /** 等过时限还活着的这次启动的进程（应当为空） */
  readonly survivors: readonly ProcessRow[]
  /** 要求结束的角色里没在结束的进程里出现的（应当为空） */
  readonly missingRoles: readonly ProcessRole[]
  /** 认不准、动错了进程这一类问题（应当为空） */
  readonly problems: readonly string[]
  /** 只记录的说明：结束之后还打开着资料目录里文件的进程（例如 Spotlight）等 */
  readonly notes: readonly string[]
  /** 准备时存下的 Cookie（重开时 restore 用；带值，不写进附件与日志） */
  readonly cookies: readonly Cookie[]
}

/** 准备好的一次结束：进程都认出来了，要测的时机一到就调用 crash */
export interface CrashPlan {
  readonly launch: PersistentLaunch
  /** 准备时认出的这次启动的进程 */
  readonly processes: readonly InstanceProcess[]
  /** 冻住、现取进程表、结束（同步），之后等退出、核对没有幸存者；只能调用一次 */
  readonly crash: () => Promise<CrashReport>
}

/** 重开时的 Cookie：restore 把崩溃之前存下的加回去（模拟已落盘），clear 清掉（模拟没落盘，用例自己重新登录） */
export type RelaunchCookies = 'restore' | 'clear'

export interface CrashTool {
  /** 第一次启动（资料目录是空的） */
  readonly launch: () => Promise<PersistentLaunch>
  /** 认出这次启动的全部进程，准备结束 */
  readonly prepareCrash: (launch: PersistentLaunch) => Promise<CrashPlan>
  /** 准备并立即结束（时机不要紧的时候） */
  readonly crash: (launch: PersistentLaunch) => Promise<CrashReport>
  /** 以同一个目录重开（上一次必须结束得干净） */
  readonly relaunch: (previous: PersistentLaunch, report: CrashReport, options: { readonly cookies: RelaunchCookies }) => Promise<PersistentLaunch>
  /** 持久上下文里的 CSP 违规与页面错误：用例结束时断言为空（声明了预期的除外） */
  readonly cspViolations: CspViolations
  readonly pageErrors: PageErrors
}

/** 结束之后等全部退出的时限 */
const EXIT_TIMEOUT_MS = 10_000
/** 用例结束时正常关闭持久上下文的时限：到了还没关上就整组结束 */
const CLOSE_TIMEOUT_MS = 30_000

/** 启动持久上下文所需的、一个用例里不变的东西 */
interface LaunchEnvironment {
  readonly browserType: BrowserType
  readonly platform: CrashPlatform
  readonly family: InstanceSpec['family']
  readonly profileDir: string
  readonly webkitInstallDir: string | undefined
  readonly options: Parameters<BrowserType['launchPersistentContext']>[1]
  /** 挂上夹具的那几样（CSP 违规、页面错误、自动保存的打开状态） */
  readonly prepareContext: (context: BrowserContext) => Promise<void>
  readonly testInfo: TestInfo
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 发信号；进程已经不在（ESRCH）不算错，别的错误（例如没有权限）记进 problems */
function send(pid: number, signal: NodeJS.Signals, problems: string[]): void {
  try {
    process.kill(pid, signal)
  }
  catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ESRCH')
      problems.push(`向 ${pid} 发 ${signal} 失败：${code ?? String(error)}`)
  }
}

/** 进程的简短说明（报告与附件用）：进程号、角色、怎样认出的、命令行的开头 */
function describeProcess(item: InstanceProcess): string {
  return `${item.pid} ${item.role}（${item.via}）${item.command.slice(0, 120)}`
}

/** macOS 的 WebKit：机器上另有 Playwright WebKit 实例时认不准 XPC，不起、不结束（报错说明，不静默跳过） */
function assertWebkitAlone(environment: LaunchEnvironment, spec?: InstanceSpec): void {
  if (environment.platform !== 'darwin' || environment.family !== 'webkit')
    return
  const table = readProcessTable(environment.platform)
  const probe: InstanceSpec = spec ?? { platform: environment.platform, family: environment.family, workerPid: process.pid, rootPid: -1, profileDir: environment.profileDir, launchedAt: Date.now(), webkitInstallDir: environment.webkitInstallDir }
  const { problems } = identifyInstance(table, probe, new Set())
  if (problems.length > 0)
    throw new Error(problems.join('；'))
}

async function launchPersistent(environment: LaunchEnvironment, generation: number): Promise<PersistentLaunch> {
  assertWebkitAlone(environment)
  const launchedAt = Date.now()
  const context = await environment.browserType.launchPersistentContext(environment.profileDir, environment.options)
  try {
    const root = launchRootIn(readProcessTable(environment.platform), process.pid, environment.profileDir)
    if (root.kind !== 'found')
      throw new Error(root.kind === 'missing' ? '进程表里认不出这次启动的根（测试的工作进程的子进程、命令行带资料目录）' : `这次启动的根不止一个：${root.pids.join('、')}`)
    const spec: InstanceSpec = { platform: environment.platform, family: environment.family, workerPid: process.pid, rootPid: root.pid, profileDir: environment.profileDir, launchedAt, webkitInstallDir: environment.webkitInstallDir }
    assertWebkitAlone(environment, spec)
    await environment.prepareContext(context)
    const page = context.pages()[0] ?? await context.newPage()
    return { context, page, spec, generation }
  }
  catch (error) {
    await context.close().catch(() => undefined)
    throw error
  }
}

/** macOS 的 WebKit：安装目录下的 Networking 里打开着资料目录里文件的（承载这个资料目录的 IndexedDB 与 Cookie）；别的情况不用 */
function storageHolders(table: readonly ProcessRow[], spec: InstanceSpec, realProfileDir: string): Set<number> {
  if (spec.platform !== 'darwin' || spec.family !== 'webkit')
    return new Set()
  return filesHeldIn(realProfileDir, spec.platform, webkitNetworkingCandidates(table, spec).map(row => row.pid))
}

function unionByPid(...lists: readonly (readonly InstanceProcess[])[]): InstanceProcess[] {
  const byPid = new Map<number, InstanceProcess>()
  for (const list of lists) {
    for (const item of list) {
      if (!byPid.has(item.pid))
        byPid.set(item.pid, item)
    }
  }
  return [...byPid.values()]
}

/**
 * 同步的一段：冻住（承载存储的在前，进程组整个一次）→ 现取进程表认出这一刻的全部进程 → 同一个循环里结束。
 * 准备时认出的进程号在冻住之后核对还是不是同一个进程：被别的进程用了（准备之后它退出、号又分给了别人）就立即恢复它、记进 problems
 */
function freezeAndKill(spec: InstanceSpec, planned: readonly InstanceProcess[], holders: ReadonlySet<number>, problems: string[]): { readonly frozenAt: number, readonly killed: InstanceProcess[] } {
  const frozenAt = Date.now()
  for (const target of freezeTargets(spec.rootPid, planned))
    send(target, 'SIGSTOP', problems)
  try {
    const table = readProcessTable(spec.platform)
    const { kept, replaced } = reconcilePlanned(table, planned)
    for (const item of replaced) {
      send(item.pid, 'SIGCONT', problems)
      problems.push(`准备时认出的 ${describeProcess(item)} 在冻住时已经换成了别的进程：已经恢复它，这次不算数`)
    }
    const now = identifyInstance(table, spec, holders)
    problems.push(...now.problems)
    const killed = unionByPid(kept, now.processes)
    for (const target of killTargets(spec.rootPid, killed))
      send(target, 'SIGKILL', problems)
    return { frozenAt, killed }
  }
  catch (error) {
    // 读进程表失败之类：不让冻住的进程留在那里
    send(-spec.rootPid, 'SIGKILL', problems)
    for (const item of planned)
      send(item.pid, 'SIGKILL', problems)
    throw error
  }
}

/** 等结束的进程全部退出（僵尸算退出）；之后再认一遍这次启动还活着的进程（进程组、命令行提到资料目录、macOS 的 WebKit XPC） */
async function verifyExited(spec: InstanceSpec, killed: readonly InstanceProcess[], problems: string[]): Promise<ProcessRow[]> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  let alive = stillAlive(readProcessTable(spec.platform), killed)
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(50)
    alive = stillAlive(readProcessTable(spec.platform), killed)
  }
  const after = stillRunning(readProcessTable(spec.platform), spec)
  problems.push(...after.problems)
  const leftovers = after.processes.filter(item => !alive.some(row => row.pid === item.pid))
  // 一个循环里漏掉的也是这次启动的进程：结束它，仍然算幸存者（报告里要看得到）
  for (const item of leftovers)
    send(item.pid, 'SIGKILL', problems)
  return [...alive, ...leftovers]
}

async function crashNow(launch: PersistentLaunch, planned: readonly InstanceProcess[], holders: ReadonlySet<number>, cookies: readonly Cookie[], realProfileDir: string): Promise<CrashReport> {
  const { spec } = launch
  const problems: string[] = []
  const notes: string[] = []
  const { frozenAt, killed } = freezeAndKill(spec, planned, holders, problems)
  const survivors = await verifyExited(spec, killed, problems)
  await launch.context.close().catch(() => undefined)
  const fileHolders = filesHeldIn(realProfileDir, spec.platform)
  if (fileHolders.size > 0)
    notes.push(`结束之后还打开着资料目录里文件的进程（只记录）：${[...fileHolders].join('、')}`)
  return {
    spec,
    frozenAt,
    killed,
    late: killed.filter(item => !planned.some(known => known.pid === item.pid)),
    survivors,
    missingRoles: missingRoles(killed, spec),
    problems,
    notes,
    cookies,
  }
}

/** 一次结束的附件（不带 Cookie 的值） */
function crashAttachment(report: CrashReport, generation: number): string {
  return JSON.stringify({
    generation,
    platform: report.spec.platform,
    family: report.spec.family,
    rootPid: report.spec.rootPid,
    frozenAt: report.frozenAt,
    killed: report.killed.map(describeProcess),
    late: report.late.map(describeProcess),
    survivors: report.survivors.map(row => `${row.pid} ${row.command.slice(0, 120)}`),
    missingRoles: report.missingRoles,
    problems: report.problems,
    notes: report.notes,
    cookies: cookieSummary(report.cookies),
  }, null, 2)
}

function createCrashTool(environment: LaunchEnvironment, collectors: Pick<CrashTool, 'cspViolations' | 'pageErrors'>): CrashTool & { readonly dispose: () => Promise<void> } {
  const realProfileDir = (): string => realpathSync(environment.profileDir)
  /** 还开着的那一次启动（结束之后为 undefined）：用例结束时关闭 */
  let live: PersistentLaunch | undefined

  const prepareCrash = async (launch: PersistentLaunch): Promise<CrashPlan> => {
    if (live !== launch)
      throw new Error('只能结束还开着的、最近的那一次启动')
    const cookies = await launch.context.cookies()
    const table = readProcessTable(launch.spec.platform)
    const holders = storageHolders(table, launch.spec, realProfileDir())
    const { processes, problems } = identifyInstance(table, launch.spec, holders)
    if (problems.length > 0)
      throw new Error(problems.join('；'))
    const missing = missingRoles(processes, launch.spec)
    if (missing.length > 0)
      throw new Error(`准备结束时没认出这些角色的进程：${missing.join('、')}；认出的是：${processes.map(describeProcess).join('；')}`)
    let used = false
    return {
      launch,
      processes,
      crash: async () => {
        if (used)
          throw new Error('一次准备只能结束一次')
        used = true
        live = undefined
        const report = await crashNow(launch, processes, holders, cookies, realProfileDir())
        await environment.testInfo.attach(`crash-${launch.generation}.json`, { body: crashAttachment(report, launch.generation), contentType: 'application/json' })
        return report
      },
    }
  }

  return {
    ...collectors,
    launch: async () => {
      if (live !== undefined)
        throw new Error('已经有一次启动还开着')
      live = await launchPersistent(environment, 0)
      return live
    },
    prepareCrash,
    crash: async launch => (await prepareCrash(launch)).crash(),
    relaunch: async (previous, report, { cookies }) => {
      if (report.spec.rootPid !== previous.spec.rootPid)
        throw new Error('结束的报告不是这一次启动的')
      if (report.survivors.length > 0 || report.problems.length > 0)
        throw new Error(`上一次没有结束干净，不能以同一个目录重开：幸存者 ${report.survivors.map(row => row.pid).join('、') || '无'}；${report.problems.join('；')}`)
      const next = await launchPersistent(environment, previous.generation + 1)
      live = next
      const kept = await next.context.cookies()
      await environment.testInfo.attach(`relaunch-${next.generation}-cookies.json`, {
        body: JSON.stringify({ cookies, keptByBrowser: cookieSummary(kept), beforeCrash: cookieSummary(report.cookies) }, null, 2),
        contentType: 'application/json',
      })
      await next.context.clearCookies()
      if (cookies === 'restore')
        await next.context.addCookies([...report.cookies])
      return next
    },
    dispose: async () => {
      const launch = live
      live = undefined
      if (launch === undefined)
        return
      const closed = await Promise.race([launch.context.close().then(() => true, () => true), sleep(CLOSE_TIMEOUT_MS).then(() => false)])
      if (!closed) {
        // 关不上（例如停住的浏览器）：整组结束，再按进程表认一遍
        const problems: string[] = []
        const { processes } = identifyInstance(readProcessTable(launch.spec.platform), launch.spec, new Set())
        send(-launch.spec.rootPid, 'SIGKILL', problems)
        for (const item of processes)
          send(item.pid, 'SIGKILL', problems)
      }
    },
  }
}

/**
 * 资料目录：test-results/crash-profiles/<用例的 id>-<第几次重复>-<第几次重试>。每条用例、每次重复与重试唯一；失败时留着便于看，下次运行 Playwright
 * 清空 test-results；路径记进用例的注解（crash-profile）。不用 testInfo.outputPath('profile')：用例的输出目录名里有中文标题，Linux 上的 WebKit
 * （GLib 按区域设置解析命令行参数）在非 UTF-8 的区域设置下起不来（容器里实测："Cannot parse arguments: Invalid byte sequence in conversion input"）
 */
function profileDirFor(testInfo: TestInfo): string {
  const dir = join(testInfo.project.outputDir, 'crash-profiles', `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`)
  mkdirSync(dir, { recursive: true })
  testInfo.annotations.push({ type: 'crash-profile', description: dir })
  return dir
}

/** 断言一次结束：要求的角色都结束了、没有幸存者、认得准 */
export function expectCrashed(report: CrashReport): void {
  expect(report.problems, '结束的过程里认不准或动错了进程').toEqual([])
  expect(report.missingRoles, `要求结束的角色没有都在结束的进程里（结束的：${report.killed.map(describeProcess).join('；')}）`).toEqual([])
  expect(report.survivors.map(row => `${row.pid} ${row.command.slice(0, 120)}`), '结束之后还活着的进程').toEqual([])
}

/** 崩溃用例的 test：不经共用夹具的 context（见文件开头），持久上下文由 crashTool 起 */
export const test = base.extend<{ autosave: AutosaveMode, crashTool: CrashTool }>({
  autosave: [defaultAutosaveMode(), { option: true }],
  crashTool: async ({ playwright, browserName, autosave }, provide, testInfo) => {
    if (browserName === 'firefox')
      throw new Error('崩溃工具只支持 Chromium 系与 WebKit')
    const browserType = playwright[browserName]
    const { baseURL, ignoreHTTPSErrors, locale, timezoneId, channel } = testInfo.project.use
    const csp = cspViolationCollector()
    const errors = pageErrorCollector()
    const tool = createCrashTool({
      browserType,
      platform: currentPlatform(),
      family: browserName,
      profileDir: profileDirFor(testInfo),
      webkitInstallDir: browserName === 'webkit' ? realpathSync(dirname(browserType.executablePath())) : undefined,
      options: { channel, baseURL, ignoreHTTPSErrors, locale, timezoneId },
      prepareContext: async (context) => {
        await csp.cspViolations.watch(context)
        errors.pageErrors.watch(context)
        await chooseAutosave(context, autosave)
      },
      testInfo,
    }, { cspViolations: csp.cspViolations, pageErrors: errors.pageErrors })
    await provide(tool)
    await tool.dispose()
    errors.check()
    csp.check()
  },
})

export { expect }

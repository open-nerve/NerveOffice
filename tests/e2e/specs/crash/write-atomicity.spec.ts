// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、S7）：生产的写入管道与 IndexedDB 的存储，两种放置（进程内；发件箱 Worker），
// 经编辑器页测试构建里的崩溃用例探针（support/crash-probe.ts）反复写约 5 MiB 的内容，冻住并结束整棵进程，以同一个目录重开：
// 读回的必须是旧的或新的一份——都能解开（管道解开、解压）、序号是两者之一、内容逐字节对得上、写入者的高水位与草稿的序号一致（同一个事务）。
// 结束的时机两组，每种放置、每个浏览器共 22 次：
// - 开始写之后 0–260 ms 的延迟（12 次，前密后疏）：落在去重、压缩、加密、交给存储、提交与提交之后；
// - "写入之前"的信号（进程内：交给存储之前；Worker：Worker 开写入的事务时，经绑定函数通知测试进程）之后 0 到 1.5 倍提交用时（10 次）：
//   信号一到就冻住时事务还没开始，读回的总是旧的，所以按先量出的提交用时往后错开，让冻住的那一刻落在事务的各个阶段（M0 P6 审查 G5）。
// 另有一条锚点：写完了再结束，读回的必须是新的（写成了的扛得住进程被结束）。每次的结局（旧、新）、冻住的时机与结束之后 IndexedDB 日志结尾的
// 状态记成附件，不断言两种结局的比例（与机器的快慢有关）。
// 口径不放宽（设计 §3.8）：Chromium 偶尔在被结束之后删掉整个来源的 IndexedDB（之前一次结束之后日志结尾写了一半）——OPFS 的冗余（S9）
// 做完之前这里读不回就是红的；失败的说明里带上日志结尾的状态。要先登录（探针在编辑器页里），重开时走 Cookie 的 restore
import type { TestInfo } from '@playwright/test'
import type { CrashReport, CrashTool, PersistentLaunch } from '../../support/browser-crash.ts'
import type { CrashCheck, CrashPlacement, CrashProbeRead, CrashSetup } from '../../support/crash-probe.ts'
import { expect, expectCrashed, test } from '../../support/browser-crash.ts'
import { CRASH_CONTENT_CHARS, CRASH_PLACEMENTS, crashSetupFor, openCrashProbe } from '../../support/crash-probe.ts'
import { createUser } from '../../support/database.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 开始写入之后过多少毫秒冻住浏览器（实验的自变量，不是等某个状态）：前密后疏 */
const KILL_DELAYS_MS = [0, 3, 6, 9, 12, 15, 20, 30, 50, 80, 130, 260] as const
/** "写入之前"的信号之后结束的次数 */
const SIGNAL_RUNS = 10
/** 等"写入之前"的信号的时限：交给存储之前要压缩、加密约 5 MiB，慢的机器上也远小于它 */
const SIGNAL_TIMEOUT_MS = 30_000

const PLACEMENT_LABELS: Readonly<Record<CrashPlacement, string>> = { 'in-process': '进程内的写入管道', 'worker': '发件箱 Worker 里的写入管道' }

/** 一次结束的结局 */
interface Outcome {
  readonly trigger: string
  /** 结束之前已经写成的序号；这次写的是它加一 */
  readonly before: number
  /** 从开始写（发出 evaluate 之前）到冻住的毫秒数 */
  readonly frozenAfterMs: number
  readonly read: CrashProbeRead
  /** 这次结束之后 IndexedDB 日志结尾的状态（Chromium 系；clean 之外的带说明） */
  readonly logs: readonly string[]
}

/** 读回的序号（没读出草稿时为 null） */
function seqOf(read: CrashProbeRead): number | null {
  return read.kind === 'draft' ? read.seq : null
}

function logsOf(report: CrashReport): string[] {
  return report.indexedDbLogs.map(state => state.tail.status === 'clean' ? 'clean' : `${state.tail.status}：${state.tail.detail}`)
}

/** 读回的不是旧的或新的一份（能解开、序号、内容、两个仓库一致）时的说明；读不回时带上前后两次结束之后日志结尾的状态 */
function problemsOf(outcomes: readonly Outcome[]): string[] {
  return outcomes.flatMap((outcome, index) => {
    const { read, before } = outcome
    const label = `第 ${index + 1} 次（${outcome.trigger}，冻在开始写之后 ${outcome.frozenAfterMs} ms）`
    if (read.kind !== 'draft') {
      const previous = outcomes[index - 1]
      const logs = `IndexedDB 日志的结尾：上一次结束之后 ${previous === undefined ? '（第一次）' : previous.logs.join('；') || '无'}，这一次结束之后 ${outcome.logs.join('；') || '无'}`
      return [`${label}：没读出能解开的草稿：${JSON.stringify(read)}（${logs}）`]
    }
    const problems: string[] = []
    if (read.seq !== before && read.seq !== before + 1)
      problems.push(`${label}：读回的序号是 ${read.seq}，不是旧的 ${before} 或新的 ${before + 1}`)
    if (!read.intact || read.bytes !== CRASH_CONTENT_CHARS)
      problems.push(`${label}：内容对不上（${read.bytes} 字节）`)
    if (read.writerSeq !== read.seq)
      problems.push(`${label}：写入者的高水位 ${String(read.writerSeq)} 与草稿的序号 ${read.seq} 不一致`)
    return problems
  })
}

/** 读回的是旧的、新的，还是别的 */
function resultOf({ before, read }: Outcome): 'old' | 'new' | 'other' {
  const seq = seqOf(read)
  if (seq === before)
    return 'old'
  return seq === before + 1 ? 'new' : 'other'
}

/** 结局的附件：每次是旧的还是新的、冻在开始写之后多少毫秒、日志结尾的状态 */
async function attachOutcomes(testInfo: TestInfo, outcomes: readonly Outcome[]): Promise<void> {
  const rows = outcomes.map(outcome => ({ trigger: outcome.trigger, frozenAfterMs: outcome.frozenAfterMs, result: resultOf(outcome), read: outcome.read, indexedDbLogs: outcome.logs }))
  await testInfo.attach('outcomes.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' })
}

async function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 第一次启动：登录、打开探针（这种放置）、写完第 1 份 */
async function begin(crashTool: CrashTool, prefix: string, placement: CrashPlacement): Promise<{ launch: PersistentLaunch, check: CrashCheck, setup: CrashSetup }> {
  const user = await createUser(prefix)
  const launch = await crashTool.launch()
  await loginThroughApi(launch.page, user)
  const setup = crashSetupFor(user.id, placement)
  const check = await openCrashProbe(launch, setup)
  expect(await check.write(1)).toBe('written')
  return { launch, check, setup }
}

/** 量一次没被打断的写入：交给存储（Worker：开写入的事务）到管道交回结果用了多少毫秒，至少 1 毫秒 */
async function commitDuration(check: CrashCheck, seq: number): Promise<number> {
  const written = await check.write(seq)
  const state = await check.lastWrite()
  if (written !== 'written' || state?.putAtMs === undefined || state.settledAtMs === undefined)
    throw new Error(`量不出提交用时：${written}、${JSON.stringify(state)}`)
  return Math.max(1, Math.round(state.settledAtMs - state.putAtMs))
}

/** "写入之前"的信号之后过多少毫秒冻住：从 0 到提交用时的 1.5 倍等分 */
function signalOffsets(commitMs: number): number[] {
  return Array.from({ length: SIGNAL_RUNS }, (_, index) => Math.round(index * 1.5 * commitMs / (SIGNAL_RUNS - 1)))
}

/** 等"写入之前"的信号结束浏览器：偏移为 0 时在绑定的回调里同步冻住、结束，否则过这么多毫秒 */
async function crashAfterSignal(check: CrashCheck, crash: () => Promise<CrashReport>, offsetMs: number): Promise<CrashReport> {
  return new Promise<CrashReport>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${SIGNAL_TIMEOUT_MS} ms 里没收到"写入之前"的信号`)), SIGNAL_TIMEOUT_MS)
    check.onBeforePut(() => {
      clearTimeout(timer)
      const run = (): void => {
        crash().then(resolve, reject)
      }
      if (offsetMs === 0)
        run()
      else
        setTimeout(run, offsetMs)
    })
  })
}

/** 重开（登录接着有效），打开探针，读回这一份 */
async function relaunchAndRead(crashTool: Pick<CrashTool, 'relaunch'>, launch: PersistentLaunch, report: CrashReport, setup: CrashSetup): Promise<{ launch: PersistentLaunch, check: CrashCheck, read: CrashProbeRead }> {
  const next = await crashTool.relaunch(launch, report, { cookies: 'restore' })
  const check = await openCrashProbe(next, setup)
  return { launch: next, check, read: await check.read() }
}

for (const placement of CRASH_PLACEMENTS) {
  test.describe(`写入中途结束整棵浏览器进程：读回旧的或新的一份（${PLACEMENT_LABELS[placement]}）`, { tag: '@test-build' }, () => {
    test('写完了再结束：以同一个目录重开之后读回的是它', async ({ crashTool }) => {
      const { launch, setup } = await begin(crashTool, 'crash-anchor', placement)
      const report = await crashTool.crash(launch)
      expectCrashed(report)
      const reopened = await relaunchAndRead(crashTool, launch, report, setup)
      expect(reopened.read).toEqual({ kind: 'draft', seq: 1, writerSeq: 1, bytes: CRASH_CONTENT_CHARS, intact: true })
    })

    test('开始写之后 0–260 ms 结束：每次读回的都是旧的或新的一份', async ({ crashTool }, testInfo) => {
      let { launch, check, setup } = await begin(crashTool, 'crash-delay', placement)
      let committed = 1
      const outcomes: Outcome[] = []
      for (const delayMs of KILL_DELAYS_MS) {
        const plan = await crashTool.prepareCrash(launch)
        const startedAt = Date.now()
        await check.start(committed + 1, { signal: false })
        await waitMs(delayMs)
        const report = await plan.crash()
        expectCrashed(report)
        const reopened = await relaunchAndRead(crashTool, launch, report, setup)
        launch = reopened.launch
        check = reopened.check
        outcomes.push({ trigger: `延迟 ${delayMs} ms`, before: committed, frozenAfterMs: report.frozenAt - startedAt, read: reopened.read, logs: logsOf(report) })
        committed = seqOf(reopened.read) ?? committed
      }
      await attachOutcomes(testInfo, outcomes)
      expect(outcomes).toHaveLength(KILL_DELAYS_MS.length)
      expect(problemsOf(outcomes)).toEqual([])
    })

    test('"写入之前"的信号之后 0 到 1.5 倍提交用时结束：每次读回的都是旧的或新的一份', async ({ crashTool }, testInfo) => {
      let { launch, check, setup } = await begin(crashTool, 'crash-signal', placement)
      const commitMs = await commitDuration(check, 2)
      let committed = 2
      const outcomes: Outcome[] = []
      for (const offsetMs of signalOffsets(commitMs)) {
        const plan = await crashTool.prepareCrash(launch)
        const crashed = crashAfterSignal(check, plan.crash, offsetMs)
        const startedAt = Date.now()
        await check.start(committed + 1, { signal: true })
        const report = await crashed
        expectCrashed(report)
        const reopened = await relaunchAndRead(crashTool, launch, report, setup)
        launch = reopened.launch
        check = reopened.check
        outcomes.push({ trigger: `信号之后 ${offsetMs} ms（提交用时 ${commitMs} ms）`, before: committed, frozenAfterMs: report.frozenAt - startedAt, read: reopened.read, logs: logsOf(report) })
        committed = seqOf(reopened.read) ?? committed
      }
      await attachOutcomes(testInfo, outcomes)
      expect(outcomes).toHaveLength(SIGNAL_RUNS)
      expect(problemsOf(outcomes)).toEqual([])
    })
  })
}

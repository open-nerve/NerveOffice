// 写入中途结束整棵浏览器进程时的原子性（M4-P1 设计 §3.7、S7）：持久上下文里反复写约 5 MiB 的字节（测试里自己写的最小写入，
// support/crash-write-check.ts：两个对象仓库、同一个 strict 事务），冻住并结束整棵进程，以同一个目录重开：读回的必须是旧的或新的一份——序号是
// 两者之一、字节逐字节对得上、写入者的高水位与草稿的序号一致（两个对象仓库同时提交或同时不提交）。结束的时机两组，每个浏览器共 22 次：
// - 开始写之后 0–260 ms 的延迟（12 次，前密后疏）：落在生成字节、put、提交与提交之后；
// - "写入之前"的信号（put 之前经绑定函数通知测试进程）之后 0 到 1.5 倍提交用时（10 次）：信号一到就冻住时 put 还没到存储那边，读回的总是旧的，
//   所以按先量出的提交用时（put 到 complete）往后错开，让冻住的那一刻落在提交的各个阶段（M0 P6 审查 G5："杀点落在事务提交附近"）。
// 另有一条锚点：写完、提交了再结束，读回的必须是新的（已提交的写入扛得住进程被结束）。每次的结局（旧、新）与冻住的时机记成附件，不断言两种结局
// 的比例（与机器的快慢有关）。生产的存储与写入管道合并之后，同样的断言接到生产代码上（两种放置）
import type { TestInfo } from '@playwright/test'
import type { CrashReport, CrashTool, PersistentLaunch } from '../../support/browser-crash.ts'
import type { CheckRecord, WriteCheck } from '../../support/crash-write-check.ts'
import { expect, expectCrashed, test } from '../../support/browser-crash.ts'
import { openWriteCheck, WRITE_CHECK_BYTES } from '../../support/crash-write-check.ts'

/** 开始写入之后过多少毫秒冻住浏览器（实验的自变量，不是等某个状态）：前密后疏 */
const KILL_DELAYS_MS = [0, 3, 6, 9, 12, 15, 20, 30, 50, 80, 130, 260] as const
/** "写入之前"的信号之后结束的次数 */
const SIGNAL_RUNS = 10
/** 等"写入之前"的信号的时限：写约 5 MiB 之前生成字节只要几毫秒到几十毫秒，慢的机器上也远小于它 */
const SIGNAL_TIMEOUT_MS = 30_000

/** 一次结束的结局 */
interface Outcome {
  readonly trigger: string
  /** 结束之前已经提交的序号；这次写的是它加一 */
  readonly before: number
  /** 从开始写（发出 evaluate 之前）到冻住的毫秒数 */
  readonly frozenAfterMs: number
  readonly record: CheckRecord
}

/** 读回的不是旧的或新的一份（序号、字节、两个对象仓库一致）时的说明 */
function problemsOf(outcomes: readonly Outcome[]): string[] {
  return outcomes.flatMap((outcome, index) => {
    const { record, before } = outcome
    const label = `第 ${index + 1} 次（${outcome.trigger}，冻在开始写之后 ${outcome.frozenAfterMs} ms）`
    const problems: string[] = []
    if (record.seq !== before && record.seq !== before + 1)
      problems.push(`${label}：读回的序号是 ${String(record.seq)}，不是旧的 ${before} 或新的 ${before + 1}`)
    if (!record.intact || record.bytes !== WRITE_CHECK_BYTES)
      problems.push(`${label}：字节对不上（${record.bytes} 字节）`)
    if (record.writerSeq !== record.seq)
      problems.push(`${label}：写入者的高水位 ${String(record.writerSeq)} 与草稿的序号 ${String(record.seq)} 不一致`)
    return problems
  })
}

/** 读回的是旧的、新的，还是别的 */
function resultOf({ before, record }: Outcome): 'old' | 'new' | 'other' {
  if (record.seq === before)
    return 'old'
  return record.seq === before + 1 ? 'new' : 'other'
}

/** 结局的附件：每次是旧的还是新的、冻在开始写之后多少毫秒 */
async function attachOutcomes(testInfo: TestInfo, outcomes: readonly Outcome[]): Promise<void> {
  const rows = outcomes.map(outcome => ({ trigger: outcome.trigger, frozenAfterMs: outcome.frozenAfterMs, result: resultOf(outcome), record: outcome.record }))
  await testInfo.attach('outcomes.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' })
}

async function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 量一次没被打断的写入：put 到提交（complete）用了多少毫秒，至少 1 毫秒 */
async function commitDuration(check: WriteCheck, seq: number): Promise<number> {
  await check.write(seq)
  const state = await check.lastWrite()
  if (state?.putAtMs === undefined || state.committedAtMs === undefined)
    throw new Error(`量不出提交用时：${JSON.stringify(state)}`)
  return Math.max(1, Math.round(state.committedAtMs - state.putAtMs))
}

/** "写入之前"的信号之后过多少毫秒冻住：从 0 到提交用时的 1.5 倍等分 */
function signalOffsets(commitMs: number): number[] {
  return Array.from({ length: SIGNAL_RUNS }, (_, index) => Math.round(index * 1.5 * commitMs / (SIGNAL_RUNS - 1)))
}

/** 等"写入之前"的信号结束浏览器：偏移为 0 时在绑定的回调里同步冻住、结束，否则过这么多毫秒 */
async function crashAfterSignal(check: WriteCheck, crash: () => Promise<CrashReport>, offsetMs: number): Promise<CrashReport> {
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

/** 重开，读回这一份 */
async function relaunchAndRead(crashTool: Pick<CrashTool, 'relaunch'>, launch: PersistentLaunch, report: CrashReport): Promise<{ launch: PersistentLaunch, check: WriteCheck, record: CheckRecord }> {
  const next = await crashTool.relaunch(launch, report, { cookies: 'clear' })
  const check = await openWriteCheck(next)
  return { launch: next, check, record: await check.read() }
}

test.describe('写入中途结束整棵浏览器进程：读回旧的或新的一份', () => {
  test('写完、提交了再结束：以同一个目录重开之后读回的是它', async ({ crashTool }) => {
    const launch = await crashTool.launch()
    const check = await openWriteCheck(launch)
    await check.write(1)
    const report = await crashTool.crash(launch)
    expectCrashed(report)
    const reopened = await relaunchAndRead(crashTool, launch, report)
    expect(reopened.record).toEqual({ seq: 1, writerSeq: 1, bytes: WRITE_CHECK_BYTES, intact: true })
  })

  test('开始写之后 0–260 ms 结束：每次读回的都是旧的或新的一份', async ({ crashTool }, testInfo) => {
    let launch = await crashTool.launch()
    let check = await openWriteCheck(launch)
    await check.write(1)
    let committed = 1
    const outcomes: Outcome[] = []
    for (const delayMs of KILL_DELAYS_MS) {
      const plan = await crashTool.prepareCrash(launch)
      const startedAt = Date.now()
      await check.start(committed + 1, { signal: false })
      await waitMs(delayMs)
      const report = await plan.crash()
      expectCrashed(report)
      const reopened = await relaunchAndRead(crashTool, launch, report)
      launch = reopened.launch
      check = reopened.check
      outcomes.push({ trigger: `延迟 ${delayMs} ms`, before: committed, frozenAfterMs: report.frozenAt - startedAt, record: reopened.record })
      committed = reopened.record.seq ?? committed
    }
    await attachOutcomes(testInfo, outcomes)
    expect(outcomes).toHaveLength(KILL_DELAYS_MS.length)
    expect(problemsOf(outcomes)).toEqual([])
  })

  test('"写入之前"的信号之后 0 到 1.5 倍提交用时结束：每次读回的都是旧的或新的一份', async ({ crashTool }, testInfo) => {
    let launch = await crashTool.launch()
    let check = await openWriteCheck(launch)
    await check.write(1)
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
      const reopened = await relaunchAndRead(crashTool, launch, report)
      launch = reopened.launch
      check = reopened.check
      outcomes.push({ trigger: `信号之后 ${offsetMs} ms（提交用时 ${commitMs} ms）`, before: committed, frozenAfterMs: report.frozenAt - startedAt, record: reopened.record })
      committed = reopened.record.seq ?? committed
    }
    await attachOutcomes(testInfo, outcomes)
    expect(outcomes).toHaveLength(SIGNAL_RUNS)
    expect(problemsOf(outcomes)).toEqual([])
  })
})

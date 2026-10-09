// 写 OPFS 镜像途中结束整棵浏览器进程（M4-P1 设计 §3.8，S9 第 5 项）：发件箱 Worker 里，IndexedDB 提交之后镜像写在"现在不是最新那一份"的槽位上
// （截断 → 写内容 → 写头 → flush）。写 3.8 MiB 只要几毫秒，比"报到页面、通知测试进程、冻住"还快，按时机冻不到半途；所以每次先写完第 s 份
// （库与镜像都是它），再开始写第 s+1 份，让崩溃用例的测试 Worker 停在写镜像的某一步之后（mirror-recorder.ts 忙等）、报来，测试进程随即冻住、
// 结束整棵进程，以同一个目录重开——槽位就停在那一步写完的样子：
// - 截断之后：一个是第 s 份，另一个是空的；写内容之后：另一个不合格（还没有头）；写头之后、flush 之后：另一个是第 s+1 份（进程被结束时已经写进
//   文件的还在）——两个槽位读回旧的或新的一份，写一半的那一个落选，合格的那一个始终是第 s 份；
// - 库里是新的一份（镜像在库提交之后才写）——Chromium 偶尔删库时由镜像写回，读回旧的或新的都算，事件如实（同 write-atomicity.spec.ts）。
// 三个浏览器都跑（进程内放置没有镜像）。每一步两次；结局记成附件。标签 @test-build
import type { TestInfo } from '@playwright/test'
import type { CrashReport } from '../../support/browser-crash.ts'
import type { CrashCheck, CrashProbeRead, MirrorPausePoint } from '../../support/crash-probe.ts'
import type { ProbeSlot, RecoveryEvent } from '../../support/outbox-probe.ts'
import { expect, expectCrashed, test } from '../../support/browser-crash.ts'
import { CRASH_CONTENT_CHARS, crashSetupFor, MIRROR_PAUSE_POINTS, openCrashProbe, removeCrashMirror, slotWord } from '../../support/crash-probe.ts'
import { createUser } from '../../support/database.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 每一步结束几次 */
const REPEATS = 2
/** 等"停住了"的信号的时限 */
const SIGNAL_TIMEOUT_MS = 30_000
/** 读、改槽位之后，管道下一次写镜像时再拿句柄：OPFS 的探针 Worker 放开句柄是异步的，拿不到（busy）时管道按退避（0.5 秒起）再试 */
const MIRROR_RETRY_PAUSE_MS = 700
const MIRROR_ATTEMPTS = 5

/** 每一步之后另一个槽位（正在写的那一个）的样子：前缀相同即可（不合格的原因不论） */
const EXPECTED_OTHER: Readonly<Record<MirrorPausePoint, (next: number) => string>> = {
  'after-truncate': () => 'empty',
  'after-content': () => 'invalid:',
  'after-header': next => `seq${next}`,
  'after-flush': next => `seq${next}`,
}

/** 这条用例还开着的那一次启动上的探针：用例结束时（不论成败）关掉管道、删掉用例用户的镜像目录 */
let live: CrashCheck | undefined

test.afterEach(async () => {
  const check = live
  live = undefined
  if (check !== undefined && !check.page.isClosed())
    await removeCrashMirror(check)
})

interface Outcome {
  readonly point: MirrorPausePoint
  /** 结束之前库与镜像里都是的序号；这次写的是它加一 */
  readonly before: number
  readonly databaseExisted: boolean
  readonly read: CrashProbeRead
  readonly events: readonly RecoveryEvent[]
  readonly slots: readonly [ProbeSlot, ProbeSlot]
}

/** 两个槽位不是"一个第 s 份、另一个是那一步写完的样子"、库里读回的不是该有的那一份、事件不如实时的说明 */
function problemsOf(outcomes: readonly Outcome[]): string[] {
  return outcomes.flatMap((outcome, index) => {
    const { before, read, point } = outcome
    const label = `第 ${index + 1} 次（停在 ${point}，打开之前库${outcome.databaseExisted ? '在' : '不在'}）`
    const problems: string[] = []
    const words = outcome.slots.map(slotWord)
    const others = words.filter(word => word !== `seq${before}`)
    const expected = EXPECTED_OTHER[point](before + 1)
    if (others.length !== 1 || others[0]?.startsWith(expected) !== true)
      problems.push(`${label}：两个槽位是 ${JSON.stringify(words)}，应当一个是 seq${before}、另一个是 ${expected}…`)
    const events = outcome.events.map(event => event.kind)
    const expectedEvents = outcome.databaseExisted ? [] : ['restored']
    if (JSON.stringify(events) !== JSON.stringify(expectedEvents))
      problems.push(`${label}：比对留下的事件是 ${JSON.stringify(events)}，应当是 ${JSON.stringify(expectedEvents)}`)
    if (read.kind !== 'draft')
      return [...problems, `${label}：没读出能解开的草稿：${JSON.stringify(read)}`]
    // 库在时库里是新的（镜像在库提交之后才写）；库没了时由镜像写回，旧的或新的都算
    const allowed = outcome.databaseExisted ? [before + 1] : [before, before + 1]
    if (!allowed.includes(read.seq))
      problems.push(`${label}：读回的序号是 ${read.seq}，应当是 ${allowed.join(' 或 ')}`)
    if (!read.intact || read.bytes !== CRASH_CONTENT_CHARS)
      problems.push(`${label}：内容对不上（${read.bytes} 字节）`)
    if (read.writerSeq !== read.seq)
      problems.push(`${label}：写入者的高水位 ${String(read.writerSeq)} 与草稿的序号 ${read.seq} 不一致`)
    return problems
  })
}

/** 下一次从读回的序号接着写（没读出草稿时接着用原来的） */
function seqAfter(read: CrashProbeRead, previous: number): number {
  return read.kind === 'draft' ? read.seq : previous
}

async function attachOutcomes(testInfo: TestInfo, outcomes: readonly Outcome[]): Promise<void> {
  const rows = outcomes.map(outcome => ({ point: outcome.point, before: outcome.before, slots: outcome.slots.map(slotWord), read: outcome.read, databaseExisted: outcome.databaseExisted, events: outcome.events.map(event => event.kind) }))
  await testInfo.attach('outcomes.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' })
}

/** 写完一份、镜像也写成：镜像没写成（句柄还没放开）时隔一会儿换下一个序号再写。交回库与镜像里都是的那个序号 */
async function writeMirrored(check: CrashCheck, after: number): Promise<number> {
  const statuses: string[] = []
  for (let attempt = 1; attempt <= MIRROR_ATTEMPTS; attempt += 1) {
    const seq = after + attempt
    expect(await check.write(seq)).toBe('written')
    const mirror = (await check.lastWrite())?.mirror ?? 'unknown'
    if (mirror === 'mirrored')
      return seq
    statuses.push(mirror)
    await new Promise(resolve => setTimeout(resolve, MIRROR_RETRY_PAUSE_MS))
  }
  throw new Error(`写了 ${MIRROR_ATTEMPTS} 次镜像都没写成：${statuses.join('、')}`)
}

/** 等"停住了"的信号，在绑定的回调里同步冻住、结束 */
async function crashWhenPaused(check: CrashCheck, crash: () => Promise<CrashReport>): Promise<CrashReport> {
  return new Promise<CrashReport>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${SIGNAL_TIMEOUT_MS} ms 里没收到"停住了"的信号`)), SIGNAL_TIMEOUT_MS)
    check.onSignal(() => {
      clearTimeout(timer)
      crash().then(resolve, reject)
    })
  })
}

test.describe('写 OPFS 镜像途中结束整棵浏览器进程（发件箱 Worker）', { tag: '@test-build' }, () => {
  test('停在写镜像的每一步之后结束：两个槽位读回旧的或新的一份（写一半的落选），库里读回新的', async ({ crashTool }, testInfo) => {
    const user = await createUser('crash-mirror')
    let launch = await crashTool.launch()
    await loginThroughApi(launch.page, user)
    const setup = crashSetupFor(user.id, 'worker')
    let check = await openCrashProbe(launch, setup)
    live = check
    expect(check.registered.mirror).toBe('mirrored')
    let seq = 0
    const outcomes: Outcome[] = []
    for (const point of MIRROR_PAUSE_POINTS.flatMap(item => Array.from<MirrorPausePoint>({ length: REPEATS }).fill(item))) {
      // 先写完第 s 份：库与镜像都是它
      seq = await writeMirrored(check, seq)
      const plan = await crashTool.prepareCrash(launch)
      const crashed = crashWhenPaused(check, plan.crash)
      await check.start(seq + 1, { signal: point })
      const report = await crashed
      expectCrashed(report)
      live = undefined
      launch = await crashTool.relaunch(launch, report, { cookies: 'restore' })
      check = await openCrashProbe(launch, setup)
      live = check
      const read = await check.read()
      const events = await check.events()
      const slots = await check.mirrorSlots()
      outcomes.push({ point, before: seq, databaseExisted: check.registered.peek.existed, read, events, slots })
      seq = seqAfter(read, seq)
    }
    await attachOutcomes(testInfo, outcomes)
    expect(outcomes).toHaveLength(MIRROR_PAUSE_POINTS.length * REPEATS)
    expect(problemsOf(outcomes)).toEqual([])
  })
})

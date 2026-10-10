// 确定地造出 Chromium 删库之后，草稿从 OPFS 的镜像写回（M4-P1 设计 §3.8，S9 第 5 项）。删库用崩溃工具的 tearIndexedDbLog：结束之后往这个来源的
// IndexedDB 日志结尾补一个只有头的记录（模拟被结束在追加一条记录的两次 write 之间），下一次打开一切正常、写一份（新数据接在那半条后面），
// 再下一次打开时 Chromium 删掉这个来源的全部 IndexedDB（S7 的调查；support/leveldb-log.ts）。删库之后重开，发件箱 Worker 登记之前比对镜像：
// - restored：镜像里合格的那一份写回库（连同写入者的记录——代次、writerId、高水位，与提示在同一个事务里），读回的是删库之前最后写成的那一份，
//   库里恰好一条 restored 的提示，同一个写入者接着写照常；
// - lost：两个槽位都被破坏（探针的 corruptSlot）、库里也没有——库里恰好一条"本机草稿因浏览器存储损坏丢失"（lost）的提示，读回没有。
// 提示读出之后清除。
// 只在 Chromium 系上跑：WebKit 的 IndexedDB 是 SQLite，没有这个缺陷，日志也补不了（IndexedDB 被删之后的恢复由 specs/outbox/mirror.spec.ts 在
// 三个浏览器上用删库的接口核对）。只看被测来源（baseURL）的那一条日志。标签 @test-build
// UR-034 的前提（docs/upstream/UR-034-chromium-indexeddb-torn-log-wipe.md）：Chromium 的 IndexedDB 是 LevelDB、复用日志，补的半条记录之后新写的
// 接在它后面，再下一次打开时删掉整个来源的库。CI 装的是当时最新的稳定版 Chrome 与 Edge，前提哪天不在了，这里的用例会失败，说明以
// "UR-034 的前提不在了"开头。到时的处理：
// - 资料目录里没有这个来源的 LevelDB IndexedDB（浏览器换了后端，例如 Chromium 的 SQLite 后端）：先用 S7 调查的自然出现的循环在新后端上重查
//   崩溃之后会不会丢库、丢成什么样；不丢就把造删库的这几步改成经删库的接口造出"库没了"（同 specs/outbox/mirror.spec.ts），丢就照新的机理另造；
//   UR-034 与设计 §3.8 一并订正。
// - 补了半条记录之后没有删库（缺陷修好了）：用 UR-034 的最小复现确认是哪个版本修的，同样改用删库的接口造出"库没了"；OPFS 的冗余留不留由
//   需求方定（修好之前的 Chromium 与别的浏览器仍可能需要）。
import type { CrashReport, CrashTool, PersistentLaunch } from '../../support/browser-crash.ts'
import type { CrashCheck, CrashSetup } from '../../support/crash-probe.ts'
import { expect, expectCrashed, indexedDbLogOf, test, UR034_PREMISE_GONE } from '../../support/browser-crash.ts'
import { CRASH_CONTENT_CHARS, crashSetupFor, openCrashProbe, removeCrashMirror, slotWord } from '../../support/crash-probe.ts'
import { createUser } from '../../support/database.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 补了半条记录、之后写过一次，再打开时库还在：缺陷修好了 */
const WIPE_MISSING = `${UR034_PREMISE_GONE}：补了半条记录、之后写过一次，再打开时 Chromium 没有删库（缺陷修好了？）`

/** 第二次启动结束之后，被测来源的日志里那半条记录后面接上了新写的（下一次打开时删库） */
function expectPoisoned(report: CrashReport, origin: string | undefined): void {
  const log = indexedDbLogOf(report, origin)
  expect(log.tail.status, `${UR034_PREMISE_GONE}：补的半条记录之后新写的没有接在它后面（LevelDB 不再复用日志？）：${JSON.stringify(log.tail)}`).toBe('corrupt')
}

/** 这条用例还开着的那一次启动上的探针：用例结束时（不论成败）关掉管道、删掉用例用户的镜像目录 */
let live: CrashCheck | undefined

test.afterEach(async () => {
  const check = live
  live = undefined
  if (check !== undefined && !check.page.isClosed())
    await removeCrashMirror(check)
})

/** 结束（空闲时）之后以同一个目录重开、打开探针（登记之前比对镜像） */
async function crashAndReopen(crashTool: CrashTool, launch: PersistentLaunch, setup: CrashSetup, between?: (report: CrashReport) => void): Promise<{ launch: PersistentLaunch, check: CrashCheck, report: CrashReport }> {
  live = undefined
  const report = await crashTool.crash(launch)
  expectCrashed(report)
  between?.(report)
  const next = await crashTool.relaunch(launch, report, { cookies: 'restore' })
  const check = await openCrashProbe(next, setup)
  live = check
  return { launch: next, check, report }
}

/**
 * 写完第 1 份 → 结束 → 往日志结尾补只有头的记录 → 重开（数据都在）、写完第 2 份（库与镜像都是它；新数据接在那半条后面）。
 * 交回第二次启动；它再结束、重开时 Chromium 删库
 */
async function poisonedSession(crashTool: CrashTool, prefix: string): Promise<{ launch: PersistentLaunch, check: CrashCheck, setup: CrashSetup }> {
  const user = await createUser(prefix)
  const first = await crashTool.launch()
  await loginThroughApi(first.page, user)
  const setup = crashSetupFor(user.id, 'worker')
  const opened = await openCrashProbe(first, setup)
  live = opened
  expect(opened.registered.mirror).toBe('mirrored')
  expect(await opened.write(1)).toBe('written')
  const { launch, check } = await crashAndReopen(crashTool, first, setup, (report) => {
    expect(crashTool.tearIndexedDbLog(first, report).tail.status).toBe('torn-payload')
  })
  expect(check.registered.peek.existed).toBe(true)
  expect(await check.read()).toEqual({ kind: 'draft', seq: 1, writerSeq: 1, bytes: CRASH_CONTENT_CHARS, intact: true })
  expect(await check.write(2)).toBe('written')
  expect((await check.lastWrite())?.mirror).toBe('mirrored')
  return { launch, check, setup }
}

test.describe('Chromium 删库之后从 OPFS 的镜像写回（发件箱 Worker）', { tag: '@test-build' }, () => {
  test.beforeEach(({ browserName }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 的 IndexedDB 是 SQLite，没有这个缺陷、日志补不了；删库之后的恢复由 specs/outbox/mirror.spec.ts 在三个浏览器上核对
    test.skip(browserName === 'webkit', 'WebKit 的 IndexedDB 是 SQLite，没有这个缺陷')
  })

  test('restored：删库之后重开，最后写成的那一份连同写入者从镜像写回，提示如实，同一个写入者接着写照常', async ({ crashTool, baseURL }) => {
    const poisoned = await poisonedSession(crashTool, 'crash-restore')
    const { check, report } = await crashAndReopen(crashTool, poisoned.launch, poisoned.setup)
    expectPoisoned(report, baseURL)
    // 这次启动之前库没了；登记之前的比对把镜像里的第 2 份写回了库
    expect(check.registered.peek.existed, WIPE_MISSING).toBe(false)
    expect(check.registered.existing).toBe('draft')
    expect(check.registered.lastDraftSeq).toBe(2)
    expect(await check.notices()).toEqual(['restored@这份文档'])
    expect(await check.read()).toEqual({ kind: 'draft', seq: 2, writerSeq: 2, bytes: CRASH_CONTENT_CHARS, intact: true })
    // 写回之后高水位是 2：再写第 1 份（不比高水位新）被栅栏拒绝，不会把写回的第 2 份盖掉（写回连同写入者的细节由 specs/outbox/mirror.spec.ts 核对）
    expect(await check.write(1)).toBe('fenced')
    expect(await check.write(3)).toBe('written')
    expect(await check.read()).toEqual({ kind: 'draft', seq: 3, writerSeq: 3, bytes: CRASH_CONTENT_CHARS, intact: true })
    expect(await check.notices()).toEqual([])
  })

  test('lost：两个槽位都被破坏、删库之后库里也没有——留下"本机草稿因浏览器存储损坏丢失"，读回没有', async ({ crashTool, baseURL }) => {
    const poisoned = await poisonedSession(crashTool, 'crash-lost')
    // 一个写进垃圾、一个截掉一半：两个都校验不过
    await poisoned.check.corruptSlot(0, { fill: 4096, value: 0xAB })
    await poisoned.check.corruptSlot(1, { truncate: 100 })
    expect((await poisoned.check.mirrorSlots()).map(slotWord).map(word => word.split(':')[0])).toEqual(['invalid', 'invalid'])
    const { check, report } = await crashAndReopen(crashTool, poisoned.launch, poisoned.setup)
    expectPoisoned(report, baseURL)
    expect(check.registered.peek.existed, WIPE_MISSING).toBe(false)
    expect(check.registered.existing).toBe('none')
    expect(check.registered.lastDraftSeq).toBe(0)
    expect(await check.notices()).toEqual(['lost@这份文档'])
    expect(await check.read()).toEqual({ kind: 'absent', writerSeq: 0 })
  })
})

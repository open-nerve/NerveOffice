// 镜像比库落后一份时删库（M4-P1 设计 §3.8 的"库比镜像新时登记补写镜像"；S9 第 5 项查出的缺口，乙的订正修好）：镜像在 IndexedDB 提交之后才写，
// 被结束在"库已提交、镜像还没写完"之间时，镜像比库落后一份（写一半的槽位落选，另一个是上一份）。之后登记时库比镜像新，把库里那一份补写进镜像——
// 否则在下一次写成之前发生删库，从镜像写回的比最后一次提交的旧（已提交的写入丢了；修之前实测读回第 1 份）。
// 确定地造出来：写完第 1、2 份（两个槽位分别是它们）→ 把存着第 2 份的槽位改坏（等于写第 2 份的镜像时被结束）→ 结束、往日志结尾补只有头的记录
// → 重开（登记：库里第 2 份比镜像新，补写镜像）、在同一来源的另一个库里写一条（新数据接在那半条后面）→ 结束、重开：Chromium 删库，从镜像
// 写回的应当是第 2 份。只在 Chromium 系上跑（同 indexeddb-restore.spec.ts）；只看被测来源（baseURL）的那一条日志。标签 @test-build
// UR-034 的前提（docs/upstream/UR-034-chromium-indexeddb-torn-log-wipe.md）：Chromium 的 IndexedDB 是 LevelDB、复用日志，补的半条记录之后新写的
// 接在它后面，再下一次打开时删掉整个来源的库。CI 装的是当时最新的稳定版 Chrome 与 Edge，前提哪天不在了，这里的用例会失败，说明以
// "UR-034 的前提不在了"开头。到时的处理：
// - 资料目录里没有这个来源的 LevelDB IndexedDB（浏览器换了后端，例如 Chromium 的 SQLite 后端）：先用 S7 调查的自然出现的循环在新后端上重查
//   崩溃之后会不会丢库、丢成什么样；不丢就把造删库的这几步改成经删库的接口造出"库没了"（同 specs/outbox/mirror.spec.ts），丢就照新的机理另造；
//   UR-034 与设计 §3.8 一并订正。
// - 补了半条记录之后没有删库（缺陷修好了）：用 UR-034 的最小复现确认是哪个版本修的，同样改用删库的接口造出"库没了"；OPFS 的冗余留不留由
//   需求方定（修好之前的 Chromium 与别的浏览器仍可能需要）。
import type { Page } from '@playwright/test'
import type { CrashCheck } from '../../support/crash-probe.ts'
import { expect, expectCrashed, indexedDbLogOf, test, UR034_PREMISE_GONE } from '../../support/browser-crash.ts'
import { CRASH_CONTENT_CHARS, crashSetupFor, openCrashProbe, removeCrashMirror, slotWord } from '../../support/crash-probe.ts'
import { createUser } from '../../support/database.ts'
import { loginThroughApi } from '../../support/session.ts'

let live: CrashCheck | undefined

/** 存着第 seq 份的那个槽位 */
function slotHolding(slots: readonly string[], seq: number): 0 | 1 {
  return slots[0] === `seq${seq}` ? 0 : 1
}

test.afterEach(async () => {
  const check = live
  live = undefined
  if (check !== undefined && !check.page.isClosed())
    await removeCrashMirror(check)
})

/** 在同一来源的另一个库里写一条（strict）：让这次会话往 IndexedDB 的日志里追加东西，又不碰发件箱 */
async function touchOtherDatabase(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('nerve-crash-other', 1)
      opening.onupgradeneeded = () => opening.result.createObjectStore('s')
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error ?? new Error('打不开库'))
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('s', 'readwrite', { durability: 'strict' })
      tx.objectStore('s').put('x'.repeat(200), 'k')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('事务中止'))
    })
    db.close()
  })
}

test.describe('镜像比库落后一份时删库（发件箱 Worker）', { tag: '@test-build' }, () => {
  test.beforeEach(({ browserName }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 的 IndexedDB 是 SQLite，没有这个缺陷、日志补不了
    test.skip(browserName === 'webkit', 'WebKit 的 IndexedDB 是 SQLite，没有这个缺陷')
  })

  test('写第 2 份的镜像被结束在半途、之后删库：重开之前补写过镜像，写回的是第 2 份', async ({ crashTool, baseURL }) => {
    const user = await createUser('crash-stale-mirror')
    let launch = await crashTool.launch()
    await loginThroughApi(launch.page, user)
    const setup = crashSetupFor(user.id, 'worker')
    let check = await openCrashProbe(launch, setup)
    live = check
    expect(await check.write(1)).toBe('written')
    expect(await check.write(2)).toBe('written')
    expect((await check.lastWrite())?.mirror).toBe('mirrored')
    const slots = (await check.mirrorSlots()).map(slotWord)
    expect(slots.toSorted(), JSON.stringify(slots)).toEqual(['seq1', 'seq2'])
    // 存着第 2 份的槽位改坏：等于写第 2 份的镜像时被结束（库里已经是第 2 份）
    await check.corruptSlot(slotHolding(slots, 2), { truncate: 100 })
    live = undefined
    let report = await crashTool.crash(launch)
    expectCrashed(report)
    expect(crashTool.tearIndexedDbLog(launch, report).tail.status).toBe('torn-payload')

    // 重开：库里第 2 份比镜像新（登记时应当补写镜像）；在别的库里写一条，让新数据接在那半条后面
    launch = await crashTool.relaunch(launch, report, { cookies: 'restore' })
    check = await openCrashProbe(launch, setup)
    live = check
    expect(check.registered.peek.existed).toBe(true)
    expect(await check.read()).toEqual({ kind: 'draft', seq: 2, writerSeq: 2, bytes: CRASH_CONTENT_CHARS, intact: true })
    await touchOtherDatabase(launch.page)
    live = undefined
    report = await crashTool.crash(launch)
    expectCrashed(report)
    const log = indexedDbLogOf(report, baseURL)
    expect(log.tail.status, `${UR034_PREMISE_GONE}：补的半条记录之后新写的没有接在它后面（LevelDB 不再复用日志？）：${JSON.stringify(log.tail)}`).toBe('corrupt')

    // 再重开：Chromium 删库，从镜像写回
    launch = await crashTool.relaunch(launch, report, { cookies: 'restore' })
    check = await openCrashProbe(launch, setup)
    live = check
    expect(check.registered.peek.existed, `${UR034_PREMISE_GONE}：补了半条记录、之后写过一次，再打开时 Chromium 没有删库（缺陷修好了？）`).toBe(false)
    expect(await check.notices()).toEqual(['restored@这份文档'])
    expect(await check.read()).toEqual({ kind: 'draft', seq: 2, writerSeq: 2, bytes: CRASH_CONTENT_CHARS, intact: true })
  })
})

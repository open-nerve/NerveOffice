// 发件箱的库（M4-P1 设计 §3.3、§3.4.1）：在真实的 IndexedDB 上核对库的建立、读写事务的持久性、升级与 versionchange、
// 升级被挡住、删库之后重开、用不了时的原因、列表的标记。经测试构建里的探针调用生产的存储（support/outbox-probe.ts），标签 @test-build。
// 逻辑类的用例，用 Playwright 默认的（不落盘的）浏览器上下文；落盘、耗时、原子性在持久化的上下文里另测（S1、S7）
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, draftFor, NOW, openOutboxProbe, outcomeOf, probe, probeDatabase, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('发件箱的库', { tag: '@test-build' }, () => {
  test('第一次用时建出库：版本 1，两个仓库的键路径都是 [userId, documentId]、没有索引；读写的事务一律要求 strict，只读的不带', async ({ page }) => {
    const user = await createUser('ob-create')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    // 打开探针、看库都不建库
    expect(await probeDatabase(page, 'describe')).toBeNull()
    expect(await probeDatabase(page, 'exists')).toBe(false)

    await probe(page, 'recordTransactions')
    await probe(page, 'chooseKey', 1)
    const key = { userId: user.id, documentId: randomUUID() }
    const writer = writerOf(3)
    expect(await probe(page, 'register', key, writer, { now: NOW, force: false })).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined })
    expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    expect(outcomeOf(await probe(page, 'read', key), 'draft').opened).toEqual({ kind: 'opened', content: contentOf(writer, 1) })
    // 存储开的事务（登记、写入是读写的，读回是只读的）都在两个仓库上；读写的要求 strict（报告写完之前要求落盘）
    const transactions = await probe(page, 'transactions')
    expect(transactions.map(tx => [tx.stores, tx.mode, tx.durability])).toEqual([
      [['drafts', 'writers'], 'readwrite', 'strict'],
      [['drafts', 'writers'], 'readwrite', 'strict'],
      [['drafts', 'writers'], 'readonly', undefined],
    ])

    expect(await probeDatabase(page, 'exists')).toBe(true)
    expect(await probeDatabase(page, 'describe')).toEqual({
      version: 1,
      stores: [
        { name: 'drafts', keyPath: ['userId', 'documentId'], indexes: [] },
        { name: 'writers', keyPath: ['userId', 'documentId'], indexes: [] },
      ],
    })
  })

  test('别的标签页升级库（更新的页面）：本页的连接立即关掉，升级不被挡住；之后本页按 newer-version 退化，列表的标记照样读得出', async ({ page }) => {
    const user = await createUser('ob-upgrade')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    await probe(page, 'chooseKey', 1)
    const key = { userId: user.id, documentId: randomUUID() }
    const writer = writerOf(3)
    await probe(page, 'register', key, writer, { now: NOW, force: false })
    expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })

    // 另一个标签页扮演更新的页面：以版本 2 打开（加一个仓库）。本页的连接一直开着，不关就会挡住它
    const newer = await page.context().newPage()
    await openOutboxProbe(newer)
    expect(await probeDatabase(newer, 'upgrade', 2, 5_000)).toBe('upgraded')
    expect((await probeDatabase(newer, 'describe'))?.version).toBe(2)

    // 本页再用：重新打开版本 1 得到 VersionError，按"不可用（库比本页新）"交回，不写
    expect(await probe(page, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'unavailable', reason: 'newer-version' })
    expect(await probe(page, 'read', key)).toEqual({ kind: 'unavailable', reason: 'newer-version' })
    // 列表的标记不带版本打开、只读键：照样读得出
    expect(await probe(page, 'draftIds', user.id)).toEqual([key.documentId])
  })

  test('升级被不理会 versionchange 的旧连接挡住：等过时限交回 blocked；挡住的连接放开之后，再打开就成了', async ({ page }) => {
    const user = await createUser('ob-blocked')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    // 一个不理会 versionchange 的旧连接（例如被冻结的旧页面）一直开着版本 1
    const held = await probeDatabase(page, 'hold', 1)

    const other = await page.context().newPage()
    await openOutboxProbe(other)
    const started = Date.now()
    expect(await probeDatabase(other, 'openWith', 2, 300)).toBe('blocked')
    expect(Date.now() - started, '按时限交回 blocked，不一直等').toBeLessThan(10_000)

    await probeDatabase(page, 'release', held)
    // 被挡住的那次打开随之完成（升到版本 2），没人要了就关掉；之后再打开照常
    await expect.poll(async () => (await probeDatabase(other, 'describe'))?.version).toBe(2)
    expect(await probeDatabase(other, 'openWith', 2, 300)).toBe('connected')
  })

  test('删库（清除站点数据）：本页的连接让开、删除不被挡住；之后的操作重新打开，从空的库接着用（写入者也不在了，要重新登记）', async ({ page }) => {
    const user = await createUser('ob-deleted')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    await probe(page, 'chooseKey', 1)
    const key = { userId: user.id, documentId: randomUUID() }
    const writer = writerOf(3)
    await probe(page, 'register', key, writer, { now: NOW, force: false })
    expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })

    const other = await page.context().newPage()
    await openOutboxProbe(other)
    expect(await probeDatabase(other, 'remove', 5_000)).toBe('deleted')

    expect(await probe(page, 'read', key)).toEqual({ kind: 'absent' })
    expect(await probe(page, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect(await probe(page, 'register', key, writer, { now: NOW, force: false })).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined })
    expect(await probe(page, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'written' })
  })

  test('用不了时如实交回原因：没有 IndexedDB 是 unsupported，取它时被拒绝是 denied；每个操作都交回同样的值，不抛出', async ({ page }) => {
    const user = await createUser('ob-unavailable')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    await probe(page, 'chooseKey', 1)
    const key = { userId: user.id, documentId: randomUUID() }
    const writer = writerOf(3)
    for (const [factory, reason] of [['missing', 'unsupported'], ['throws', 'denied']] as const) {
      await probe(page, 'resetStore', { factory })
      const unavailable = { kind: 'unavailable', reason }
      expect(await probe(page, 'register', key, writer, { now: NOW, force: false }), factory).toEqual(unavailable)
      expect(await probe(page, 'write', draftFor(key, writer, 1)), factory).toEqual(unavailable)
      expect(await probe(page, 'read', key), factory).toEqual(unavailable)
      expect(await probe(page, 'list', user.id), factory).toEqual(unavailable)
      expect(await probe(page, 'purge', NOW), factory).toEqual(unavailable)
    }
    // 没有建出库
    expect(await probeDatabase(page, 'exists')).toBe(false)
  })

  test('列表的标记：库不存在时是空的、也不建库；之后只列出这个人有草稿的文档', async ({ page }) => {
    const user = await createUser('ob-index')
    const other = await createUser('ob-index-other')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    expect(await probe(page, 'draftIds', user.id)).toEqual([])
    expect(await probeDatabase(page, 'exists'), '列表的标记不建库').toBe(false)

    await probe(page, 'chooseKey', 1)
    const writer = writerOf(3)
    const documents = [randomUUID(), randomUUID()].sort()
    for (const [userId, documentId] of [[user.id, documents[0] ?? ''], [user.id, documents[1] ?? ''], [other.id, randomUUID()]] as const) {
      const key = { userId, documentId }
      await probe(page, 'register', key, writer, { now: NOW, force: false })
      expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    }
    expect(await probe(page, 'draftIds', user.id)).toEqual(documents)
  })
})

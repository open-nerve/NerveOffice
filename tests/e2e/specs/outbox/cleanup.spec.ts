// 发件箱的清理（M4-P1 设计 §3.4.7）：按用户清理（退出登录、账户停用）、保留期（14 天）与列出某人的草稿，在真实的 IndexedDB 上核对。
// 时间都是探针交进去的"现在"（不真等）。经测试构建里的探针调用生产的存储，标签 @test-build
import type { DraftKey } from '../../support/outbox-probe.ts'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { DAY_MS, draftFor, NOW, openOutboxProbe, outcomeOf, probe, probeDatabase, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 保留期（契约的 LOCAL_DRAFT_RETENTION_DAYS） */
const RETENTION_MS = 14 * DAY_MS

test.describe('发件箱的清理', { tag: '@test-build' }, () => {
  test('按用户清理：这个人的草稿与写入者一起删，别人的不动；之后迟到的写入因写入者不在而被拦下', async ({ page }) => {
    const user = await createUser('ob-clear')
    const other = await createUser('ob-clear-other')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    await probe(page, 'chooseKey', 1)
    const writer = writerOf(3)
    const mine = [{ userId: user.id, documentId: randomUUID() }, { userId: user.id, documentId: randomUUID() }]
    const theirs = { userId: other.id, documentId: randomUUID() }
    for (const key of [...mine, theirs]) {
      await probe(page, 'register', key, writer, { now: NOW, force: false })
      expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    }

    expect(await probe(page, 'removeUser', user.id)).toEqual({ kind: 'cleared' })
    for (const key of mine) {
      expect(await probe(page, 'read', key)).toEqual({ kind: 'absent' })
      expect(await probeDatabase(page, 'getRaw', 'writers', key)).toBeNull()
      // 清理之后才到的写入（另一个标签页还在写）：写入者不在了，被拦下
      expect(await probe(page, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'fenced', reason: 'not-writer' })
    }
    expect(await probe(page, 'list', user.id)).toEqual({ kind: 'listed', drafts: [] })
    expect(await probe(page, 'draftIds', user.id)).toEqual([])
    expect(outcomeOf(await probe(page, 'read', theirs), 'draft').meta.draftSeq).toBe(1)
    expect(await probeDatabase(page, 'getRaw', 'writers', theirs)).not.toBeNull()
  })

  test('保留期：读得出的更新时间超过 14 天的草稿都删（不论属于谁、不论格式，交回的键标明是哪一种）；读不出更新时间的留着；登记超过 14 天又没有草稿的写入者换成墓碑（审查 A6：挡住镜像里没截断成的那一份被写回，由合一的清理在镜像目录不在之后删）', async ({ page }) => {
    const user = await createUser('ob-retention')
    const other = await createUser('ob-retention-other')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    await probe(page, 'chooseKey', 1)
    const writer = writerOf(3)
    const keyOf = (userId: string): DraftKey => ({ userId, documentId: randomUUID() })
    const oldDraft = keyOf(user.id)
    const freshDraft = keyOf(user.id)
    const othersOldDraft = keyOf(other.id)
    const boundaryDraft = keyOf(user.id)
    const oldNewer = keyOf(user.id)
    const freshNewer = keyOf(user.id)
    const oldBroken = keyOf(user.id)
    const timeless = keyOf(user.id)
    const idleWriter = keyOf(user.id)
    const newWriter = keyOf(user.id)
    const longAgo = NOW - RETENTION_MS - 1

    // 写入者都在很久以前登记；草稿按各自的更新时间
    const drafts = [[oldDraft, longAgo], [freshDraft, NOW - DAY_MS], [othersOldDraft, longAgo], [boundaryDraft, NOW - RETENTION_MS], [oldNewer, longAgo], [freshNewer, NOW - DAY_MS], [oldBroken, longAgo], [timeless, longAgo]] as const
    for (const [key, updatedAt] of drafts) {
      await probe(page, 'register', key, writer, { now: longAgo, force: false })
      expect(await probe(page, 'write', draftFor(key, writer, 1, { updatedAt }))).toEqual({ kind: 'written' })
    }
    // 更新的页面写的（部署回滚之后旧页面认不出）：更新时间照样读得出
    for (const key of [oldNewer, freshNewer])
      await probeDatabase(page, 'patchDraft', key, { recordVersion: 2 })
    // 形状不对、更新时间读得出的；形状不对、连更新时间也读不出的
    await probeDatabase(page, 'patchDraft', oldBroken, { iv: 'abcd' })
    await probeDatabase(page, 'patchDraft', timeless, { updatedAt: 'long ago' })
    // 没有草稿的写入者：一个早已不用，一个刚登记
    await probe(page, 'register', idleWriter, writer, { now: longAgo, force: false })
    await probe(page, 'register', newWriter, writer, { now: NOW - DAY_MS, force: false })

    const removed = outcomeOf(await probe(page, 'purge', NOW), 'purged').drafts
    const byDocument = (a: { readonly key: DraftKey }, b: { readonly key: DraftKey }) => a.key.documentId.localeCompare(b.key.documentId)
    expect([...removed].sort(byDocument)).toEqual([
      { key: oldDraft, record: 'draft' },
      { key: othersOldDraft, record: 'draft' },
      { key: oldNewer, record: 'newer-format' },
      { key: oldBroken, record: 'malformed' },
    ].sort(byDocument))

    for (const key of [oldDraft, othersOldDraft, oldNewer, oldBroken])
      expect(await probe(page, 'read', key), key.documentId).toEqual({ kind: 'absent' })
    for (const key of [freshDraft, boundaryDraft])
      expect((await probe(page, 'read', key)).kind, '没超过 14 天（恰好 14 天不算）').toBe('draft')
    expect(await probe(page, 'read', freshNewer)).toEqual({ kind: 'newer-format', recordVersion: 2 })
    expect(await probe(page, 'read', timeless), '读不出更新时间：留给 P3、P4 发现之后说明并删').toEqual({ kind: 'malformed' })

    // 写入者：草稿删了的、早已不用的换成墓碑（高水位留着）；还有草稿的（高水位要接着用）、刚登记的照旧
    for (const key of [oldDraft, othersOldDraft, oldNewer, oldBroken, idleWriter])
      expect(await probeDatabase(page, 'getRaw', 'writers', key), key.documentId).toMatchObject({ writerId: 'retired', writeEpoch: 3 })
    for (const key of [freshDraft, boundaryDraft, freshNewer, timeless, newWriter])
      expect(await probeDatabase(page, 'getRaw', 'writers', key), key.documentId).toMatchObject({ writerId: writer.writerId })
  })

  test('列出某人的草稿：只有元数据（不交出密文），认不出的与形状不对的也列出、带上键；用户 id 是别人的前缀时互不相干', async ({ page }) => {
    const user = await createUser('ob-list')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    await probe(page, 'chooseKey', 1)
    const writer = writerOf(3)
    const documents = [randomUUID(), randomUUID(), randomUUID()].sort()
    const [plain, newer, broken] = documents.map(documentId => ({ userId: user.id, documentId })) as [DraftKey, DraftKey, DraftKey]
    // 别人的 id 以这个人的 id 开头（键范围 [userId] 到 [userId, []] 只认完全相同的 userId）
    const prefixed = { userId: `${user.id}0`, documentId: randomUUID() }
    for (const key of [plain, newer, broken, prefixed]) {
      await probe(page, 'register', key, writer, { now: NOW, force: false })
      expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    }
    await probeDatabase(page, 'patchDraft', newer, { recordVersion: 2 })
    await probeDatabase(page, 'patchDraft', broken, { iv: 'abcd' })

    const drafts = outcomeOf(await probe(page, 'list', user.id), 'listed').drafts
    expect(drafts.map(draft => draft.kind)).toEqual(['draft', 'newer-format', 'malformed'])
    expect(Object.keys(outcomeOf(drafts[0] ?? { kind: 'absent' }, 'draft').meta).sort()).toEqual(['baseRevision', 'documentId', 'draftSeq', 'format', 'formulasPending', 'inFlight', 'keyVersion', 'rawBytes', 'recordVersion', 'updatedAt', 'userId', 'writeEpoch', 'writerId', 'writtenBy'])
    expect(drafts[1]).toEqual({ kind: 'newer-format', key: newer, recordVersion: 2 })
    expect(drafts[2]).toEqual({ kind: 'malformed', key: broken })
    expect(await probe(page, 'draftIds', user.id)).toEqual(documents)
    expect(await probe(page, 'draftIds', prefixed.userId)).toEqual([prefixed.documentId])
  })
})

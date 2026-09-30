// 到期的自动清理（M2-P4 设计 §3.4 第 6 条）：到期与否按给定的时刻判断、不判断人的权限、
// 操作者记为系统、来源是定时任务、锁的顺序与人工的永久删除相同、锁下重新读到的是别的结果时跳过。
// 真实的 SQL（按到期时间取一批、连带删除）由集成测试用真实数据库覆盖。
import { TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { ALICE, ALICE_SPACE, FakeStore, HTTP_ORIGIN, member } from './documents.test-support.ts'
import { TrashPurgeService } from './trash-purge.service.ts'
import { TrashService } from './trash.service.ts'

/** 假仓储里的删除时间（documents.test-support 的 NOW）与到期时间 */
const DELETED_AT = new Date('2026-09-27T08:00:00.000Z')
const EXPIRES_AT = new Date(DELETED_AT.getTime() + TRASH_RETENTION_DAYS * 24 * 3_600_000)
const AFTER = new Date(EXPIRES_AT.getTime() + 1)
const BEFORE = new Date(EXPIRES_AT.getTime() - 1)

function setup() {
  const store = new FakeStore()
  const { transactions, documents, folders, entries, tree, spaces, policy, audit, writeAccess } = store.deps
  const trash = new TrashService(transactions, documents, folders, entries, tree, spaces, policy, audit, writeAccess)
  return { store, trash, service: new TrashPurgeService(transactions, documents, entries, tree, spaces, trash) }
}

/** 删掉一份文档，返回它与它的删除单元 */
async function deletedDocument(store: FakeStore, trash: TrashService, title = '周报') {
  const document = store.addDocument({ title })
  await trash.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
  const entry = [...store.trashEntries.values()].find(row => row.title === title)
  if (entry === undefined)
    throw new Error('删除之后没有删除单元')
  return { document, entry }
}

describe('TrashPurgeService.listExpired', () => {
  it('到期的才取，按调用方给的时刻判断（不是数据库的 now()）', async () => {
    const { store, trash, service } = setup()
    const { entry } = await deletedDocument(store, trash)

    expect(await service.listExpired(BEFORE, 50)).toEqual([])
    // 不带标题：jobs 的日志与审计不经手标题（M2-P6 复核 M-1）
    expect(await service.listExpired(AFTER, 50)).toEqual([
      { id: entry.id, spaceId: ALICE_SPACE, kind: 'document', expiresAt: EXPIRES_AT },
    ])
  })

  it('批量的条数原样传给仓储', async () => {
    const { store, trash, service } = setup()
    await deletedDocument(store, trash, '第一份')
    await deletedDocument(store, trash, '第二份')
    expect(await service.listExpired(AFTER, 1)).toHaveLength(1)
    expect(store.entries.listExpired).toHaveBeenLastCalledWith(AFTER, 1)
  })
})

describe('TrashPurgeService.purgeExpired', () => {
  it('永久删除：内容一起没了，审计的操作者是系统、来源是定时任务', async () => {
    const { store, trash, service } = setup()
    const { document, entry } = await deletedDocument(store, trash)

    await expect(service.purgeExpired(entry)).resolves.toEqual({
      purged: true,
      outcome: { objectId: document.id, kind: 'document', spaceId: ALICE_SPACE, folders: 0, documents: 1, cascadedEntryIds: [] },
    })
    expect(store.documents.has(document.id)).toBe(false)
    expect(store.trashEntries.size).toBe(0)
    // 审计只记份数与删除单元，不记标题（M2-P6 复核 M-1）
    expect(store.audits.at(-1)).toEqual({
      action: 'documents.purged',
      actor: { type: 'system' },
      target: { type: 'document', id: document.id },
      origin: { source: 'job' },
      details: { spaceId: ALICE_SPACE, trashEntryId: entry.id, folders: 0, documents: 1, cascadedEntries: 0 },
    })
  })

  it('取锁的顺序与人工的永久删除相同：空间树 → 空间行 → 文档行 → 回收站行', async () => {
    const { store, trash, service } = setup()
    const { entry } = await deletedDocument(store, trash)
    interface Mocked { mock: { invocationCallOrder: number[] } }
    /** 删除时也调过这几个，所以只看这次清理里的第一次调用 */
    const taken = (fn: Mocked): number => fn.mock.invocationCallOrder.length
    const before = [store.tree.lock, store.spaces.holdSpace, store.repositories.documents.lockInEntries, store.entries.lockById].map(taken)
    const first = (fn: Mocked, index: number): number => fn.mock.invocationCallOrder[before[index] ?? 0] ?? Number.POSITIVE_INFINITY

    await service.purgeExpired(entry)
    expect(store.treeLocks.at(-1)).toEqual([ALICE_SPACE])
    expect(first(store.tree.lock, 0)).toBeLessThan(first(store.spaces.holdSpace, 1))
    expect(first(store.spaces.holdSpace, 1)).toBeLessThan(first(store.repositories.documents.lockInEntries, 2))
    expect(first(store.repositories.documents.lockInEntries, 2)).toBeLessThan(first(store.entries.lockById, 3))
  })

  it('锁下已经不在（有人恢复了、或者别处已经清掉了）：跳过，不记审计', async () => {
    const { store, trash, service } = setup()
    const { entry } = await deletedDocument(store, trash)
    const audits = store.audits.length
    store.entries.lockById.mockResolvedValueOnce(undefined)

    await expect(service.purgeExpired(entry)).resolves.toEqual({ purged: false, reason: 'gone' })
    expect(store.audits).toHaveLength(audits)
    expect(store.trashEntries.size).toBe(1)
  })

  it('锁下发现它已经随子树移到别的空间：手里的树锁保护不到它，留给下一轮', async () => {
    const { store, trash, service } = setup()
    const { entry } = await deletedDocument(store, trash)
    store.entries.lockById.mockResolvedValueOnce({ ...entry, spaceId: '0199a2c4-0000-7000-8000-0000000000c1' })

    await expect(service.purgeExpired(entry)).resolves.toEqual({ purged: false, reason: 'moved' })
    expect(store.trashEntries.size).toBe(1)
  })

  it('归档的空间里照样清（不判断人的权限）', async () => {
    const { store, trash, service } = setup()
    const { document, entry } = await deletedDocument(store, trash)
    store.space(ALICE_SPACE).status = 'archived'

    await expect(service.purgeExpired(entry)).resolves.toMatchObject({ purged: true })
    expect(store.documents.has(document.id)).toBe(false)
  })
})

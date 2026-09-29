// 复制一份文档（M2-P4 设计 §3.4 第 4 条）：权限、副本的各列、快照原样复制、requestId 的幂等与取锁的顺序。
// 真实的 INSERT … SELECT（逐字节一致）由集成测试用真实数据库覆盖，这里的假仓储只保持同样的语义。
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentCopyService } from './document-copy.service.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'

const MISSING_ID = '0199a2c4-0000-7000-8000-0000000000fd'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, contents, revisions, folders, tree, spaces, policy, audit } = store.deps
  return { store, service: new DocumentCopyService(transactions, documents, contents, revisions, folders, tree, spaces, policy, audit) }
}

let requests = 0
function nextRequestId(): string {
  requests += 1
  return `0199a2c4-0000-7000-8000-${String(requests).padStart(12, '0')}`
}

/** 一份有内容的文档（快照是压缩后的字节，复制时原样搬过去） */
function seed(store: FakeStore, overrides: Parameters<FakeStore['addDocument']>[0] = {}) {
  const document = store.addDocument({ title: '周报', ...overrides })
  const snapshot = Buffer.from(`gzip:${document.id}`, 'utf8')
  store.contents.set(document.id, { snapshot, rawBytes: 100 })
  return { document, snapshot }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error(`期望抛出 AppError，实际是 ${String(error)}`)
  return error
}

describe('DocumentCopyService.copy', () => {
  it('副本是一份新文档：新的 id、修订号 1、unitId 与源相同、快照原样复制，写一条新建的修订记录与审计', async () => {
    const { store, service } = setup()
    const { document, snapshot } = seed(store)
    const copy = await service.copy(member(ALICE), document.id, { spaceId: ALICE_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN)
    expect(copy.id).not.toBe(document.id)
    expect(copy).toMatchObject({ title: '周报 的副本', spaceId: ALICE_SPACE, folderId: null, revision: 1, type: 'sheet', profile: 'sheet@1', formatVersion: 1 })
    // unitId 原样复制（00 号计划书 §8.3）：副本与源的快照逐字节一致
    expect(store.documents.get(copy.id)?.unitId).toBe(document.unitId)
    expect(store.contentOf(copy.id)).toBe(snapshot)
    expect(store.revisions.filter(row => row.documentId === copy.id)).toMatchObject([{ revision: 1, kind: 'created', savedBy: ALICE }])
    // 源文档的内容与修订记录一点不动
    expect(store.contentOf(document.id)).toBe(snapshot)
    expect(store.revisions.filter(row => row.documentId === document.id)).toEqual([])
    expect(store.audits).toEqual([{
      action: 'documents.copied',
      actor: { type: 'user', id: ALICE },
      target: { type: 'document', id: copy.id },
      origin: HTTP_ORIGIN,
      details: { sourceId: document.id, sourceSpaceId: ALICE_SPACE, spaceId: ALICE_SPACE, folderId: null },
    }])
  })

  it('复制到别的空间的文件夹里；标题可以指定', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const { document } = seed(store)
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const copy = await service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: folder.id, title: '周报（存档）', requestId: nextRequestId() }, HTTP_ORIGIN)
    expect(copy).toMatchObject({ title: '周报（存档）', spaceId: TEAM_SPACE, folderId: folder.id, space: { id: TEAM_SPACE, name: '市场部' } })
    expect(copy.permissions).toEqual({ canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true })
  })

  it('取锁的顺序：requestId 的锁最前，然后目标空间的树锁与空间行；不锁源文档', async () => {
    const { store, service } = setup()
    const { document } = seed(store)
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    await service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN)
    expect(store.treeLocks).toEqual([[TEAM_SPACE]])
    const request = store.repositories.revisions.lockCreateRequest.mock.invocationCallOrder[0] ?? 0
    const tree = store.tree.lock.mock.invocationCallOrder[0] ?? 0
    expect(request).toBeLessThan(tree)
    expect(tree).toBeLessThan(store.spaces.holdSpace.mock.invocationCallOrder[0] ?? 0)
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
  })

  it('查看者也能复制（能读就能复制），归档空间里的文档同样', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    store.space(TEAM_SPACE).status = 'archived'
    const { document, snapshot } = seed(store, { spaceId: TEAM_SPACE })
    const copy = await service.copy(member(ALICE), document.id, { spaceId: ALICE_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN)
    expect(copy.spaceId).toBe(ALICE_SPACE)
    expect(store.contentOf(copy.id)).toBe(snapshot)
  })

  it('看不到源文档、源文档不存在：同一个 NOT_FOUND，什么也不写', async () => {
    const { store, service } = setup()
    const { document } = seed(store, { spaceId: BOB_SPACE })
    const unseen = await errorOf(service.copy(member(ALICE), document.id, { spaceId: ALICE_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN))
    const missing = await errorOf(service.copy(member(ALICE), MISSING_ID, { spaceId: ALICE_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)
    expect(store.documents.size).toBe(1)
    expect(store.treeLocks).toEqual([])
  })

  it('目标空间看不到：NOT_FOUND；已归档：SPACE_ARCHIVED；只能查看：PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    const { document } = seed(store)
    expect((await errorOf(service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN))).code).toBe('NOT_FOUND')

    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await errorOf(service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN))).code).toBe('SPACE_ARCHIVED')

    store.space(TEAM_SPACE).status = 'active'
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const denied = await errorOf(service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '没有在目标空间里新建的权限'])
    expect(store.documents.size).toBe(1)
  })

  it('目标文件夹在别的空间里、不存在：都是 NOT_FOUND，什么也不写', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const { document } = seed(store)
    const elsewhere = store.addFolder({ spaceId: ALICE_SPACE, name: '私人资料' })
    const foreign = await errorOf(service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: elsewhere.id, requestId: nextRequestId() }, HTTP_ORIGIN))
    const missing = await errorOf(service.copy(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: MISSING_ID, requestId: nextRequestId() }, HTTP_ORIGIN))
    expect([foreign.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(store.documents.size).toBe(1)
  })

  it('同一个 requestId 重发：返回同一份副本、不再复制；换了目标是另一个请求，拒绝', async () => {
    const { store, service } = setup()
    const { document } = seed(store)
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const requestId = nextRequestId()
    const command = { spaceId: ALICE_SPACE, requestId }
    const first = await service.copy(member(ALICE), document.id, command, HTTP_ORIGIN)
    expect(await service.copy(member(ALICE), document.id, command, HTTP_ORIGIN)).toEqual(first)
    expect(store.documents.size).toBe(2)
    // 重放不再记审计
    expect(store.audits).toHaveLength(1)

    for (const other of [{ ...command, spaceId: TEAM_SPACE }, { ...command, title: '另一个标题' }]) {
      const conflict = await errorOf(service.copy(member(ALICE), document.id, other, HTTP_ORIGIN))
      expect(conflict.code).toBe('REQUEST_ID_CONFLICT')
    }
    // 别人拿同一个 requestId 也拒绝（不透露那份副本的任何信息）
    expect((await errorOf(service.copy(member(BOB), document.id, command, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.documents.size).toBe(2)
  })

  it('源文档改名之后重发同一个 requestId：仍然按重放处理（摘要只按请求里的东西算）', async () => {
    const { store, service } = setup()
    const { document } = seed(store)
    const command = { spaceId: ALICE_SPACE, requestId: nextRequestId() }
    const first = await service.copy(member(ALICE), document.id, command, HTTP_ORIGIN)
    store.documents.set(document.id, { ...document, title: '月报' })
    expect(await service.copy(member(ALICE), document.id, command, HTTP_ORIGIN)).toEqual(first)
    expect(store.documents.size).toBe(2)
  })
})

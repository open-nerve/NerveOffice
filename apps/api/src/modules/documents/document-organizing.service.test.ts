// 文档的整理（M2-P4 设计 §3.2、§3.4）：改名、空间内移动、跨空间移动的权限、审计、写入代次与取锁的顺序。
// 真实的 SQL（一条 UPDATE、锁）由集成测试用真实数据库覆盖，这里的假仓储只保持同样的语义。
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentOrganizingService } from './document-organizing.service.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'

const MISSING_ID = '0199a2c4-0000-7000-8000-0000000000fd'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, folders, tree, spaces, policy, audit, writeAccess } = store.deps
  return { store, service: new DocumentOrganizingService(transactions, documents, folders, tree, spaces, policy, audit, writeAccess) }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error(`期望抛出 AppError，实际是 ${String(error)}`)
  return error
}

describe('DocumentOrganizingService.update', () => {
  it('改名：记审计，写入代次不变；标题没有变化时不改、不记审计', async () => {
    const { store, service } = setup()
    const document = store.addDocument({ title: '周报' })
    const renamed = await service.update(member(ALICE), document.id, { title: '月报' }, HTTP_ORIGIN)
    expect(renamed.title).toBe('月报')
    expect(store.audits).toEqual([{
      action: 'documents.renamed',
      actor: { type: 'user', id: ALICE },
      target: { type: 'document', id: document.id },
      origin: HTTP_ORIGIN,
      // 只记位置，不记改动前后的标题（M2-P6 复核 M-1）
      details: { spaceId: ALICE_SPACE, folderId: null },
    }])
    expect(store.writeEpochs.get(document.id)).toBeUndefined()

    await service.update(member(ALICE), document.id, { title: '月报' }, HTTP_ORIGIN)
    expect(store.audits).toHaveLength(1)
  })

  it('取锁的顺序：先空间树、再空间行、最后文档行（锁下重新读）', async () => {
    const { store, service } = setup()
    const document = store.addDocument({})
    await service.update(member(ALICE), document.id, { title: '月报' }, HTTP_ORIGIN)
    expect(store.treeLocks).toEqual([[ALICE_SPACE]])
    const tree = store.tree.lock.mock.invocationCallOrder[0] ?? 0
    const space = store.spaces.holdSpace.mock.invocationCallOrder[0] ?? 0
    const row = store.repositories.documents.lockById.mock.invocationCallOrder[0] ?? 0
    expect(tree).toBeLessThan(space)
    expect(space).toBeLessThan(row)
  })

  it('移到同一个空间里的文件夹：记原位置与目标位置，写入代次不变；再移回根目录', async () => {
    const { store, service } = setup()
    const document = store.addDocument({})
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    expect((await service.update(member(ALICE), document.id, { folderId: folder.id }, HTTP_ORIGIN)).folderId).toBe(folder.id)
    expect(store.audits.at(-1)).toMatchObject({
      action: 'documents.moved',
      details: { fromSpaceId: ALICE_SPACE, fromFolderId: null, toSpaceId: ALICE_SPACE, toFolderId: folder.id },
    })
    expect((await service.update(member(ALICE), document.id, { folderId: null }, HTTP_ORIGIN)).folderId).toBeNull()
    expect(store.audits.at(-1)).toMatchObject({ details: { fromFolderId: folder.id, toFolderId: null } })
    expect(store.writeEpochs.get(document.id)).toBeUndefined()
    // 位置没有变化时不改、不记审计
    await service.update(member(ALICE), document.id, { folderId: null }, HTTP_ORIGIN)
    expect(store.audits.filter(event => event.action === 'documents.moved')).toHaveLength(2)
  })

  it('目标文件夹在别的空间里、已经不在了、不存在：都是 NOT_FOUND，什么也不改', async () => {
    const { store, service } = setup()
    const document = store.addDocument({})
    const elsewhere = store.addFolder({ spaceId: BOB_SPACE, name: '鲍勃的资料' })
    const foreign = await errorOf(service.update(member(ALICE), document.id, { folderId: elsewhere.id }, HTTP_ORIGIN))
    const missing = await errorOf(service.update(member(ALICE), document.id, { folderId: MISSING_ID }, HTTP_ORIGIN))
    expect([foreign.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(foreign.message).toBe(missing.message)
    expect(store.documents.get(document.id)?.folderId).toBeNull()
    expect(store.audits).toEqual([])
  })

  it('两项都给：一次判断两项权限，改名与移动各记一条审计', async () => {
    const { store, service } = setup()
    const document = store.addDocument({})
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const updated = await service.update(member(ALICE), document.id, { title: '月报', folderId: folder.id }, HTTP_ORIGIN)
    expect(updated).toMatchObject({ title: '月报', folderId: folder.id })
    expect(store.audits.map(event => event.action)).toEqual(['documents.renamed', 'documents.moved'])
  })

  it('查看者不能改名、不能移动，而且不取锁；看不到的与不存在的都是 NOT_FOUND', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const document = store.addDocument({ spaceId: TEAM_SPACE })
    const rename = await errorOf(service.update(member(BOB), document.id, { title: '月报' }, HTTP_ORIGIN))
    expect([rename.code, rename.message]).toEqual(['PERMISSION_DENIED', '没有给这份文档改名的权限'])
    const move = await errorOf(service.update(member(BOB), document.id, { folderId: null }, HTTP_ORIGIN))
    expect([move.code, move.message]).toEqual(['PERMISSION_DENIED', '没有移动这份文档的权限'])
    expect(store.treeLocks).toEqual([])

    const unseen = await errorOf(service.update(member(ALICE), document.id, { title: '月报' }, HTTP_ORIGIN))
    const missing = await errorOf(service.update(member(ALICE), MISSING_ID, { title: '月报' }, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)
    expect(store.treeLocks).toEqual([])
  })

  it('归档的空间：成员至多是查看者，改名与移动都被拒绝，说明空间已归档', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    const document = store.addDocument({ spaceId: TEAM_SPACE })
    const error = await errorOf(service.update(member(ALICE), document.id, { title: '月报' }, HTTP_ORIGIN))
    expect([error.code, error.message]).toEqual(['PERMISSION_DENIED', '空间已归档，只能查看'])
  })
})

describe('DocumentOrganizingService.move', () => {
  it('跨空间移动：改空间与位置、写入代次加一、收回写入权，审计带两边的位置；响应按新空间给权限', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const document = store.addDocument({ title: '周报' })
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const moved = await service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: folder.id }, HTTP_ORIGIN)
    expect(moved).toMatchObject({ spaceId: TEAM_SPACE, folderId: folder.id, space: { id: TEAM_SPACE, name: '市场部' } })
    // 到了新空间只是编辑者：不能再把它移走
    expect(moved.permissions).toEqual({ canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true })
    expect(store.writeEpochs.get(document.id)).toBe(1)
    expect(store.revocations).toEqual([{ kind: 'documents', documentIds: [document.id] }])
    expect(store.audits).toEqual([{
      action: 'documents.moved',
      actor: { type: 'user', id: ALICE },
      target: { type: 'document', id: document.id },
      origin: HTTP_ORIGIN,
      details: { fromSpaceId: ALICE_SPACE, fromFolderId: null, toSpaceId: TEAM_SPACE, toFolderId: folder.id },
    }])
  })

  it('两个空间的树锁一次取（顺序由 SpaceTreeRepository 定），空间行按 id 排序取', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const document = store.addDocument({})
    await service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN)
    expect(store.treeLocks).toEqual([[ALICE_SPACE, TEAM_SPACE]])
    expect(store.spaces.holdSpace.mock.calls.map(call => call[0])).toEqual([ALICE_SPACE, TEAM_SPACE].toSorted())
  })

  it('要源空间的空间管理员：编辑者不行；不能做的请求不取锁', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const document = store.addDocument({ spaceId: TEAM_SPACE })
    const error = await errorOf(service.move(member(ALICE), document.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    expect([error.code, error.message]).toEqual(['PERMISSION_DENIED', '只有空间管理员能把文档移出这个空间'])
    expect(store.treeLocks).toEqual([])
    expect(store.writeEpochs.size).toBe(0)

    store.setMember(TEAM_SPACE, ALICE, 'admin')
    expect((await service.move(member(ALICE), document.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN)).spaceId).toBe(ALICE_SPACE)
  })

  it('目标空间看不到、不存在：NOT_FOUND；已归档：SPACE_ARCHIVED；只能查看：PERMISSION_DENIED', async () => {
    const { store, service } = setup()
    const document = store.addDocument({})
    const unseen = await errorOf(service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN))
    const missing = await errorOf(service.move(member(ALICE), document.id, { spaceId: MISSING_ID }, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)

    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await errorOf(service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN))).code).toBe('SPACE_ARCHIVED')

    store.space(TEAM_SPACE).status = 'active'
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    const denied = await errorOf(service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE }, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '没有在目标空间里新建的权限'])
    expect(store.documents.get(document.id)?.spaceId).toBe(ALICE_SPACE)
  })

  it('目标就是现在所在的空间：按空间内移动处理（编辑者就行，代次不变，不收回写入权）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const document = store.addDocument({ spaceId: TEAM_SPACE })
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const moved = await service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: folder.id }, HTTP_ORIGIN)
    expect(moved.folderId).toBe(folder.id)
    expect(store.writeEpochs.size).toBe(0)
    expect(store.revocations).toEqual([])
    expect(store.treeLocks).toEqual([[TEAM_SPACE]])
    // 移动成功之后重试同一个请求：没有变化，不再记审计、不再递增代次
    await service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: folder.id }, HTTP_ORIGIN)
    expect(store.audits).toHaveLength(1)
    expect(store.writeEpochs.size).toBe(0)
  })

  it('目标文件夹在别的空间里：NOT_FOUND，不移动', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const document = store.addDocument({})
    const elsewhere = store.addFolder({ spaceId: ALICE_SPACE, name: '私人资料' })
    expect((await errorOf(service.move(member(ALICE), document.id, { spaceId: TEAM_SPACE, folderId: elsewhere.id }, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.documents.get(document.id)?.spaceId).toBe(ALICE_SPACE)
    expect(store.writeEpochs.size).toBe(0)
  })

  it('源空间已归档：所有人至多是查看者，移不走', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    const document = store.addDocument({ spaceId: TEAM_SPACE })
    const error = await errorOf(service.move(member(ALICE), document.id, { spaceId: ALICE_SPACE }, HTTP_ORIGIN))
    expect([error.code, error.message]).toEqual(['PERMISSION_DENIED', '空间已归档，只能查看'])
  })
})

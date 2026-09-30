import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'
import { createdPayloadDigest } from './payload-digest.ts'

const REQUEST_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const MISSING_ID = '0199a2c4-0000-7000-8000-0000000000fe'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, contents, revisions, folders, tree, spaces, policy, audit } = store.deps
  const service = new DocumentCreationService(transactions, documents, contents, revisions, folders, tree, spaces, policy, audit)
  return { store, service }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentCreationService.create', () => {
  it('在个人空间里新建：模板快照换上新的 unitId，修订号 1，档案、格式与 SDK 版本，写修订记录与审计', async () => {
    const { store, service } = setup()
    const detail = await service.create(member(ALICE), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)

    expect(detail).toMatchObject({ title: '周报', type: 'sheet', spaceId: ALICE_SPACE, space: { id: ALICE_SPACE, type: 'personal' }, revision: 1, profile: 'sheet@1', formatVersion: 1, permissions: { canEdit: true } })
    expect(store.repositories.documents.insert).toHaveBeenCalledWith(expect.objectContaining({ createdBy: ALICE, profile: 'sheet@1', formatVersion: 1, sdkVersion: UNIVER_SDK_VERSION }), expect.anything())
    const row = store.documents.get(detail.id)
    expect(row?.unitId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    const stored = store.contents.get(detail.id)
    const raw = zlib.gunzipSync(stored?.snapshot ?? Buffer.alloc(0)).toString('utf8')
    expect(raw).toBe(sheetSnapshotFor(row?.unitId ?? ''))
    expect(stored?.rawBytes).toBe(Buffer.byteLength(raw))

    expect(store.revisions).toEqual([expect.objectContaining({ documentId: detail.id, revision: 1, kind: 'created', requestId: REQUEST_ID, source: null, savedBy: ALICE })])
    expect(store.revisions[0]?.payloadDigest).toEqual(createdPayloadDigest('sheet', '周报'))
    expect(store.audits).toEqual([{ action: 'documents.created', actor: { type: 'user', id: ALICE }, target: { type: 'document', id: detail.id }, origin: HTTP_ORIGIN, details: { revision: 1, folderId: null } }])
  })

  it('没有标题用默认标题；每份文档的 unitId 各不相同', async () => {
    const { store, service } = setup()
    const first = await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const second = await service.create(member(ALICE), { type: 'sheet', requestId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0e' }, HTTP_ORIGIN)
    expect(first.title).toBe('未命名表格')
    expect(store.documents.get(first.id)?.unitId).not.toBe(store.documents.get(second.id)?.unitId)
  })

  it('先按 requestId 排队，再查修订记录', async () => {
    const { store, service } = setup()
    await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const lock = store.repositories.revisions.lockCreateRequest.mock.invocationCallOrder[0] ?? Number.NaN
    const lookup = store.repositories.revisions.findByRequestId.mock.invocationCallOrder[0] ?? Number.NaN
    expect(store.repositories.revisions.lockCreateRequest).toHaveBeenCalledWith(REQUEST_ID, expect.anything())
    expect(lock).toBeLessThan(lookup)
  })

  it('同一个请求重放：返回同一份文档的当前元数据，不再新建', async () => {
    const { store, service } = setup()
    const first = await service.create(member(ALICE), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const current = store.documents.get(first.id)
    if (current !== undefined)
      store.documents.set(first.id, { ...current, revision: 4 })
    const again = await service.create(member(ALICE), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    expect(again).toEqual({ ...first, revision: 4 })
    expect(store.documents.size).toBe(1)
    expect(store.audits).toHaveLength(1)
  })

  it('同一个 requestId、不同的负载：REQUEST_ID_CONFLICT', async () => {
    const { service } = setup()
    await service.create(member(ALICE), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', title: '月报', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('别人用过的 requestId：REQUEST_ID_CONFLICT，不透露那份文档', async () => {
    const { service } = setup()
    await service.create(member(ALICE), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const error = await rejection(service.create(member(BOB), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN))
    expect(error.code).toBe('REQUEST_ID_CONFLICT')
    expect(error.details).toBeUndefined()
  })

  it('用于保存的 requestId：REQUEST_ID_CONFLICT', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.addRevision({ documentId: document.id, revision: 2, kind: 'saved', requestId: REQUEST_ID, payloadDigest: createdPayloadDigest('sheet', '未命名表格'), source: { clientInstanceId: REQUEST_ID, localSeq: 1 }, savedBy: ALICE })
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('重放时已经不能访问那份文档：REQUEST_ID_CONFLICT', async () => {
    const { store, service } = setup()
    const created = await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    const row = store.documents.get(created.id)
    if (row !== undefined)
      store.documents.set(created.id, { ...row, spaceId: BOB_SPACE })
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('写修订记录时 requestId 刚被一次保存用掉：REQUEST_ID_CONFLICT（事务回滚）', async () => {
    const { store, service } = setup()
    store.repositories.revisions.insert.mockResolvedValueOnce(undefined)
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.audits).toHaveLength(0)
  })

  it('在团队空间里新建：编辑者及以上可以；返回的权限按有效角色；负载摘要带上空间', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    const detail = await service.create(member(BOB), { type: 'sheet', title: '周报', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN)
    expect(detail).toMatchObject({ spaceId: TEAM_SPACE, space: { id: TEAM_SPACE, type: 'team', name: '市场部' }, permissions: { canEdit: true } })
    expect(store.revisions[0]?.payloadDigest).toEqual(createdPayloadDigest('sheet', '周报', TEAM_SPACE))
    // 同一个请求重放：同样带着空间，摘要相同
    expect(await service.create(member(BOB), { type: 'sheet', title: '周报', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN)).toEqual(detail)
    // 同一个 requestId 换一个空间：不是同一个请求
    expect((await rejection(service.create(member(BOB), { type: 'sheet', title: '周报', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('查看者与归档的空间：PERMISSION_DENIED；看不到与不存在的空间：同一个 NOT_FOUND；都不取空间的锁、不新建', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await rejection(service.create(member(BOB), { type: 'sheet', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED' })
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await rejection(service.create(member(BOB), { type: 'sheet', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })

    store.spaces.accessFactsOf.mockClear()
    const forbidden = await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, spaceId: BOB_SPACE }, HTTP_ORIGIN))
    const missing = await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, spaceId: '0199a2c4-0000-7000-8000-0000000000ff' }, HTTP_ORIGIN))
    expect([forbidden.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(2)
    expect(store.spaces.holdSpace).not.toHaveBeenCalled()
    expect(store.documents.size).toBe(0)
  })

  it('没有加入的系统管理员不能在团队空间里新建：系统角色不带来内容权限', async () => {
    const { service } = setup()
    const error = await rejection(service.create({ userId: ALICE, systemAdmin: true }, { type: 'sheet', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN))
    expect(error.code).toBe('NOT_FOUND')
  })

  it('先判断、再对空间行取共享锁、锁下再判断：锁下发现已被移出，NOT_FOUND，不新建', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    store.spaces.holdSpace.mockImplementationOnce(async () => {
      store.setMember(TEAM_SPACE, BOB, undefined)
    })
    expect((await rejection(service.create(member(BOB), { type: 'sheet', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    const [checked, rechecked] = store.spaces.accessFactsOf.mock.invocationCallOrder
    const locked = store.spaces.holdSpace.mock.invocationCallOrder[0] ?? Number.NaN
    expect(checked).toBeLessThan(locked)
    expect(locked).toBeLessThan(rechecked ?? Number.NaN)
    expect(store.spaces.holdSpace).toHaveBeenCalledWith(TEAM_SPACE, expect.anything())
    expect(store.documents.size).toBe(0)
  })

  it('没有个人空间是数据不一致：意外错误', async () => {
    const { store, service } = setup()
    store.spaces.personalSpaceOf.mockResolvedValueOnce(undefined)
    await expect(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)).rejects.toThrow('账户没有个人空间')
  })
})

describe('DocumentCreationService.create 的目标文件夹（M2-P4）', () => {
  it('建在指定的文件夹里：文档落在那一层，审计与负载摘要都带上它', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const detail = await service.create(member(ALICE), { type: 'sheet', title: '周报', requestId: REQUEST_ID, folderId: folder.id }, HTTP_ORIGIN)

    expect(detail).toMatchObject({ spaceId: ALICE_SPACE, folderId: folder.id })
    expect(store.documents.get(detail.id)?.folderId).toBe(folder.id)
    expect(store.revisions[0]?.payloadDigest).toEqual(createdPayloadDigest('sheet', '周报', undefined, folder.id))
    expect(store.audits[0]?.details).toEqual({ revision: 1, folderId: folder.id })
  })

  it('指定了文件夹才取空间树的锁：排在 requestId 的锁之后、空间行之前，目标文件夹在锁下判断', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE })
    await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: folder.id }, HTTP_ORIGIN)

    expect(store.treeLocks).toEqual([[ALICE_SPACE]])
    const request = store.repositories.revisions.lockCreateRequest.mock.invocationCallOrder[0] ?? Number.NaN
    const tree = store.tree.lock.mock.invocationCallOrder[0] ?? Number.NaN
    const held = store.spaces.holdSpace.mock.invocationCallOrder[0] ?? Number.NaN
    const checked = store.repositories.folders.findById.mock.invocationCallOrder[0] ?? Number.NaN
    expect(request).toBeLessThan(tree)
    expect(tree).toBeLessThan(held)
    expect(held).toBeLessThan(checked)
  })

  it('没有指定文件夹：建在空间的根目录，不取树锁、不查文件夹（保持 M2-P4 之前的开销）', async () => {
    const { store, service } = setup()
    const detail = await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN)
    expect(detail.folderId).toBeNull()
    expect(store.treeLocks).toEqual([])
    expect(store.repositories.folders.findById).not.toHaveBeenCalled()
  })

  it('目标文件夹不存在、在别的空间里、在回收站里：同一个 NOT_FOUND，什么也不建', async () => {
    const { store, service } = setup()
    const elsewhere = store.addFolder({ spaceId: BOB_SPACE })
    const trashed = store.addFolder({ spaceId: ALICE_SPACE })
    store.folderEntries.set(trashed.id, 'trash-entry')

    const missing = await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: MISSING_ID }, HTTP_ORIGIN))
    const foreign = await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: elsewhere.id }, HTTP_ORIGIN))
    const removed = await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: trashed.id }, HTTP_ORIGIN))
    expect([missing.code, foreign.code, removed.code]).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'])
    expect([foreign.message, removed.message]).toEqual([missing.message, missing.message])
    expect(store.documents.size).toBe(0)
    expect(store.audits).toEqual([])
  })

  it('取锁之前文件夹还在、锁下已经进了回收站：NOT_FOUND，不会把活文档挂在回收站的文件夹下', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE })
    // 树锁排在判断之前：拿到锁时删除已经提交，锁下读到的就是回收站里的它
    store.tree.lock.mockImplementationOnce(async () => {
      store.folderEntries.set(folder.id, 'trash-entry')
    })
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: folder.id }, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect(store.documents.size).toBe(0)
  })

  it('重放的比较把文件夹算进去：同一个文件夹返回同一份，换一个文件夹或改成根目录都是 REQUEST_ID_CONFLICT', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE })
    const another = store.addFolder({ spaceId: ALICE_SPACE, name: '存档' })
    const first = await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: folder.id }, HTTP_ORIGIN)

    expect(await service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: folder.id }, HTTP_ORIGIN)).toEqual(first)
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID, folderId: another.id }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect((await rejection(service.create(member(ALICE), { type: 'sheet', requestId: REQUEST_ID }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
    expect(store.documents.size).toBe(1)
  })

  it('指定了空间与文件夹：两段都进摘要，只换空间或只换文件夹都不是同一个请求', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    const folder = store.addFolder({ spaceId: TEAM_SPACE })
    const detail = await service.create(member(BOB), { type: 'sheet', title: '周报', requestId: REQUEST_ID, spaceId: TEAM_SPACE, folderId: folder.id }, HTTP_ORIGIN)
    expect(detail).toMatchObject({ spaceId: TEAM_SPACE, folderId: folder.id })
    expect(store.revisions[0]?.payloadDigest).toEqual(createdPayloadDigest('sheet', '周报', TEAM_SPACE, folder.id))
    expect((await rejection(service.create(member(BOB), { type: 'sheet', title: '周报', requestId: REQUEST_ID, spaceId: TEAM_SPACE }, HTTP_ORIGIN))).code).toBe('REQUEST_ID_CONFLICT')
  })
})

import type { DocumentRow } from './documents.repository.ts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { DocumentsService } from './documents.service.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, member, TEAM_SPACE } from './documents.test-support.ts'

const MISSING_SPACE = '0199a2c4-0000-7000-8000-0000000000ff'

function setup() {
  const store = new FakeStore()
  const { documents, folders, spaces, policy } = store.deps
  const service = new DocumentsService(documents, folders, spaces, policy)
  return { store, service }
}

function at(store: FakeStore, spaceId: string, position: string): DocumentRow {
  const time = new Date(position)
  return store.addDocument({ spaceId, createdAt: time, updatedAt: time, position, revision: 3 })
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError')
  return error
}

describe('DocumentsService.get', () => {
  it('自己的文档：返回元数据、所在的空间与编辑权限', async () => {
    const { store, service } = setup()
    const own = at(store, ALICE_SPACE, '2026-09-26T10:00:00.000001Z')
    expect(await service.get(ALICE, own.id)).toEqual({
      id: own.id,
      title: own.title,
      type: 'sheet',
      createdAt: own.createdAt.toISOString(),
      updatedAt: own.updatedAt.toISOString(),
      spaceId: ALICE_SPACE,
      space: { id: ALICE_SPACE, type: 'personal', name: '爱丽丝' },
      folderId: null,
      revision: 3,
      profile: 'sheet@1',
      formatVersion: 1,
      permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true },
    })
  })

  it('别人的与不存在的：同一个 NOT_FOUND，而且都执行了一次空间事实的查询（两条路径做同样的查询）', async () => {
    const { store, service } = setup()
    const others = at(store, BOB_SPACE, '2026-09-26T10:00:00.000002Z')
    const forbidden = await errorOf(service.get(ALICE, others.id))
    const missing = await errorOf(service.get(ALICE, '0199a2c4-0000-7000-8000-0000000000fe'))
    expect([forbidden.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(missing.message).toBe(forbidden.message)
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(2)
    expect(store.spaces.accessFactsOf).toHaveBeenLastCalledWith(ALICE, '00000000-0000-0000-0000-000000000000', { transaction: undefined })
  })

  it('团队空间的查看者不能编辑；全员可见的空间里任何人都是查看者', async () => {
    const { store, service } = setup()
    const document = at(store, TEAM_SPACE, '2026-09-26T10:00:00.000003Z')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await service.get(BOB, document.id)).toMatchObject({ space: { id: TEAM_SPACE, type: 'team', name: '市场部' }, permissions: { canEdit: false } })
    expect((await errorOf(service.get(ALICE, document.id))).code).toBe('NOT_FOUND')
    store.space(TEAM_SPACE).visibleToAll = true
    // 看得到就能复制（目标空间的新建权限另判）；查看者不能改名、不能移动、不能删除
    expect((await service.get(ALICE, document.id)).permissions).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false })
  })
})

describe('DocumentsService.list', () => {
  it('没有指定空间：个人空间（M1 兼容）；多取一条判断下一页，游标是本页最后一条的位置', async () => {
    const { store, service } = setup()
    const older = at(store, ALICE_SPACE, '2026-09-26T10:00:00.000001Z')
    const newer = at(store, ALICE_SPACE, '2026-09-26T11:00:00.000003Z')
    store.repositories.documents.listAccessible.mockImplementation(async (_scope, options) => [newer, older].slice(0, options.limit))
    const page = await service.list(member(ALICE), { limit: 1 })
    // 没有指定目录：空间的根目录（folderId 为 null）；状态是正常（M2-P4 设计 §3.4 第 1 条）
    expect(store.repositories.documents.listAccessible).toHaveBeenCalledWith({ spaceIds: [ALICE_SPACE] }, { limit: 2, after: undefined, folderId: null })
    expect(page.items.map(item => item.id)).toEqual([newer.id])
    expect(decodeTimeCursor(page.nextCursor ?? '')).toEqual({ position: newer.position, id: newer.id })

    const last = await service.list(member(ALICE), { limit: 5, cursor: page.nextCursor ?? '' })
    expect(store.repositories.documents.listAccessible).toHaveBeenLastCalledWith({ spaceIds: [ALICE_SPACE] }, { limit: 6, after: { position: newer.position, id: newer.id }, folderId: null })
    expect(last.nextCursor).toBeNull()
  })

  it('指定了团队空间：成员与全员可见时的任何人都能列出；看不到与不存在的空间同一个 NOT_FOUND，查询相同', async () => {
    const { store, service } = setup()
    at(store, TEAM_SPACE, '2026-09-26T10:00:00.000001Z')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await service.list(member(BOB), { spaceId: TEAM_SPACE, limit: 10 })).items).toHaveLength(1)

    store.spaces.accessFactsOf.mockClear()
    const forbidden = await errorOf(service.list(member(ALICE), { spaceId: TEAM_SPACE, limit: 10 }))
    const missing = await errorOf(service.list(member(ALICE), { spaceId: MISSING_SPACE, limit: 10 }))
    expect([forbidden.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(store.spaces.accessFactsOf.mock.calls).toEqual([[ALICE, TEAM_SPACE, { transaction: undefined }], [ALICE, MISSING_SPACE, { transaction: undefined }]])

    store.space(TEAM_SPACE).visibleToAll = true
    expect((await service.list(member(ALICE), { spaceId: TEAM_SPACE, limit: 10 })).items).toHaveLength(1)
  })

  it('别人的个人空间：NOT_FOUND；系统管理员也一样（系统角色不带来内容权限）', async () => {
    const { store, service } = setup()
    at(store, BOB_SPACE, '2026-09-26T10:00:00.000001Z')
    for (const actor of [member(ALICE), { userId: ALICE, systemAdmin: true }])
      expect((await errorOf(service.list(actor, { spaceId: BOB_SPACE, limit: 10 }))).code).toBe('NOT_FOUND')
    expect((await errorOf(service.list({ userId: ALICE, systemAdmin: true }, { spaceId: TEAM_SPACE, limit: 10 }))).code).toBe('NOT_FOUND')
    expect(store.repositories.documents.listAccessible).not.toHaveBeenCalled()
  })

  it('游标不合法（改过、时间不存在）：REQUEST_INVALID，不查询', async () => {
    const { store, service } = setup()
    const own = at(store, ALICE_SPACE, '2026-09-26T10:00:00.000001Z')
    for (const cursor of ['broken', encodeTimeCursor({ position: '2026-02-30T00:00:00.000000Z', id: own.id })]) {
      const error = await errorOf(service.list(member(ALICE), { limit: 10, cursor }))
      expect(error.code, cursor).toBe('REQUEST_INVALID')
    }
    expect(store.repositories.documents.listAccessible).not.toHaveBeenCalled()
  })

  it('账户没有个人空间说明数据不一致：按意外错误处理', async () => {
    const { store, service } = setup()
    store.spaces.personalSpaceOf.mockResolvedValueOnce(undefined)
    await expect(service.list(member(ALICE), { limit: 10 })).rejects.toThrow(/没有个人空间/)
  })
})

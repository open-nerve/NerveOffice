import type { SpacesService } from '../spaces/index.ts'
import type { AccessTarget, DocumentAccess } from './document-access-policy.ts'
import type { DocumentRow, DocumentsRepository } from './documents.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeCursor, encodeCursor } from './document-cursor.ts'
import { DocumentsService } from './documents.service.ts'

const ALICE = '0199a2c4-0000-7000-8000-00000000000a'
const ALICE_SPACE = '0199a2c4-0000-7000-8000-0000000000a1'
const BOB_SPACE = '0199a2c4-0000-7000-8000-0000000000b1'

function row(id: string, spaceId: string, position: string): DocumentRow {
  const time = new Date(position)
  return { id, spaceId, type: 'sheet', title: `文档 ${id.slice(-2)}`, createdAt: time, updatedAt: time, position }
}

const OWN = row('0199a2c4-0000-7000-8000-0000000000d1', ALICE_SPACE, '2026-09-26T10:00:00.000001Z')
const OTHERS = row('0199a2c4-0000-7000-8000-0000000000d2', BOB_SPACE, '2026-09-26T10:00:00.000002Z')

function setup(rows: DocumentRow[]) {
  const repository = {
    findById: vi.fn(async (id: string) => rows.find(candidate => candidate.id === id)),
    listInSpace: vi.fn(async (spaceId: string, limit: number) => rows.filter(candidate => candidate.spaceId === spaceId).slice(0, limit)),
  }
  const spaces = { personalSpaceOf: vi.fn(async (_userId: string): Promise<{ id: string, name: string } | undefined> => ({ id: ALICE_SPACE, name: '爱丽丝' })) }
  const policy = { accessOf: vi.fn(async (userId: string, target: AccessTarget): Promise<DocumentAccess | undefined> => (userId === ALICE && target.spaceId === ALICE_SPACE ? 'owner' : undefined)) }
  const service = new DocumentsService(repository as unknown as DocumentsRepository, spaces as unknown as SpacesService, policy)
  return { service, repository, spaces, policy }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError')
  return error
}

describe('DocumentsService.get', () => {
  it('自己的文档：返回元数据与编辑权限', async () => {
    const { service } = setup([OWN])
    expect(await service.get(ALICE, OWN.id)).toEqual({
      id: OWN.id,
      title: OWN.title,
      type: 'sheet',
      createdAt: OWN.createdAt.toISOString(),
      updatedAt: OWN.updatedAt.toISOString(),
      spaceId: ALICE_SPACE,
      permissions: { canEdit: true },
    })
  })

  it('别人的与不存在的：同一个 NOT_FOUND，而且都判断了一次权限（两条路径做同样的查询）', async () => {
    const { service, policy } = setup([OWN, OTHERS])
    const forbidden = await errorOf(service.get(ALICE, OTHERS.id))
    const missing = await errorOf(service.get(ALICE, '0199a2c4-0000-7000-8000-0000000000ff'))
    expect([forbidden.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(missing.message).toBe(forbidden.message)
    expect(policy.accessOf).toHaveBeenCalledTimes(2)
    expect(policy.accessOf).toHaveBeenLastCalledWith(ALICE, { spaceId: '00000000-0000-0000-0000-000000000000' })
  })

  it('查看者不能编辑', async () => {
    const { service, policy } = setup([OWN])
    policy.accessOf.mockResolvedValueOnce('viewer')
    expect((await service.get(ALICE, OWN.id)).permissions).toEqual({ canEdit: false })
  })
})

describe('DocumentsService.listPersonal', () => {
  it('多取一条判断下一页；游标是本页最后一条的位置', async () => {
    const newer = row('0199a2c4-0000-7000-8000-0000000000d3', ALICE_SPACE, '2026-09-26T11:00:00.000003Z')
    const { service, repository } = setup([newer, OWN])
    const page = await service.listPersonal(ALICE, { limit: 1 })
    expect(repository.listInSpace).toHaveBeenCalledWith(ALICE_SPACE, 2, undefined)
    expect(page.items.map(item => item.id)).toEqual([newer.id])
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({ updatedAt: newer.position, id: newer.id })

    const last = await service.listPersonal(ALICE, { limit: 5, cursor: page.nextCursor ?? '' })
    expect(repository.listInSpace).toHaveBeenLastCalledWith(ALICE_SPACE, 6, { updatedAt: newer.position, id: newer.id })
    expect(last.nextCursor).toBeNull()
  })

  it('游标不合法（改过、时间不存在）：REQUEST_INVALID，不查询', async () => {
    const { service, repository } = setup([OWN])
    for (const cursor of ['broken', encodeCursor({ updatedAt: '2026-02-30T00:00:00.000000Z', id: OWN.id })]) {
      const error = await errorOf(service.listPersonal(ALICE, { limit: 10, cursor }))
      expect(error.code, cursor).toBe('REQUEST_INVALID')
    }
    expect(repository.listInSpace).not.toHaveBeenCalled()
  })

  it('账户没有个人空间说明数据不一致：按意外错误处理', async () => {
    const { service, spaces } = setup([])
    spaces.personalSpaceOf.mockResolvedValueOnce(undefined)
    await expect(service.listPersonal(ALICE, { limit: 10 })).rejects.toThrow(/没有个人空间/)
  })
})

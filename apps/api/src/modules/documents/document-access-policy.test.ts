import type { SpacesService } from '../spaces/index.ts'
import type { DocumentAccessPolicy } from './document-access-policy.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { canEdit, PersonalSpaceAccessPolicy, requireAccess } from './document-access-policy.ts'

describe('PersonalSpaceAccessPolicy（M1 的规则）', () => {
  it('文档在自己的个人空间里：所有者；否则没有任何权限', async () => {
    const spaces = { isOwner: vi.fn(async (userId: string, spaceId: string) => userId === 'alice' && spaceId === 'space-a') }
    const policy = new PersonalSpaceAccessPolicy(spaces as unknown as SpacesService)
    expect(await policy.accessOf('alice', { spaceId: 'space-a' })).toBe('owner')
    expect(await policy.accessOf('bob', { spaceId: 'space-a' })).toBeUndefined()
    expect(await policy.accessOf('alice', { spaceId: 'space-b' })).toBeUndefined()
  })

  it('在事务里判断时，查询走同一个事务', async () => {
    const spaces = { isOwner: vi.fn(async () => true) }
    const policy = new PersonalSpaceAccessPolicy(spaces as unknown as SpacesService)
    const transaction = {} as never
    await policy.accessOf('alice', { spaceId: 'space-a' }, transaction)
    expect(spaces.isOwner).toHaveBeenCalledWith('alice', 'space-a', { transaction })
  })
})

describe('requireAccess', () => {
  const policy = { accessOf: vi.fn(async (userId: string, target: { spaceId: string }) => (userId === 'alice' && target.spaceId === 'space-a' ? 'owner' as const : undefined)) }

  it('能访问：文档与权限', async () => {
    const document = { spaceId: 'space-a', id: 'd1' }
    expect(await requireAccess(policy as DocumentAccessPolicy, 'alice', document)).toEqual({ document, access: 'owner' })
  })

  it('别人的与不存在的：同一个 NOT_FOUND，不存在时也判断一次权限', async () => {
    policy.accessOf.mockClear()
    const others = await requireAccess(policy as DocumentAccessPolicy, 'alice', { spaceId: 'space-b' }).catch((error: unknown) => error)
    const missing = await requireAccess(policy as DocumentAccessPolicy, 'alice', undefined).catch((error: unknown) => error)
    for (const error of [others, missing])
      expect(error).toMatchObject({ code: 'NOT_FOUND' })
    expect(others).toBeInstanceOf(AppError)
    expect(policy.accessOf).toHaveBeenCalledTimes(2)
  })

  it('查看者不能编辑，所有者与编辑者可以', () => {
    expect([canEdit('owner'), canEdit('editor'), canEdit('viewer')]).toEqual([true, true, false])
  })
})

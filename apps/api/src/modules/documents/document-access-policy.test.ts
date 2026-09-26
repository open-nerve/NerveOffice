import type { SpacesService } from '../spaces/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { PersonalSpaceAccessPolicy } from './document-access-policy.ts'

describe('PersonalSpaceAccessPolicy（M1 的规则）', () => {
  it('文档在自己的个人空间里：所有者；否则没有任何权限', async () => {
    const spaces = { isOwner: vi.fn(async (userId: string, spaceId: string) => userId === 'alice' && spaceId === 'space-a') }
    const policy = new PersonalSpaceAccessPolicy(spaces as unknown as SpacesService)
    expect(await policy.accessOf('alice', { spaceId: 'space-a' })).toBe('owner')
    expect(await policy.accessOf('bob', { spaceId: 'space-a' })).toBeUndefined()
    expect(await policy.accessOf('alice', { spaceId: 'space-b' })).toBeUndefined()
  })
})

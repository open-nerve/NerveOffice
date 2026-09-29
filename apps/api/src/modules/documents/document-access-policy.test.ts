import type { Transaction } from '../database/index.ts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { canEdit, requireAccess, requireSpaceContent, requireSpaceManagement } from './document-access-policy.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, member, TEAM_SPACE } from './documents.test-support.ts'

const MISSING = '0199a2c4-0000-7000-8000-0000000000ff'
const ZERO = '00000000-0000-0000-0000-000000000000'
const ADMIN = { userId: ALICE, systemAdmin: true }

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('EffectiveAccessPolicy', () => {
  it('文档：按所在空间的有效角色；每次判断只查一次空间事实，在事务里判断时走同一个事务', async () => {
    const store = new FakeStore()
    const transaction = {} as Transaction
    const access = await store.policy.accessOf(ALICE, { id: 'd1', spaceId: ALICE_SPACE }, transaction)
    expect(access?.role).toBe('admin')
    expect(access?.space).toMatchObject({ id: ALICE_SPACE, type: 'personal' })
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(1)
    expect(store.spaces.accessFactsOf).toHaveBeenCalledWith(ALICE, ALICE_SPACE, { transaction })
    expect(await store.policy.accessOf(BOB, { id: 'd1', spaceId: ALICE_SPACE })).toBeUndefined()
  })

  it('空间：没有角色的看不到；没有加入的系统管理员看得到团队空间的管理面，看不到个人空间', async () => {
    const store = new FakeStore()
    expect(await store.policy.spaceAccessOf(member(ALICE), TEAM_SPACE)).toBeUndefined()
    expect(await store.policy.spaceAccessOf(ADMIN, TEAM_SPACE)).toMatchObject({ role: undefined, permissions: { canCreateDocuments: false, canManageMembers: true } })
    expect(await store.policy.spaceAccessOf(ADMIN, BOB_SPACE)).toBeUndefined()
    expect(await store.policy.spaceAccessOf(ADMIN, MISSING)).toBeUndefined()
  })

  it('我能看到的空间：只有有内容权限的；系统管理员没有加入的团队空间不在里面', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect((await store.policy.visibleSpaces(member(BOB))).map(access => [access.space.id, access.role])).toEqual([[BOB_SPACE, 'admin'], [TEAM_SPACE, 'editor']])
    expect((await store.policy.visibleSpaces(ADMIN)).map(access => access.space.id)).toEqual([ALICE_SPACE])
    store.space(TEAM_SPACE).visibleToAll = true
    expect((await store.policy.visibleSpaces(ADMIN)).map(access => [access.space.id, access.role])).toEqual([[ALICE_SPACE, 'admin'], [TEAM_SPACE, 'viewer']])
  })
})

describe('requireAccess', () => {
  it('能访问：文档与有效角色', async () => {
    const store = new FakeStore()
    const document = { id: 'd1', spaceId: ALICE_SPACE }
    expect(await requireAccess(store.policy, ALICE, document)).toMatchObject({ document, access: { role: 'admin' } })
  })

  it('别人的与不存在的：同一个 NOT_FOUND；不存在时也用全零的空间查一次', async () => {
    const store = new FakeStore()
    const others = await errorOf(requireAccess(store.policy, ALICE, { id: 'd2', spaceId: BOB_SPACE }))
    const missing = await errorOf(requireAccess(store.policy, ALICE, undefined))
    expect([others.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(store.spaces.accessFactsOf.mock.calls.map(call => call[1])).toEqual([BOB_SPACE, ZERO])
  })

  it('查看者不能编辑，编辑者与空间管理员可以', async () => {
    const store = new FakeStore()
    const space = (await store.policy.spaceAccessOf(member(ALICE), ALICE_SPACE))?.space
    if (space === undefined)
      throw new Error('没有空间')
    expect([canEdit({ role: 'admin', space }), canEdit({ role: 'editor', space }), canEdit({ role: 'viewer', space })]).toEqual([true, true, false])
  })
})

describe('requireSpaceContent', () => {
  it('看不到、不存在、没有加入的系统管理员：同一个 NOT_FOUND，查询相同', async () => {
    const store = new FakeStore()
    const errors = [
      await errorOf(requireSpaceContent(store.policy, member(ALICE), TEAM_SPACE, 'view')),
      await errorOf(requireSpaceContent(store.policy, member(ALICE), MISSING, 'view')),
      await errorOf(requireSpaceContent(store.policy, ADMIN, TEAM_SPACE, 'view')),
      await errorOf(requireSpaceContent(store.policy, ADMIN, BOB_SPACE, 'createDocuments')),
    ]
    expect(errors.map(error => [error.code, error.message])).toEqual(Array.from({ length: 4 }, () => ['NOT_FOUND', errors[0]?.message]))
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(4)
  })

  it('查看者能看、不能新建；归档时说明原因', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'view')).toMatchObject({ role: 'viewer' })
    expect(await errorOf(requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '没有在这个空间里新建的权限' })
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect(await requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments')).toMatchObject({ role: 'editor' })
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(requireSpaceContent(store.policy, member(BOB), TEAM_SPACE, 'createDocuments'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
  })
})

describe('requireSpaceManagement', () => {
  it('看不到的：NOT_FOUND；有角色却不是空间管理员：PERMISSION_DENIED；空间管理员与系统管理员：可以', async () => {
    const store = new FakeStore()
    expect((await errorOf(requireSpaceManagement(store.policy, member(ALICE), TEAM_SPACE, 'manageMembers'))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, BOB, 'editor')
    expect(await errorOf(requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'manageMembers'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只有空间管理员能管理成员' })
    expect(await requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'viewMembers')).toMatchObject({ role: 'editor' })
    store.setMember(TEAM_SPACE, BOB, 'admin')
    expect(await requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'rename')).toMatchObject({ role: 'admin' })
    expect(await requireSpaceManagement(store.policy, ADMIN, TEAM_SPACE, 'manageMembers')).toMatchObject({ role: undefined })
  })

  it('个人空间：所有者 PERMISSION_DENIED（没有成员、不能改名），系统管理员 NOT_FOUND', async () => {
    const store = new FakeStore()
    expect(await errorOf(requireSpaceManagement(store.policy, member(ALICE), ALICE_SPACE, 'viewMembers'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '个人空间没有成员' })
    expect((await errorOf(requireSpaceManagement(store.policy, member(ALICE), ALICE_SPACE, 'rename'))).code).toBe('PERMISSION_DENIED')
    expect((await errorOf(requireSpaceManagement(store.policy, { userId: BOB, systemAdmin: true }, ALICE_SPACE, 'manageMembers'))).code).toBe('NOT_FOUND')
  })

  it('归档：原来的空间管理员不能管理，说明原因；系统管理员照样能', async () => {
    const store = new FakeStore()
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(requireSpaceManagement(store.policy, member(BOB), TEAM_SPACE, 'manageMembers'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(await requireSpaceManagement(store.policy, { userId: BOB, systemAdmin: true }, TEAM_SPACE, 'manageMembers')).toMatchObject({ role: 'viewer' })
  })
})

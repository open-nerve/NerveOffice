import type { SpaceRole } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import { describe, expect, it } from 'vitest'
import { atLeast, effectiveSpaceRole, spacePermissionsOf } from './access-rules.ts'

function facts(overrides: Partial<SpaceFacts>): SpaceFacts {
  return { id: 'space', type: 'team', name: '市场部', status: 'active', visibleToAll: false, owned: false, memberRole: null, ...overrides }
}

const ROLES: readonly (SpaceRole | null)[] = [null, 'viewer', 'editor', 'admin']

describe('角色的高低', () => {
  it('查看者 < 编辑者 < 空间管理员', () => {
    expect(atLeast('admin', 'editor')).toBe(true)
    expect(atLeast('editor', 'editor')).toBe(true)
    expect(atLeast('viewer', 'editor')).toBe(false)
    expect(atLeast('viewer', 'viewer')).toBe(true)
  })
})

describe('有效的空间角色（00 号计划书 §5.2）', () => {
  it('个人空间：所有者是空间管理员；其他人没有角色，个人空间的成员行一概不计', () => {
    expect(effectiveSpaceRole(facts({ type: 'personal', owned: true }))).toBe('admin')
    for (const memberRole of ROLES)
      expect(effectiveSpaceRole(facts({ type: 'personal', owned: false, memberRole })), String(memberRole)).toBeUndefined()
  })

  it('团队空间：成员的角色；不是成员就没有角色；所有者标记对团队空间不起作用', () => {
    for (const memberRole of ROLES)
      expect(effectiveSpaceRole(facts({ memberRole })), String(memberRole)).toBe(memberRole ?? undefined)
    expect(effectiveSpaceRole(facts({ owned: true }))).toBeUndefined()
  })

  it('全员可见：不是成员的人是查看者，成员保留自己的角色', () => {
    for (const memberRole of ROLES)
      expect(effectiveSpaceRole(facts({ visibleToAll: true, memberRole })), String(memberRole)).toBe(memberRole ?? 'viewer')
  })

  it('归档：所有人至多是查看者；没有角色的仍然没有', () => {
    for (const visibleToAll of [false, true]) {
      for (const memberRole of ROLES) {
        const expected = memberRole === null && !visibleToAll ? undefined : 'viewer'
        expect(effectiveSpaceRole(facts({ status: 'archived', visibleToAll, memberRole })), `${visibleToAll} ${memberRole}`).toBe(expected)
      }
    }
  })
})

describe('空间上能做的操作（M2-P2 设计 §3.4）', () => {
  it('新建文档：编辑者及以上（归档之后有效角色至多是查看者，所以不能新建）', () => {
    const team = facts({})
    expect([undefined, 'viewer', 'editor', 'admin'].map(role => spacePermissionsOf(team, role as SpaceRole | undefined, false).canCreateDocuments))
      .toEqual([false, false, true, true])
    // 系统角色不带来内容权限
    expect(spacePermissionsOf(team, undefined, true).canCreateDocuments).toBe(false)
  })

  it('团队空间的成员与改名：空间管理员或系统管理员能管理；有角色的人都能看成员', () => {
    const team = facts({})
    expect(spacePermissionsOf(team, 'admin', false)).toEqual({ canCreateDocuments: true, canViewMembers: true, canManageMembers: true, canRename: true })
    expect(spacePermissionsOf(team, 'editor', false)).toEqual({ canCreateDocuments: true, canViewMembers: true, canManageMembers: false, canRename: false })
    expect(spacePermissionsOf(team, 'viewer', false)).toEqual({ canCreateDocuments: false, canViewMembers: true, canManageMembers: false, canRename: false })
    expect(spacePermissionsOf(team, undefined, true)).toEqual({ canCreateDocuments: false, canViewMembers: true, canManageMembers: true, canRename: true })
  })

  it('归档的团队空间：原来的空间管理员（有效角色已是查看者）不能管理；系统管理员照样能', () => {
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    const role = effectiveSpaceRole(archived)
    expect(spacePermissionsOf(archived, role, false)).toEqual({ canCreateDocuments: false, canViewMembers: true, canManageMembers: false, canRename: false })
    expect(spacePermissionsOf(archived, role, true)).toMatchObject({ canManageMembers: true, canRename: true })
  })

  it('个人空间：所有者能新建，没有成员、不能改名；系统管理员也一样不能', () => {
    const personal = facts({ type: 'personal', owned: true })
    expect(spacePermissionsOf(personal, 'admin', false)).toEqual({ canCreateDocuments: true, canViewMembers: false, canManageMembers: false, canRename: false })
    expect(spacePermissionsOf(personal, 'admin', true)).toEqual({ canCreateDocuments: true, canViewMembers: false, canManageMembers: false, canRename: false })
  })
})

import type { SpaceRole } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { atLeast, documentPermissionsOf, effectiveSpaceRole, folderPermissionsOf, spacePermissionsOf, trashPermissionsOf } from './access-rules.ts'

const ALICE = '0199a2c4-0000-7000-8000-00000000000a'
const BOB = '0199a2c4-0000-7000-8000-00000000000b'

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
    expect(spacePermissionsOf(team, 'admin', false)).toEqual({ canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: true })
    expect(spacePermissionsOf(team, 'editor', false)).toEqual({ canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false })
    expect(spacePermissionsOf(team, 'viewer', false)).toEqual({ canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false })
    expect(spacePermissionsOf(team, undefined, true)).toEqual({ canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: false })
  })

  it('归档的团队空间：原来的空间管理员（有效角色已是查看者）不能管理；系统管理员照样能', () => {
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    const role = effectiveSpaceRole(archived)
    expect(spacePermissionsOf(archived, role, false)).toEqual({ canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false })
    expect(spacePermissionsOf(archived, role, true)).toMatchObject({ canManageMembers: true, canRename: true })
  })

  it('个人空间：所有者能新建，没有成员、不能改名；系统管理员也一样不能', () => {
    const personal = facts({ type: 'personal', owned: true })
    expect(spacePermissionsOf(personal, 'admin', false)).toEqual({ canCreateDocuments: true, canCreateFolders: true, canViewMembers: false, canManageMembers: false, canRename: false, canPurgeTrash: true })
    expect(spacePermissionsOf(personal, 'admin', true)).toEqual({ canCreateDocuments: true, canCreateFolders: true, canViewMembers: false, canManageMembers: false, canRename: false, canPurgeTrash: true })
  })

  it('新建文件夹与新建文档同一条规则；永久删除回收站只给空间管理员（系统角色不带来内容权限）', () => {
    const team = facts({})
    for (const role of ROLES) {
      const effective = role ?? undefined
      const permissions = spacePermissionsOf(team, effective, false)
      expect(permissions.canCreateFolders, String(role)).toBe(permissions.canCreateDocuments)
      expect(permissions.canPurgeTrash, String(role)).toBe(role === 'admin')
    }
    expect(spacePermissionsOf(team, undefined, true)).toMatchObject({ canCreateFolders: false, canPurgeTrash: false })
    // 归档之后有效角色至多是查看者：原来的空间管理员也不能新建文件夹、不能永久删除
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    expect(spacePermissionsOf(archived, effectiveSpaceRole(archived), false)).toMatchObject({ canCreateFolders: false, canPurgeTrash: false })
  })
})

describe('文档上能做的操作（00 号计划书 §5.3，M2-P4 设计 §3.7）', () => {
  const mine = { createdBy: ALICE }
  const others = { createdBy: BOB }

  it('改名、保存与空间内移动：编辑者及以上；跨空间移动只给空间管理员；能读就能复制', () => {
    expect(documentPermissionsOf('admin', mine, ALICE)).toEqual({ canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true })
    expect(documentPermissionsOf('editor', mine, ALICE)).toEqual({ canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true })
    expect(documentPermissionsOf('viewer', mine, ALICE)).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false })
  })

  it('删除（P4-S3 spec §2）：空间管理员任意，编辑者只能删自己创建的，查看者一概不能', () => {
    expect(documentPermissionsOf('admin', others, ALICE).canDelete).toBe(true)
    expect(documentPermissionsOf('editor', others, ALICE).canDelete).toBe(false)
    expect(documentPermissionsOf('editor', mine, ALICE).canDelete).toBe(true)
    expect(documentPermissionsOf('viewer', mine, ALICE).canDelete).toBe(false)
  })

  it('归档的空间：有效角色已经是查看者，只剩下复制', () => {
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    const role = effectiveSpaceRole(archived)
    expect(role).toBe('viewer')
    expect(documentPermissionsOf(role ?? 'viewer', mine, ALICE)).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false })
  })
})

describe('文件夹上能做的操作（M2-P4 设计 §3.7）', () => {
  it('改名、空间内移动与删除：编辑者及以上；连同子树移出本空间只给空间管理员', () => {
    expect(folderPermissionsOf('admin')).toEqual({ canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true })
    expect(folderPermissionsOf('editor')).toEqual({ canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canDelete: true })
    expect(folderPermissionsOf('viewer')).toEqual({ canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false })
    expect(folderPermissionsOf(undefined)).toEqual({ canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false })
  })

  it('归档的空间：有效角色已经是查看者，什么也改不了', () => {
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    expect(folderPermissionsOf(effectiveSpaceRole(archived))).toEqual({ canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false })
  })
})

describe('回收站里的删除单元上能做的操作（P4-S3 spec §3、§4）', () => {
  it('恢复：编辑者及以上，并且是删除者本人或空间管理员；永久删除：空间管理员', () => {
    expect(trashPermissionsOf('editor', ALICE, ALICE)).toEqual({ canRestore: true, canPurge: false })
    expect(trashPermissionsOf('editor', BOB, ALICE)).toEqual({ canRestore: false, canPurge: false })
    expect(trashPermissionsOf('viewer', BOB, ALICE)).toEqual({ canRestore: false, canPurge: false })
    expect(trashPermissionsOf('admin', BOB, ALICE)).toEqual({ canRestore: true, canPurge: true })
  })

  it('删完之后被降为查看者：本人也不能再恢复（恢复是把内容放回空间里，按当前权限算）', () => {
    expect(trashPermissionsOf('viewer', ALICE, ALICE)).toEqual({ canRestore: false, canPurge: false })
  })

  it('永久删除与空间权限里的 canPurgeTrash 是同一条规则', () => {
    for (const role of SPACE_ROLES) {
      const team = facts({ memberRole: role })
      expect(trashPermissionsOf(role, BOB, ALICE).canPurge, role).toBe(spacePermissionsOf(team, role, false).canPurgeTrash)
    }
  })

  it('归档的空间：删除者本人也不能恢复，谁都不能永久删除', () => {
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    const role = effectiveSpaceRole(archived) ?? 'viewer'
    expect(trashPermissionsOf(role, ALICE, ALICE)).toEqual({ canRestore: false, canPurge: false })
  })
})

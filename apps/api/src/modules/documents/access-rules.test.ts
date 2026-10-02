import type { DocumentPermissions, GrantRole, SpaceRole } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import type { DocumentAccess } from './access-rules.ts'
import { GRANT_ROLES, SPACE_ROLES } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { atLeast, documentAccessOf, documentPermissionsOf, effectiveSpaceRole, folderPermissionsOf, spacePermissionsOf, trashPermissionsOf } from './access-rules.ts'

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

/** 只按空间角色的访问（没有授权）：空间角色就是内容权限 */
function viaSpace(role: SpaceRole, space: SpaceFacts = facts({ memberRole: role })): DocumentAccess {
  return { spaceRole: role, contentRole: role, accessVia: 'space', space }
}

describe('文档上能做的操作：只有空间角色时（00 号计划书 §5.3，M2-P4 设计 §3.7）', () => {
  const mine = { createdBy: ALICE }
  const others = { createdBy: BOB }

  it('改名、保存与空间内移动：编辑者及以上；跨空间移动与分享只给空间管理员；能读就能复制', () => {
    expect(documentPermissionsOf(viaSpace('admin'), mine, ALICE)).toEqual({ canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true })
    expect(documentPermissionsOf(viaSpace('editor'), mine, ALICE)).toEqual({ canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: false })
    expect(documentPermissionsOf(viaSpace('viewer'), mine, ALICE)).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false })
  })

  it('删除（P4-S3 spec §2）：空间管理员任意，编辑者只能删自己创建的，查看者一概不能', () => {
    expect(documentPermissionsOf(viaSpace('admin'), others, ALICE).canDelete).toBe(true)
    expect(documentPermissionsOf(viaSpace('editor'), others, ALICE).canDelete).toBe(false)
    expect(documentPermissionsOf(viaSpace('editor'), mine, ALICE).canDelete).toBe(true)
    expect(documentPermissionsOf(viaSpace('viewer'), mine, ALICE).canDelete).toBe(false)
  })

  it('归档的空间：有效角色已经是查看者，只剩下复制（原来的空间管理员也不能分享）', () => {
    const archived = facts({ status: 'archived', memberRole: 'admin' })
    const access = documentAccessOf(archived, undefined)
    expect(access).toEqual({ spaceRole: 'viewer', contentRole: 'viewer', accessVia: 'space', space: archived })
    expect(access && documentPermissionsOf(access, mine, ALICE)).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false })
  })

  it('个人空间的所有者是空间管理员：能分享；别人的个人空间没有空间角色', () => {
    expect(documentAccessOf(facts({ type: 'personal', owned: true }), undefined)).toMatchObject({ spaceRole: 'admin', contentRole: 'admin', accessVia: 'space' })
    expect(documentAccessOf(facts({ type: 'personal', owned: false }), undefined)).toBeUndefined()
  })
})

/**
 * 全部组合的预期（M2-P5 设计 §3.4(1)），按"秩"独立推出（不调用被测的规则）：没有 0、查看者 1、编辑者 2、空间管理员 3。
 * 空间的秩：个人空间看是不是所有者；团队空间是成员角色与"全员可见的查看者"取较高者；归档时至多 1。
 * 内容的秩：空间的秩（归档之前）与授权的秩取较高者，归档时至多 1；为 0 就是看不到。
 */
const RANK: Readonly<Record<SpaceRole, number>> = { viewer: 1, editor: 2, admin: 3 }
const ROLE_OF_RANK: readonly (SpaceRole | undefined)[] = [undefined, 'viewer', 'editor', 'admin']

interface Situation {
  readonly name: string
  readonly space: SpaceFacts
  readonly grant: GrantRole | undefined
}

function situations(): Situation[] {
  const spaces: SpaceFacts[] = [
    facts({ type: 'personal', owned: true }),
    facts({ type: 'personal', owned: false }),
    // 个人空间里另有成员行也一概不计
    facts({ type: 'personal', owned: false, memberRole: 'admin' }),
  ]
  for (const status of ['active', 'archived'] as const) {
    for (const visibleToAll of [false, true]) {
      for (const memberRole of ROLES)
        spaces.push(facts({ status, visibleToAll, memberRole }))
    }
  }
  return spaces.flatMap(space => [undefined, ...GRANT_ROLES].map(grant => ({
    name: `${space.type} owned=${space.owned} member=${String(space.memberRole)} visibleToAll=${space.visibleToAll} ${space.status} grant=${String(grant)}`,
    space,
    grant,
  })))
}

function expectedRanks({ space, grant }: Situation): { readonly spaceRank: number, readonly contentRank: number } {
  const archived = space.status === 'archived'
  const memberRank = space.memberRole === null ? 0 : RANK[space.memberRole]
  const rawSpaceRank = space.type === 'personal' ? (space.owned ? 3 : 0) : Math.max(memberRank, space.visibleToAll ? 1 : 0)
  const cap = (rank: number): number => (archived ? Math.min(rank, 1) : rank)
  return { spaceRank: cap(rawSpaceRank), contentRank: cap(Math.max(rawSpaceRank, grant === undefined ? 0 : RANK[grant])) }
}

/** 只取 shape 里有的那几位 */
function pick(permissions: DocumentPermissions, shape: Partial<DocumentPermissions>): Partial<DocumentPermissions> {
  return Object.fromEntries(Object.keys(shape).map(key => [key, permissions[key as keyof DocumentPermissions]]))
}

describe('文档的访问：空间角色 × 单独授权 × 归档的全部组合（M2-P5 设计 §3.4(1)）', () => {
  const all = situations()
  const mine = { createdBy: ALICE }
  const others = { createdBy: BOB }

  it('组合是全的：3 种个人空间 + 团队空间（2 种状态 × 2 种全员可见 × 4 种成员角色），每种 × 3 种授权', () => {
    expect(all).toHaveLength((3 + 2 * 2 * 4) * 3)
  })

  it.each(all)('访问：$name', (situation) => {
    const { spaceRank, contentRank } = expectedRanks(situation)
    const access = documentAccessOf(situation.space, situation.grant)
    if (contentRank === 0) {
      expect(access).toBeUndefined()
      return
    }
    expect(access).toEqual({
      spaceRole: ROLE_OF_RANK[spaceRank],
      contentRole: ROLE_OF_RANK[contentRank],
      accessVia: spaceRank === 0 ? 'grant' : 'space',
      space: situation.space,
    })
  })

  it.each(all)('权限位，内容看内容权限、结构只看空间角色：$name', (situation) => {
    const { spaceRank, contentRank } = expectedRanks(situation)
    const access = documentAccessOf(situation.space, situation.grant)
    expect(access === undefined).toBe(contentRank === 0)
    if (access === undefined)
      return
    for (const [document, creator] of [[mine, true], [others, false]] as const) {
      const permissions = documentPermissionsOf(access, document, ALICE)
      const content: Partial<DocumentPermissions> = { canEdit: contentRank >= 2, canRename: contentRank >= 2, canCopy: true }
      const structure: Partial<DocumentPermissions> = {
        canMoveWithinSpace: spaceRank >= 2,
        canMoveAcrossSpaces: spaceRank === 3,
        canDelete: spaceRank === 3 || (spaceRank >= 2 && creator),
        canShare: spaceRank === 3,
      }
      expect(pick(permissions, content), `内容 creator=${creator}`).toEqual(content)
      expect(pick(permissions, structure), `结构 creator=${creator}`).toEqual(structure)
      expect(Object.keys(permissions).toSorted()).toEqual(Object.keys({ ...content, ...structure }).toSorted())
    }
  })
})

describe('文档的访问：几种要紧的情形（M2-P5 设计 §1、§3.4(1)）', () => {
  const others = { createdBy: BOB }
  const outsider = facts({ memberRole: null })

  it('只凭授权的编辑者：能保存、改名、复制；不能移动、删除、分享——他是创建人也不能删（看不到空间的目录结构）', () => {
    const access = documentAccessOf(outsider, 'editor')
    expect(access).toEqual({ spaceRole: undefined, contentRole: 'editor', accessVia: 'grant', space: outsider })
    expect(access && documentPermissionsOf(access, { createdBy: ALICE }, ALICE)).toEqual({ canEdit: true, canRename: true, canCopy: true, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false, canShare: false })
  })

  it('只凭授权的查看者：只能读与复制', () => {
    const access = documentAccessOf(outsider, 'viewer')
    expect(access).toMatchObject({ spaceRole: undefined, contentRole: 'viewer', accessVia: 'grant' })
    expect(access && documentPermissionsOf(access, others, ALICE)).toEqual({ canEdit: false, canRename: false, canCopy: true, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false, canShare: false })
  })

  it('归档的空间里授权同样降级：被单独授权为编辑者的人只是查看者', () => {
    const archived = facts({ status: 'archived', memberRole: null })
    expect(documentAccessOf(archived, 'editor')).toEqual({ spaceRole: undefined, contentRole: 'viewer', accessVia: 'grant', space: archived })
    // 空间里的查看者另有编辑授权，归档之后也只是查看者
    expect(documentAccessOf(facts({ status: 'archived', memberRole: 'viewer' }), 'editor')).toMatchObject({ spaceRole: 'viewer', contentRole: 'viewer' })
  })

  it('取较高者：空间里的查看者另有编辑授权，内容是编辑者，结构仍按查看者（不能移动、删除）；途径是空间', () => {
    const access = documentAccessOf(facts({ memberRole: 'viewer' }), 'editor')
    expect(access).toMatchObject({ spaceRole: 'viewer', contentRole: 'editor', accessVia: 'space' })
    expect(access && documentPermissionsOf(access, { createdBy: ALICE }, ALICE)).toMatchObject({ canEdit: true, canRename: true, canMoveWithinSpace: false, canDelete: false, canShare: false })
  })

  it('授权不覆盖空间角色：空间管理员另有查看授权，仍是空间管理员；全员可见的查看者另有编辑授权，内容是编辑者', () => {
    expect(documentAccessOf(facts({ memberRole: 'admin' }), 'viewer')).toMatchObject({ spaceRole: 'admin', contentRole: 'admin', accessVia: 'space' })
    expect(documentAccessOf(facts({ visibleToAll: true }), 'editor')).toMatchObject({ spaceRole: 'viewer', contentRole: 'editor', accessVia: 'space' })
  })

  it('别人的个人空间里的文档：只凭授权（个人空间的成员行不计）', () => {
    const personal = facts({ type: 'personal', owned: false, memberRole: 'admin' })
    expect(documentAccessOf(personal, 'viewer')).toEqual({ spaceRole: undefined, contentRole: 'viewer', accessVia: 'grant', space: personal })
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

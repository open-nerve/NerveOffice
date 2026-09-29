import type { SpaceMember, SpaceView, TeamSpace, TrashEntry } from '@nerve-office/contracts'
import type { SpaceContentAccess, TrashEntrySummary } from '../documents/index.ts'
import type { SpaceFacts, SpaceMemberRecord, SpaceRecord } from '../spaces/index.ts'
import type { User } from '../users/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'

/** 我能看到的空间（contracts 的 spaceViewSchema） */
export function toSpaceView(access: SpaceContentAccess): SpaceView {
  const { space } = access
  return {
    id: space.id,
    type: space.type,
    name: space.name,
    status: space.status,
    visibleToAll: space.visibleToAll,
    role: access.role,
    permissions: access.permissions,
  }
}

/** 团队空间的基本信息（contracts 的 teamSpaceSchema） */
export function toTeamSpace(space: SpaceFacts | SpaceRecord): TeamSpace {
  return { id: space.id, name: space.name, status: space.status, visibleToAll: space.visibleToAll }
}

/** 空间的成员：名字与账户状态由 users 补上 */
export function toSpaceMember(member: SpaceMemberRecord, user: User): SpaceMember {
  return {
    user: { id: user.id, username: user.username, displayName: user.displayName },
    status: user.status,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
  }
}

/** 回收站里的一个删除单元（contracts 的 trashEntrySchema）：删除者的名字由 users 补上，账户已经不在时为 null */
export function toTrashEntry(entry: TrashEntrySummary, user: User | undefined): TrashEntry {
  return {
    id: entry.id,
    spaceId: entry.spaceId,
    kind: entry.kind,
    title: entry.title,
    deletedBy: user === undefined ? null : { id: user.id, username: user.username, displayName: user.displayName },
    deletedAt: entry.deletedAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString(),
    origin: entry.origin,
    documentCount: entry.documentCount,
    permissions: entry.permissions,
  }
}

/** 成员列表的顺序：先按角色从高到低（空间管理员、编辑者、查看者），再按显示名、登录名 */
export function compareMembers(a: SpaceMember, b: SpaceMember): number {
  return SPACE_ROLES.indexOf(b.role) - SPACE_ROLES.indexOf(a.role)
    || a.user.displayName.localeCompare(b.user.displayName, 'zh-CN')
    || a.user.username.localeCompare(b.user.username)
}

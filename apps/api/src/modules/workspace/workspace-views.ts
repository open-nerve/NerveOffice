import type { DocumentGrant, SearchResult, SharedDocument, SpaceIdentity, SpaceMember, SpaceRole, SpaceView, TeamSpace, TrashEntry, UserSummary } from '@nerve-office/contracts'
import type { DocumentGrantRecord, LocatedSpace, SearchHit, SharedHit, SpaceContentAccess, TrashEntrySummary } from '../documents/index.ts'
import type { SpaceFacts, SpaceMemberRecord, SpaceRecord } from '../spaces/index.ts'
import type { User } from '../users/index.ts'
import { SPACE_ROLES } from '@nerve-office/contracts'

/** 账户的"人"的结构（contracts 的 userSummarySchema）：别处显示"谁"都用它，界面经人名组件显示（规范 §2.4） */
export function toUserSummary(user: User): UserSummary {
  return { id: user.id, username: user.username, displayName: user.displayName }
}

/**
 * 按 id 批量取来的账户里的一个：成员、授权、个人空间的所有者都有外键指向账户，账户不删（只停用），取不到说明数据不一致，
 * 按意外错误处理（只记 id）
 */
export function accountIn(accounts: ReadonlyMap<string, User>, userId: string): User {
  const account = accounts.get(userId)
  if (account === undefined)
    throw new Error(`账户不存在：${userId}`)
  return account
}

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
    user: toUserSummary(user),
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
    deletedBy: user === undefined ? null : toUserSummary(user),
    deletedAt: entry.deletedAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString(),
    origin: entry.origin,
    documentCount: entry.documentCount,
    permissions: entry.permissions,
  }
}

/**
 * 一条单独授权（contracts 的 documentGrantSchema，M2-P5）：被授权人与最后设置它的人的名字、被授权人的账户状态由 users 补上
 * （停用的人的授权照样列出，与成员列表同形）；设置的时间是最后设置这个角色的时间
 */
export function toDocumentGrant(grant: DocumentGrantRecord, accounts: ReadonlyMap<string, User>): DocumentGrant {
  const user = accountIn(accounts, grant.userId)
  return {
    user: toUserSummary(user),
    status: user.status,
    role: grant.role,
    grantedBy: toUserSummary(accountIn(accounts, grant.grantedBy)),
    grantedAt: grant.updatedAt.toISOString(),
  }
}

/** 一批空间里个人空间的所有者（去重由 UsersService.findByIds 做）：搜索结果与"与我共享"补人名用 */
export function ownerIdsOf(spaces: readonly LocatedSpace[]): string[] {
  return spaces.flatMap(space => space.type === 'personal' ? [space.ownerUserId] : [])
}

/**
 * 搜索结果与"与我共享"里的空间（contracts 的 spaceIdentitySchema，M2-P5 设计 §3.4(2)(4)）：团队空间给名称；
 * 个人空间只给所有者的"人"（人名来自 users），不给存的名称——那是所有者建号时的显示名，可以伪造（规范 §2.4）
 */
function toSpaceIdentity(space: LocatedSpace, owners: ReadonlyMap<string, User>): SpaceIdentity {
  return space.type === 'personal'
    ? { id: space.id, type: 'personal', owner: toUserSummary(accountIn(owners, space.ownerUserId)) }
    : { id: space.id, type: 'team', name: space.name }
}

/** 搜索结果的一条（contracts 的 searchResultSchema）：所在空间的所有者的人名由 users 补上，其余 documents 已经给齐 */
export function toSearchResult(hit: SearchHit, owners: ReadonlyMap<string, User>): SearchResult {
  return { ...hit, space: toSpaceIdentity(hit.space, owners) }
}

/** "与我共享"的一条（contracts 的 sharedDocumentSchema） */
export function toSharedDocument(hit: SharedHit, owners: ReadonlyMap<string, User>): SharedDocument {
  return { ...hit, space: toSpaceIdentity(hit.space, owners) }
}

/**
 * 成员列表与授权列表的顺序：先按角色从高到低（空间管理员、编辑者、查看者），再按显示名、登录名
 */
export function compareMembers(a: { readonly user: UserSummary, readonly role: SpaceRole }, b: { readonly user: UserSummary, readonly role: SpaceRole }): number {
  return SPACE_ROLES.indexOf(b.role) - SPACE_ROLES.indexOf(a.role)
    || a.user.displayName.localeCompare(b.user.displayName, 'zh-CN')
    || a.user.username.localeCompare(b.user.username)
}

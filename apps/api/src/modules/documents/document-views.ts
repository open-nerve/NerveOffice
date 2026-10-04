import type { DocumentAccessVia, DocumentDetail, DocumentSpace, DocumentSummary, SearchResult, SpaceRole } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import type { DocumentAccess } from './access-rules.ts'
import type { DocumentRow } from './documents.repository.ts'
import { documentPermissionsOf } from './access-rules.ts'

/** 列表的条目。 */
export function toSummary(row: DocumentRow): DocumentSummary {
  return { id: row.id, title: row.title, type: row.type, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/**
 * 文档详情里所在的空间（contracts 的 documentSpaceSchema）：团队空间给名称；个人空间只给 id 与类型——存的名称是所有者建号时的显示名，
 * 可以伪造（规范 §2.4），详情用不着它（本人的个人空间界面写"我的空间"，只凭授权打开的返回"与我共享"，M2-P5）。不带成员与权限
 */
function toSpace(space: SpaceFacts): DocumentSpace {
  return space.type === 'personal' ? { id: space.id, type: 'personal' } : { id: space.id, type: 'team', name: space.name }
}

/**
 * 元数据与调用者的权限（权限的规则是 access-rules 里的纯函数，界面与服务端共用同一份）。
 * userId 是看这份文档的人：删除的权限要看他是不是创建人（P4-S3 spec §2）。
 * 只凭授权（accessVia 为 grant）时不给所在的文件夹（00 号计划书 §5.5，M2-P5 设计 §3.4(1)）：文件夹是空间目录结构的一部分。
 * 凡是返回文档详情的接口（打开、改名与移动的响应、新建与复制的响应）都经这里，"不给目录结构"只在这一处
 */
export function toDetail(row: DocumentRow, access: DocumentAccess, userId: string): DocumentDetail {
  return {
    ...toSummary(row),
    spaceId: row.spaceId,
    space: toSpace(access.space),
    folderId: access.accessVia === 'grant' ? null : row.folderId,
    accessVia: access.accessVia,
    revision: row.revision,
    profile: row.profile,
    formatVersion: row.formatVersion,
    sdkVersion: row.sdkVersion,
    // "公式待更新"（M3-P3 设计 §3.8）：M3-P3-S4 的迁移加上 documents.formulas_pending 之前，服务端没有记下它，一律为 false（临时）
    formulasPending: false,
    permissions: documentPermissionsOf(access, row, userId),
  }
}

/**
 * 搜索结果与"与我共享"里文档所在的空间（M2-P5 设计 §3.4(2)(4)）：有了单独授权，这两处会出现别人的个人空间。
 * 团队空间给名称；个人空间只给所有者的账户 id，不给存的名称（所有者建号时的显示名，可以伪造，规范 §2.4）——界面按所有者的人名呈现，
 * 人名由 workspace 经 users 补上（documents 不依赖 users），成为 contracts 的 spaceIdentitySchema
 */
export type LocatedSpace
  = | { readonly id: string, readonly type: 'team', readonly name: string }
    | { readonly id: string, readonly type: 'personal', readonly ownerUserId: string }

/** ownerUserId：个人空间的所有者（spaces 按一批 id 取空间事实时一起给出）；个人空间一定有所有者，没有就是数据不一致 */
export function toLocatedSpace(space: SpaceFacts, ownerUserId: string | null): LocatedSpace {
  if (space.type === 'team')
    return { id: space.id, type: 'team', name: space.name }
  if (ownerUserId === null)
    throw new Error(`个人空间没有所有者：${space.id}`)
  return { id: space.id, type: 'personal', ownerUserId }
}

/** 搜索结果的一条：除了所在空间的所有者的人名，都已齐备（人名由 workspace 补上） */
export interface SearchHit extends Omit<SearchResult, 'space'> {
  readonly space: LocatedSpace
}

/**
 * 搜索结果的一条（M2-P4 设计 §3.4 第 5 条）：摘要加上它在哪里——所在的空间，
 * 以及从空间根目录到它所在文件夹的名称（在空间的根目录下时是空数组）。不带权限位：点开时按文档自己的规则再判断。
 * 凭授权命中（accessVia 为 grant）的一条不给目录结构：文件夹为空、路径是空数组，与文档详情同一条规则（M2-P5 设计 §3.4(2)），
 * 调用方不必为它另查路径
 */
export function toSearchHit(row: DocumentRow, space: LocatedSpace, folderPath: readonly string[], accessVia: DocumentAccessVia): SearchHit {
  const viaGrant = accessVia === 'grant'
  return {
    ...toSummary(row),
    space,
    folderId: viaGrant ? null : row.folderId,
    folderPath: viaGrant ? [] : [...folderPath],
    accessVia,
  }
}

/**
 * "与我共享"的一条（M2-P5 设计 §3.4(4)）：文档的摘要（不带文件夹：只凭授权的人看不到目录结构，有空间角色的也不在这里给）、
 * 所在的空间（所有者的人名由 workspace 补上），与调用者在这份文档上的内容权限（访问策略按空间角色与授权算出，已按归档降级）
 */
export interface SharedHit extends DocumentSummary {
  readonly space: LocatedSpace
  readonly contentRole: SpaceRole
}

export function toSharedHit(row: DocumentRow, access: DocumentAccess, ownerUserId: string | null): SharedHit {
  return { ...toSummary(row), space: toLocatedSpace(access.space, ownerUserId), contentRole: access.contentRole }
}

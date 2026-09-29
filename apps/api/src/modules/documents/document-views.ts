import type { DocumentDetail, DocumentSpace, DocumentSummary, SearchResult } from '@nerve-office/contracts'
import type { SpaceFacts } from '../spaces/index.ts'
import type { DocumentAccess } from './document-access-policy.ts'
import type { DocumentRow } from './documents.repository.ts'
import { documentPermissionsOf } from './access-rules.ts'

/** 列表的条目。 */
export function toSummary(row: DocumentRow): DocumentSummary {
  return { id: row.id, title: row.title, type: row.type, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/** 文档所在的空间：元数据与搜索结果都只给这三项，不带成员与权限。 */
function toSpace(space: SpaceFacts): DocumentSpace {
  return { id: space.id, type: space.type, name: space.name }
}

/**
 * 元数据与调用者的权限（权限的规则是 access-rules 里的纯函数，界面与服务端共用同一份）。
 * userId 是看这份文档的人：删除的权限要看他是不是创建人（P4-S3 spec §2）。
 */
export function toDetail(row: DocumentRow, access: DocumentAccess, userId: string): DocumentDetail {
  return {
    ...toSummary(row),
    spaceId: row.spaceId,
    space: toSpace(access.space),
    folderId: row.folderId,
    revision: row.revision,
    profile: row.profile,
    formatVersion: row.formatVersion,
    permissions: documentPermissionsOf(access.role, row, userId),
  }
}

/**
 * 搜索结果的一条（M2-P4 设计 §3.4 第 5 条）：摘要加上它在哪里——所在的空间，
 * 以及从空间根目录到它所在文件夹的名称（在空间的根目录下时是空数组）。不带权限位：点开时按文档自己的规则再判断。
 */
export function toSearchResult(row: DocumentRow, space: SpaceFacts, folderPath: readonly string[]): SearchResult {
  return {
    ...toSummary(row),
    space: toSpace(space),
    folderId: row.folderId,
    folderPath: [...folderPath],
  }
}

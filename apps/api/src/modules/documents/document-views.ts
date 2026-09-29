import type { DocumentDetail, DocumentSummary } from '@nerve-office/contracts'
import type { DocumentAccess } from './document-access-policy.ts'
import type { DocumentRow } from './documents.repository.ts'
import { documentPermissionsOf } from './access-rules.ts'

/** 列表的条目。 */
export function toSummary(row: DocumentRow): DocumentSummary {
  return { id: row.id, title: row.title, type: row.type, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/**
 * 元数据与调用者的权限（权限的规则是 access-rules 里的纯函数，界面与服务端共用同一份）。
 * userId 是看这份文档的人：删除的权限要看他是不是创建人（P4-S3 spec §2）。
 */
export function toDetail(row: DocumentRow, access: DocumentAccess, userId: string): DocumentDetail {
  return {
    ...toSummary(row),
    spaceId: row.spaceId,
    space: { id: access.space.id, type: access.space.type, name: access.space.name },
    folderId: row.folderId,
    revision: row.revision,
    profile: row.profile,
    formatVersion: row.formatVersion,
    permissions: documentPermissionsOf(access.role, row, userId),
  }
}

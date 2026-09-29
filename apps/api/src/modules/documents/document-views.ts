import type { DocumentDetail, DocumentSummary } from '@nerve-office/contracts'
import type { DocumentAccess } from './document-access-policy.ts'
import type { DocumentRow } from './documents.repository.ts'
import { canEdit } from './document-access-policy.ts'

/** 列表的条目。 */
export function toSummary(row: DocumentRow): DocumentSummary {
  return { id: row.id, title: row.title, type: row.type, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/** 元数据与调用者的权限。 */
export function toDetail(row: DocumentRow, access: DocumentAccess): DocumentDetail {
  return {
    ...toSummary(row),
    spaceId: row.spaceId,
    space: { id: access.space.id, type: access.space.type, name: access.space.name },
    revision: row.revision,
    profile: row.profile,
    formatVersion: row.formatVersion,
    permissions: { canEdit: canEdit(access) },
  }
}

import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { and, eq, sql } from 'drizzle-orm'
import { documentAssetLinks } from '../../db/schema/documents/index.ts'

/** 当前引用的相关子查询；只读关系表，不跨模块查资源元数据。历史或保留引用不提供当前内容权限。 */
export function linkedAssetExists(documentId: AnyPgColumn, assetId: string): SQL<boolean> {
  const links = documentAssetLinks
  return sql<boolean>`EXISTS (SELECT 1 FROM ${links} WHERE ${and(eq(links.documentId, documentId), eq(links.assetId, assetId))})`
}

import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Database, DbExecutor, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, not, sql } from 'drizzle-orm'
import { documentAssetLinks } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'

const links = documentAssetLinks

/** 当前引用的相关子查询；只读关系表，不跨模块查资源元数据。历史或保留引用不提供当前内容权限。 */
export function linkedAssetExists(documentId: AnyPgColumn, assetId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${links} WHERE ${and(eq(links.documentId, documentId), eq(links.assetId, assetId))})`
}

/** 关系表只由这里持有；文档仓储将它联到自己的 accessible 条件，预选每个图片的一个来源。 */
export function requestedAssetLinks(ids: readonly string[], executor: DbExecutor) {
  return executor.select({ assetId: links.assetId, documentId: links.documentId }).from(links).where(inIdArray(links.assetId, ids)).as('requested_asset_links')
}

@Injectable()
export class DocumentAssetsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async retainedAssetIds(ids: readonly string[], transaction: Transaction): Promise<string[]> {
    if (ids.length === 0)
      return []
    const rows = await executorOf(this.db, transaction).selectDistinct({ id: links.assetId }).from(links).where(inIdArray(links.assetId, ids))
    return rows.map(row => row.id)
  }

  async current(documentId: string, transaction: Transaction): Promise<string[]> {
    const rows = await executorOf(this.db, transaction).select({ id: links.assetId }).from(links).where(eq(links.documentId, documentId)).orderBy(asc(links.assetId))
    return rows.map(row => row.id)
  }

  async referencedIds(documentIds: readonly string[], assetIds: readonly string[], transaction: Transaction): Promise<string[]> {
    if (documentIds.length === 0 || assetIds.length === 0)
      return []
    const rows = await executorOf(this.db, transaction).selectDistinct({ id: links.assetId }).from(links).where(and(inIdArray(links.documentId, documentIds), inIdArray(links.assetId, assetIds))).orderBy(asc(links.assetId))
    return rows.map(row => row.id)
  }

  /** 调用方已锁住目标与合法来源。完整替换，绑定参数数量与集合大小无关。 */
  async replace(documentId: string, assetIds: readonly string[], transaction: Transaction): Promise<void> {
    const executor = executorOf(this.db, transaction)
    await executor.delete(links).where(and(eq(links.documentId, documentId), not(inIdArray(links.assetId, assetIds))))
    if (assetIds.length === 0)
      return
    await executor.execute(sql`INSERT INTO ${links} (document_id, asset_id)
      SELECT ${documentId}::uuid, id FROM unnest(${sql.param([...assetIds])}::uuid[]) AS requested(id)
      ORDER BY id ON CONFLICT DO NOTHING`)
  }

  /** 源文档的共享锁保证当前集合不变；新目标行只在调用方的事务内可见。 */
  async copyFrom(sourceId: string, targetId: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).execute(sql`INSERT INTO ${links} (document_id, asset_id)
      SELECT ${targetId}::uuid, ${links.assetId} FROM ${links} WHERE ${links.documentId} = ${sourceId}
      ORDER BY ${links.assetId}`)
  }
}

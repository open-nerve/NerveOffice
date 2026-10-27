import type { Database, Transaction } from '../database/index.ts'
import type { AssetGcPage } from './asset-gc.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { assetObjectClaims, assetObjectDeletions, assetObjects, assetQuota } from '../../db/schema/assets/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'
import { AssetQuotaRepository } from './asset-quota.repository.ts'

export type AssetRetirementReceipt = typeof assetObjectDeletions.$inferSelect

@Injectable()
export class AssetRetirementRepository {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly quota: AssetQuotaRepository) {}

  async upperBound(tx: Transaction): Promise<string | undefined> {
    const [last] = await executorOf(this.db, tx).select({ id: assetObjectDeletions.id }).from(assetObjectDeletions).where(isNull(assetObjectDeletions.completedAt)).orderBy(desc(assetObjectDeletions.id)).limit(1)
    return last?.id
  }

  async page(page: AssetGcPage, tx: Transaction): Promise<string[]> {
    const table = assetObjectDeletions
    const rows = await executorOf(this.db, tx).select({ id: table.id }).from(table).where(and(isNull(table.completedAt), lte(table.id, page.through), page.after === undefined ? undefined : gt(table.id, page.after))).orderBy(asc(table.id)).limit(page.limit)
    return rows.map(row => row.id)
  }

  async lock(id: string, tx: Transaction): Promise<AssetRetirementReceipt | undefined> {
    await this.quota.lock(tx)
    const [row] = await executorOf(this.db, tx).select().from(assetObjectDeletions).where(eq(assetObjectDeletions.id, id)).for('update')
    return row
  }

  /** 持 quota 后查询；正常上传不会复用退休代次，额外拒绝不一致的持久状态。 */
  async requireNoLivePath(receipt: AssetRetirementReceipt, tx: Transaction): Promise<void> {
    const { rows } = await executorOf(this.db, tx).execute<{ live: boolean }>(sql`SELECT
      EXISTS (SELECT 1 FROM ${assetObjects} WHERE ${assetObjects.storageKey}=${receipt.storageKey})
      OR EXISTS (SELECT 1 FROM ${assetObjectClaims} WHERE ${assetObjectClaims.sha256}=${receipt.sha256}
        AND ${assetObjectClaims.generation} IS NOT DISTINCT FROM ${receipt.generation}::uuid) AS live`)
    if (rows[0]?.live !== false)
      throw new Error('已退休路径仍被存活资源使用，拒绝文件回收')
  }

  /** 调用者已锁定且核对 pending 回执，并确认事务外文件退休成功。 */
  async complete(receipt: AssetRetirementReceipt, at: Date, tx: Transaction): Promise<void> {
    const db = executorOf(this.db, tx)
    const changed = await db.update(assetObjectDeletions).set({ completedAt: at }).where(and(eq(assetObjectDeletions.id, receipt.id), isNull(assetObjectDeletions.completedAt))).returning({ id: assetObjectDeletions.id })
    if (changed.length !== 1)
      throw new Error('文件回收完成状态与锁定回执不一致')
    await db.update(assetQuota).set({ usedBytes: sql`${assetQuota.usedBytes} - ${receipt.bytes}` }).where(eq(assetQuota.id, 1))
  }
}

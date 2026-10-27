import type { Database, Transaction } from '../database/index.ts'
import type { AssetGcObjectKind, AssetGcPage } from './asset-gc.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { assetObjectClaims, assetObjectDeletions, assetObjects, assetQuota, assetReferenceActivity, assets } from '../../db/schema/assets/index.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'
import { AssetQuotaRepository } from './asset-quota.repository.ts'
import { assetObjectKey } from './storage-adapter.ts'

export interface AssetGcObjectRow {
  readonly sha256: string
  readonly generation: string | null
  readonly bytes: number
  readonly unreferencedAt: Date | null
}

function objectTable(kind: AssetGcObjectKind) {
  return kind === 'object' ? assetObjects : assetObjectClaims
}

@Injectable()
export class AssetGcRepository {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly quota: AssetQuotaRepository) {}

  async now(tx: Transaction): Promise<Date> {
    // Drizzle 的原始 execute 不把 timestamptz 转成 Date；按 DatabaseTime 的方式显式取 UTC 文本。
    const { rows } = await executorOf(this.db, tx).execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)
    const at = rows[0]?.now === undefined ? undefined : new Date(rows[0].now)
    if (at === undefined || !Number.isFinite(at.getTime()))
      throw new Error('无法取得资源回收的数据库时刻')
    return at
  }

  async assetUpperBound(tx: Transaction): Promise<string | undefined> {
    const [last] = await executorOf(this.db, tx).select({ id: assets.id }).from(assets).orderBy(desc(assets.id)).limit(1)
    return last?.id
  }

  async lockAssets(page: AssetGcPage, tx: Transaction): Promise<{ id: string, unreferencedAt: Date | null }[]> {
    const db = executorOf(this.db, tx)
    await this.quota.lock(tx)
    return db.select({ id: assets.id, unreferencedAt: assets.unreferencedAt }).from(assets).where(and(lte(assets.id, page.through), page.after === undefined ? undefined : gt(assets.id, page.after))).orderBy(asc(assets.id)).limit(page.limit).for('update', { skipLocked: true })
  }

  async recentAssets(ids: readonly string[], at: Date, tx: Transaction): Promise<ReadonlySet<string>> {
    const rows = await executorOf(this.db, tx).select({ id: assets.id }).from(assets).where(and(inIdArray(assets.id, ids), sql`${assets.createdAt} > ${at.toISOString()}::timestamptz - interval '24 hours'`))
    return new Set(rows.map(row => row.id))
  }

  async activeAssets(ids: readonly string[], tx: Transaction): Promise<ReadonlySet<string>> {
    const rows = await executorOf(this.db, tx).selectDistinct({ id: assetReferenceActivity.assetId }).from(assetReferenceActivity).where(inIdArray(assetReferenceActivity.assetId, ids))
    return new Set(rows.map(row => row.id))
  }

  async updateCandidates(marked: readonly string[], reset: readonly string[], at: Date, tx: Transaction): Promise<void> {
    const db = executorOf(this.db, tx)
    if (marked.length > 0)
      await db.update(assets).set({ unreferencedAt: at }).where(inIdArray(assets.id, marked))
    if (reset.length > 0)
      await db.update(assets).set({ unreferencedAt: null }).where(inIdArray(assets.id, reset))
  }

  async consumeActivity(ids: readonly string[], tx: Transaction): Promise<void> {
    await executorOf(this.db, tx).delete(assetReferenceActivity).where(inIdArray(assetReferenceActivity.assetId, ids))
  }

  /** 调用方已持 quota 与本页资产排他锁；FK RESTRICT 仍是最后一道保护。 */
  async removeAssets(ids: readonly string[], tx: Transaction): Promise<void> {
    if (ids.length === 0)
      return
    const db = executorOf(this.db, tx)
    const removed = await db.delete(assets).where(inIdArray(assets.id, ids)).returning({ id: assets.id })
    if (removed.length !== ids.length)
      throw new Error('回收资源数量与锁定页不一致')
    await db.update(assetQuota).set({ usedAssets: sql`${assetQuota.usedAssets} - ${removed.length}` }).where(eq(assetQuota.id, 1))
  }

  async objectUpperBound(kind: AssetGcObjectKind, tx: Transaction): Promise<string | undefined> {
    const table = objectTable(kind)
    const [last] = await executorOf(this.db, tx).select({ hash: table.sha256 }).from(table).orderBy(desc(table.sha256)).limit(1)
    return last?.hash
  }

  async lockObjects(kind: AssetGcObjectKind, page: AssetGcPage, tx: Transaction): Promise<AssetGcObjectRow[]> {
    const db = executorOf(this.db, tx)
    await this.quota.lock(tx)
    const table = objectTable(kind)
    return db.select({ sha256: table.sha256, generation: table.generation, bytes: table.bytes, unreferencedAt: table.unreferencedAt }).from(table).where(and(lte(table.sha256, page.through), page.after === undefined ? undefined : gt(table.sha256, page.after))).orderBy(asc(table.sha256)).limit(page.limit).for('update', { skipLocked: true })
  }

  async objectsWithAssets(hashes: readonly string[], tx: Transaction): Promise<ReadonlySet<string>> {
    const rows = await executorOf(this.db, tx).selectDistinct({ hash: assets.objectHash }).from(assets).where(sql`${assets.objectHash} = ANY(${sql.param([...hashes])}::text[])`)
    return new Set(rows.map(row => row.hash))
  }

  async updateObjectCandidates(kind: AssetGcObjectKind, marked: readonly string[], reset: readonly string[], at: Date, tx: Transaction): Promise<void> {
    const db = executorOf(this.db, tx)
    const table = objectTable(kind)
    if (marked.length > 0)
      await db.update(table).set({ unreferencedAt: at }).where(sql`${table.sha256} = ANY(${sql.param([...marked])}::text[])`)
    if (reset.length > 0)
      await db.update(table).set({ unreferencedAt: null }).where(sql`${table.sha256} = ANY(${sql.param([...reset])}::text[])`)
  }

  async queueObjects(kind: AssetGcObjectKind, rows: readonly AssetGcObjectRow[], at: Date, tx: Transaction): Promise<void> {
    if (rows.length === 0)
      return
    const db = executorOf(this.db, tx)
    const table = objectTable(kind)
    await db.insert(assetObjectDeletions).values(rows.map((row) => {
      if (row.unreferencedAt === null)
        throw new Error('没有孤儿宽限起点，不能登记退休')
      return { ...row, unreferencedAt: row.unreferencedAt, storageKey: assetObjectKey(row.sha256, row.generation), createdAt: at }
    }))
    const removed = await db.delete(table).where(sql`${table.sha256} = ANY(${sql.param(rows.map(row => row.sha256))}::text[])`).returning({ hash: table.sha256 })
    if (removed.length !== rows.length)
      throw new Error('退休对象数量与锁定页不一致')
    // 转移持久身份但不释放 usedBytes；只有文件退休完成后的首次确认才可释放。
  }
}

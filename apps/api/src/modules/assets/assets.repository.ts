import type { Database, DbExecutor, Transaction } from '../database/index.ts'
import type { ProcessedImage } from './image-types.ts'
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { assetObjectClaims, assetObjects, assetQuota, assets } from '../../db/schema/assets/index.ts'
import { AppError } from '../../shared/errors/app-error.ts'
import { DATABASE, executorOf } from '../database/index.ts'
import { assetObjectKey } from './storage-adapter.ts'

export type AssetObjectMetadata = Omit<ProcessedImage, 'data'>
export interface AssetQuotas { readonly quotaBytes: number, readonly quotaCount: number }

function inconsistent(): Error {
  return new Error('资源对象与持久配额记录不一致')
}
function exceeded(kind: 'bytes' | 'count'): AppError {
  return new AppError('ASSET_QUOTA_EXCEEDED', undefined, { details: { kind } })
}

/** 两个独立短事务，中间没有持有数据库事务的文件 IO；失败不得反向释放 claim。 */
@Injectable()
export class AssetsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async reserve(image: AssetObjectMetadata, quotas: AssetQuotas, transaction: Transaction): Promise<void> {
    const db = executorOf(this.db, transaction)
    const quota = await this.#lockQuota(db)
    if (quota.usedAssets >= quotas.quotaCount)
      throw exceeded('count')
    const existing = await this.#object(db, image)
    const [claim] = await db.select().from(assetObjectClaims).where(eq(assetObjectClaims.sha256, image.sha256))
    if (existing !== undefined && claim !== undefined)
      throw inconsistent()
    if (claim !== undefined && claim.bytes !== image.bytes)
      throw inconsistent()
    if (existing !== undefined || claim !== undefined)
      return
    if (quota.usedBytes + image.bytes > quotas.quotaBytes)
      throw exceeded('bytes')
    await db.insert(assetObjectClaims).values({ sha256: image.sha256, bytes: image.bytes })
    await db.update(assetQuota).set({ usedBytes: quota.usedBytes + image.bytes }).where(eq(assetQuota.id, 1))
  }

  /** 仅在文件完整发布并同步之后调用；提交后该资源所指文件必须已经可读。 */
  async finalize(assetId: string, uploaderId: string, image: AssetObjectMetadata, quotas: AssetQuotas, transaction: Transaction): Promise<void> {
    const db = executorOf(this.db, transaction)
    const quota = await this.#lockQuota(db)
    if (quota.usedAssets >= quotas.quotaCount)
      throw exceeded('count')
    const existing = await this.#object(db, image)
    const [claim] = await db.select().from(assetObjectClaims).where(eq(assetObjectClaims.sha256, image.sha256))
    if (existing === undefined) {
      if (claim === undefined || claim.bytes !== image.bytes)
        throw inconsistent()
      await db.insert(assetObjects).values({
        sha256: image.sha256,
        storageKey: assetObjectKey(image.sha256),
        bytes: image.bytes,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        frames: image.frames,
      })
      await db.delete(assetObjectClaims).where(eq(assetObjectClaims.sha256, image.sha256))
    }
    else if (claim !== undefined) {
      throw inconsistent()
    }
    // 预留已经收费；配额下调也不撤销已占字节，但每一份 asset 必须重新取得记录名额。
    await db.insert(assets).values({ id: assetId, uploaderId, objectHash: image.sha256 })
    await db.update(assetQuota).set({ usedAssets: quota.usedAssets + 1 }).where(eq(assetQuota.id, 1))
  }

  async #lockQuota(db: DbExecutor): Promise<typeof assetQuota.$inferSelect> {
    await db.insert(assetQuota).values({ id: 1 }).onConflictDoNothing()
    const [row] = await db.select().from(assetQuota).where(eq(assetQuota.id, 1)).for('update')
    if (row === undefined)
      throw inconsistent()
    return row
  }

  async #object(db: DbExecutor, image: AssetObjectMetadata): Promise<typeof assetObjects.$inferSelect | undefined> {
    const [row] = await db.select().from(assetObjects).where(eq(assetObjects.sha256, image.sha256))
    if (row !== undefined && (row.bytes !== image.bytes || row.mimeType !== image.mimeType
      || row.width !== image.width || row.height !== image.height || row.frames !== image.frames
      || row.storageKey !== assetObjectKey(image.sha256))) {
      throw inconsistent()
    }
    return row
  }
}

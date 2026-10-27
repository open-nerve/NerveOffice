import type { Database, DbExecutor, Transaction } from '../database/index.ts'
import type { AssetMetadata, AssetReferenceMetadata } from './asset-metadata.ts'
import type { ProcessedImage } from './image-types.ts'
import type { AssetObjectKey } from './storage-adapter.ts'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { asc, eq, sql } from 'drizzle-orm'
import { assetObjectClaims, assetObjects, assetQuota, assets } from '../../db/schema/assets/index.ts'
import { AppError } from '../../shared/errors/app-error.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'
import { AssetQuotaRepository } from './asset-quota.repository.ts'
import { assetObjectKey, parseAssetObjectKey } from './storage-adapter.ts'

export type AssetObjectMetadata = Omit<ProcessedImage, 'data'>
export interface AssetQuotas { readonly quotaBytes: number, readonly quotaCount: number }
export interface AssetObjectReservation {
  readonly sha256: string
  readonly generation: string | null
  readonly storageKey: AssetObjectKey
}

function reservationOf(record: { sha256: string, generation: string | null }): AssetObjectReservation {
  return { ...record, storageKey: assetObjectKey(record.sha256, record.generation) }
}

function inconsistent(): Error {
  return new Error('资源对象与持久配额记录不一致')
}
function exceeded(kind: 'bytes' | 'count'): AppError {
  return new AppError('ASSET_QUOTA_EXCEEDED', undefined, { details: { kind } })
}

/** 两个独立短事务，中间没有持有数据库事务的文件 IO；失败不得反向释放 claim。 */
@Injectable()
export class AssetsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly quota: AssetQuotaRepository) {}

  async referenceMetadata(ids: readonly string[], hold: boolean, transaction: Transaction): Promise<AssetReferenceMetadata[]> {
    if (ids.length === 0)
      return []
    const query = executorOf(this.db, transaction).select({
      assetId: assets.id,
      uploaderId: assets.uploaderId,
      withinUploadWindow: sql<boolean>`${assets.createdAt} > now() - interval '24 hours'`,
    }).from(assets).where(inIdArray(assets.id, ids)).orderBy(asc(assets.id))
    return hold ? query.for('share') : query
  }

  async metadata(assetId: string, transaction: Transaction): Promise<AssetMetadata | undefined> {
    const [row] = await executorOf(this.db, transaction).select({
      assetId: assets.id,
      uploaderId: assets.uploaderId,
      createdAt: assets.createdAt,
      withinUploadWindow: sql<boolean>`${assets.createdAt} > now() - interval '24 hours'`,
      sha256: assetObjects.sha256,
      storageKey: assetObjects.storageKey,
      mimeType: assetObjects.mimeType,
      width: assetObjects.width,
      height: assetObjects.height,
      frames: assetObjects.frames,
      bytes: assetObjects.bytes,
    }).from(assets).innerJoin(assetObjects, eq(assetObjects.sha256, assets.objectHash)).where(eq(assets.id, assetId))
    return row === undefined ? undefined : { ...row, storageKey: parseAssetObjectKey(row.storageKey, row.sha256) }
  }

  async reserve(image: AssetObjectMetadata, quotas: AssetQuotas, transaction: Transaction): Promise<AssetObjectReservation> {
    const db = executorOf(this.db, transaction)
    const quota = await this.quota.lock(transaction)
    if (quota.usedAssets >= quotas.quotaCount)
      throw exceeded('count')
    const existing = await this.#object(db, image)
    const [claim] = await db.select().from(assetObjectClaims).where(eq(assetObjectClaims.sha256, image.sha256))
    if (existing !== undefined && claim !== undefined)
      throw inconsistent()
    if (claim !== undefined && claim.bytes !== image.bytes)
      throw inconsistent()
    const reserved = existing ?? claim
    if (reserved !== undefined) {
      if (existing !== undefined && existing.unreferencedAt !== null)
        await db.update(assetObjects).set({ unreferencedAt: null }).where(eq(assetObjects.sha256, image.sha256))
      else if (claim !== undefined && claim.unreferencedAt !== null)
        await db.update(assetObjectClaims).set({ unreferencedAt: null }).where(eq(assetObjectClaims.sha256, image.sha256))
      return reservationOf({ sha256: reserved.sha256, generation: reserved.generation })
    }
    if (quota.usedBytes + image.bytes > quotas.quotaBytes)
      throw exceeded('bytes')
    const generation = randomUUID()
    await db.insert(assetObjectClaims).values({ sha256: image.sha256, generation, bytes: image.bytes })
    await db.update(assetQuota).set({ usedBytes: quota.usedBytes + image.bytes }).where(eq(assetQuota.id, 1))
    return reservationOf({ sha256: image.sha256, generation })
  }

  /** 仅在文件完整发布并同步之后调用；提交后该资源所指文件必须已经可读。 */
  async finalize(assetId: string, uploaderId: string, image: AssetObjectMetadata, quotas: AssetQuotas, transaction: Transaction, reservation: AssetObjectReservation): Promise<void> {
    const db = executorOf(this.db, transaction)
    const quota = await this.quota.lock(transaction)
    if (quota.usedAssets >= quotas.quotaCount)
      throw exceeded('count')
    const existing = await this.#object(db, image)
    const [claim] = await db.select().from(assetObjectClaims).where(eq(assetObjectClaims.sha256, image.sha256))
    const reserved = existing ?? claim
    if (reserved === undefined || reservation.sha256 !== image.sha256 || reserved.generation !== reservation.generation
      || reservation.storageKey !== assetObjectKey(image.sha256, reserved.generation)) {
      throw new AppError('ASSET_BUSY')
    }
    if (existing === undefined) {
      if (claim === undefined || claim.bytes !== image.bytes)
        throw inconsistent()
      await db.insert(assetObjects).values({
        sha256: image.sha256,
        generation: reservation.generation,
        storageKey: reservation.storageKey,
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
    else if (existing.unreferencedAt !== null) {
      // reserve 后、finalize 前可能重新观察到孤儿；成功转正也要清空候选。
      await db.update(assetObjects).set({ unreferencedAt: null }).where(eq(assetObjects.sha256, image.sha256))
    }
    // 预留已经收费；配额下调也不撤销已占字节，但每一份 asset 必须重新取得记录名额。
    await db.insert(assets).values({ id: assetId, uploaderId, objectHash: image.sha256 })
    await db.update(assetQuota).set({ usedAssets: quota.usedAssets + 1 }).where(eq(assetQuota.id, 1))
  }

  async #object(db: DbExecutor, image: AssetObjectMetadata): Promise<typeof assetObjects.$inferSelect | undefined> {
    const [row] = await db.select().from(assetObjects).where(eq(assetObjects.sha256, image.sha256))
    if (row !== undefined && (row.bytes !== image.bytes || row.mimeType !== image.mimeType
      || row.width !== image.width || row.height !== image.height || row.frames !== image.frames
      || row.storageKey !== assetObjectKey(image.sha256, row.generation))) {
      throw inconsistent()
    }
    return row
  }
}

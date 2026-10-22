import type { DocumentType } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, DbExecutor, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { documentCheckpointAssets, documentCheckpoints } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray, keysetPosition } from '../database/index.ts'

export interface HistoryRecord {
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly type: DocumentType
  readonly profile: string
  readonly formatVersion: number
  readonly sdkVersion: string
  readonly clientBuild: string | null
  readonly formulasPending: boolean
  readonly rawBytes: number
  readonly storedBytes: number
  readonly savedBy: string
  readonly savedAt: Date
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly position: string
}

/** 恢复预检所需的不可变信封和原字节；只在准入之后读取。 */
export interface HistoryMaterial extends HistoryRecord {
  readonly sourceDocumentId: string
  readonly unitId: string
  readonly snapshot: Buffer
  readonly snapshotHash: Buffer
  readonly contentHash: Buffer | null
  readonly resourceNames: readonly string[] | null
}
export type HistoryIdentity = Omit<HistoryMaterial, 'snapshot'>

const t = documentCheckpoints
const links = documentCheckpointAssets

/** 只提供有效用户历史关系，DocumentsRepository 再并上统一策略给出的源文档资格；不接触资源元数据。 */
export function requestedHistoryAssetLinks(ids: readonly string[], now: Date, executor: DbExecutor) {
  return executor.select({ assetId: links.assetId, documentId: t.sourceDocumentId })
    .from(links)
    .innerJoin(t, eq(t.id, links.checkpointId))
    .where(and(inIdArray(links.assetId, ids), eq(t.kind, 'hourly'), gt(t.expiresAt, now)))
    .as('requested_history_asset_links')
}
const METADATA = {
  id: t.id,
  revision: t.revision,
  title: t.title,
  type: t.documentType,
  profile: t.profile,
  formatVersion: t.formatVersion,
  sdkVersion: t.sdkVersion,
  clientBuild: t.clientBuild,
  formulasPending: t.formulasPending,
  rawBytes: t.rawBytes,
  storedBytes: t.storedBytes,
  savedBy: t.savedBy,
  savedAt: t.savedAt,
  createdAt: t.createdAt,
  expiresAt: t.expiresAt,
  position: keysetPosition(t.createdAt),
}
const IDENTITY = { ...METADATA, sourceDocumentId: t.sourceDocumentId, unitId: t.unitId, snapshotHash: t.snapshotHash, contentHash: t.contentHash, resourceNames: t.resourceNames }

/** 用户历史的只读查询。写入仍由 DocumentCheckpointsRepository 唯一负责；列表不读取 TOAST 正文。 */
@Injectable()
export class DocumentHistoryRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 所有仍存在的检查点关系都保留，不借用用户历史的期限/权限过滤。 */
  async retainedAssetIds(ids: readonly string[], tx: Transaction): Promise<string[]> {
    if (ids.length === 0)
      return []
    const rows = await executorOf(this.db, tx).selectDistinct({ id: links.assetId }).from(links).where(inIdArray(links.assetId, ids))
    return rows.map(row => row.id)
  }

  async material(documentId: string, historyId: string, now: Date, tx: Transaction): Promise<HistoryMaterial | undefined> {
    const [row] = await executorOf(this.db, tx).select({ ...IDENTITY, snapshot: t.snapshot }).from(t).where(and(visibleHistory(documentId, now), eq(t.id, historyId)))
    return row
  }

  /** 在源文档之后持共享锁，阻止清除/到期删除；取锁可能等待，到期必须由调用方在锁后再次取数据库时刻判断。 */
  async hold(documentId: string, historyId: string, tx: Transaction): Promise<HistoryIdentity | undefined> {
    const [row] = await executorOf(this.db, tx).select(IDENTITY).from(t).where(and(eq(t.sourceDocumentId, documentId), eq(t.id, historyId), eq(t.kind, 'hourly'))).for('share')
    return row
  }

  async assets(historyId: string, tx: Transaction): Promise<string[]> {
    const rows = await executorOf(this.db, tx).select({ id: links.assetId }).from(links).where(eq(links.checkpointId, historyId)).orderBy(asc(links.assetId))
    return rows.map(row => row.id)
  }

  async list(documentId: string, now: Date, limit: number, after: TimeCursor | undefined, tx: Transaction): Promise<HistoryRecord[]> {
    return executorOf(this.db, tx).select(METADATA).from(t).where(and(
      visibleHistory(documentId, now),
      after === undefined ? undefined : sql`(${t.createdAt}, ${t.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`,
    )).orderBy(desc(t.createdAt), desc(t.id)).limit(limit)
  }

  async find(documentId: string, historyId: string, now: Date, tx: Transaction): Promise<HistoryRecord | undefined> {
    const [row] = await executorOf(this.db, tx).select(METADATA).from(t).where(and(visibleHistory(documentId, now), eq(t.id, historyId)))
    return row
  }

  async content(documentId: string, historyId: string, now: Date, tx: Transaction): Promise<Buffer | undefined> {
    const [row] = await executorOf(this.db, tx).select({ snapshot: t.snapshot }).from(t).where(and(visibleHistory(documentId, now), eq(t.id, historyId)))
    return row?.snapshot
  }

  /** 调用方已经持住源文档并确认现在可读历史；仍逐次复核检查点存在且未过期。 */
  async referencedIds(documentIds: readonly string[], assetIds: readonly string[], now: Date, tx: Transaction): Promise<string[]> {
    if (documentIds.length === 0 || assetIds.length === 0)
      return []
    const rows = await executorOf(this.db, tx).selectDistinct({ id: links.assetId }).from(links).innerJoin(t, eq(t.id, links.checkpointId)).where(and(inIdArray(t.sourceDocumentId, documentIds), inIdArray(links.assetId, assetIds), eq(t.kind, 'hourly'), gt(t.expiresAt, now))).orderBy(asc(links.assetId))
    return rows.map(row => row.id)
  }
}

function visibleHistory(documentId: string, now: Date) {
  return and(eq(t.sourceDocumentId, documentId), eq(t.kind, 'hourly'), gt(t.expiresAt, now))
}

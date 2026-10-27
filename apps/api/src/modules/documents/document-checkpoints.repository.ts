import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import { documentAssetLinks, documentCheckpointAssets, documentCheckpoints, documentContents, documentHistoryBuckets, documentRevisions, documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

export type OperationCheckpointKind = 'before_delete' | 'before_upgrade'

/** 检查点和占位只有本仓储写入；调用方持源文档锁或操作本事务新建的私有行。 */
@Injectable()
export class DocumentCheckpointsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async now(transaction: Transaction): Promise<Date> {
    const result = await executorOf(this.db, transaction).execute<{ now: string }>(sql`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)
    const value = result.rows[0]?.now
    if (value === undefined)
      throw new Error('数据库没有给出检查点时刻')
    return new Date(value)
  }

  async captureHourly(documentId: string, at: Date, transaction: Transaction): Promise<string | undefined> {
    const db = executorOf(this.db, transaction)
    const bucket = await db.execute<{ document_id: string }>(sql`INSERT INTO ${documentHistoryBuckets} (document_id, hour_bucket)
      VALUES (${documentId}::uuid, date_trunc('hour', ${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      ON CONFLICT DO NOTHING RETURNING document_id`)
    if (bucket.rows.length === 0)
      return undefined
    const id = await this.#insert(documentId, 'hourly', null, at, transaction)
    if (id === undefined)
      throw new Error('检查点源文档或正文/修订不完整')
    await this.#copyReferences(documentId, id, transaction)
    return id
  }

  async captureOperation(documentId: string, kind: OperationCheckpointKind, eventId: string, at: Date, transaction: Transaction): Promise<string | undefined> {
    const id = await this.#insert(documentId, kind, eventId, at, transaction)
    if (id === undefined) {
      // 同事件重放与源数据缺失不能混成同一种成功；唯一约束处理并发，锁下复核已有事件。
      const [existing] = await executorOf(this.db, transaction).select({ id: documentCheckpoints.id }).from(documentCheckpoints).where(and(eq(documentCheckpoints.sourceDocumentId, documentId), eq(documentCheckpoints.kind, kind), eq(documentCheckpoints.eventId, eventId)))
      if (existing === undefined)
        throw new Error('检查点源文档或正文/修订不完整')
      return undefined
    }
    await this.#copyReferences(documentId, id, transaction)
    return id
  }

  async #insert(documentId: string, kind: 'hourly' | OperationCheckpointKind, eventId: string | null, at: Date, transaction: Transaction): Promise<string | undefined> {
    const d = documents
    const c = documentContents
    const r = documentRevisions
    // 不解压、不规范化、不重写 SDK unitId；未知旧哈希按原样保留，另记确定的 gzip 字节摘要。
    const inserted = await executorOf(this.db, transaction).execute<{ id: string }>(sql`INSERT INTO ${documentCheckpoints}
      (source_document_id, kind, hour_bucket, event_id, title, document_type, unit_id, profile, format_version,
       sdk_version, client_build, revision, formulas_pending, snapshot, raw_bytes, stored_bytes, content_hash,
       snapshot_hash, resource_names, saved_by, saved_at, created_at, expires_at)
      SELECT ${d.id}, ${kind},
        CASE WHEN ${kind} = 'hourly' THEN date_trunc('hour', ${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END,
        ${eventId}::uuid, ${d.title}, ${d.type}, ${d.unitId}, ${d.profile}, ${d.formatVersion}, ${d.sdkVersion}, ${d.clientBuild},
        ${d.revision}, ${d.formulasPending}, ${c.snapshot}, ${c.rawBytes}, ${c.storedBytes}, ${c.contentHash},
        sha256(${c.snapshot}), ${c.resourceNames}, ${r.savedBy}, ${r.createdAt}, ${at.toISOString()}::timestamptz,
        ${at.toISOString()}::timestamptz + CASE WHEN ${kind} = 'hourly' THEN interval '168 hours' ELSE interval '720 hours' END
      FROM ${d} JOIN ${c} ON ${c.documentId} = ${d.id}
        JOIN ${r} ON ${r.documentId} = ${d.id} AND ${r.revision} = ${d.revision}
      WHERE ${d.id} = ${documentId}::uuid
      ON CONFLICT DO NOTHING RETURNING id`)
    return inserted.rows[0]?.id
  }

  async #copyReferences(documentId: string, checkpointId: string, transaction: Transaction): Promise<void> {
    const links = documentAssetLinks
    await executorOf(this.db, transaction).execute(sql`INSERT INTO ${documentCheckpointAssets} (checkpoint_id, asset_id)
      SELECT ${checkpointId}::uuid, ${links.assetId} FROM ${links}
      WHERE ${links.documentId} = ${documentId}::uuid ORDER BY ${links.assetId}`)
  }
}

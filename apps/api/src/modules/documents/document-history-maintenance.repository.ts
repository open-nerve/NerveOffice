import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { documentCheckpoints, documentHistoryBuckets } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

@Injectable()
export class DocumentHistoryMaintenanceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 调用方持源文档写锁；数据库聚合，避免把无界历史 id 或正文读回进程。 */
  async clearHourly(documentId: string, tx: Transaction): Promise<number> {
    const rows = await executorOf(this.db, tx).execute<{ cleared: number }>(sql`
      WITH removed AS (
        DELETE FROM ${documentCheckpoints}
        WHERE source_document_id = ${documentId}::uuid AND kind = 'hourly'
        RETURNING id
      ) SELECT count(*)::int AS cleared FROM removed
    `)
    const row = rows.rows[0]
    if (row === undefined)
      throw new Error('清除历史没有返回聚合计数')
    return row.cleared
  }

  /** 只锁本批到期行；不反向取源空间/文档锁，正在恢复的行留待下轮。 */
  async deleteExpiredCheckpoints(now: Date, limit: number, tx: Transaction): Promise<number> {
    const result = await executorOf(this.db, tx).execute<{ removed: number }>(sql`
      WITH expired AS (
        SELECT id FROM ${documentCheckpoints}
        WHERE expires_at <= ${now}::timestamptz
        ORDER BY expires_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ), removed AS (
        DELETE FROM ${documentCheckpoints} WHERE id IN (SELECT id FROM expired) RETURNING id
      ) SELECT count(*)::int AS removed FROM removed
    `)
    return removedCount(result.rows)
  }

  /** 至少留满 168 小时；仍有 hourly（包括被锁住的过期行）时保留对应桶。 */
  async deleteExpiredBuckets(now: Date, limit: number, tx: Transaction): Promise<number> {
    const result = await executorOf(this.db, tx).execute<{ removed: number }>(sql`
      WITH expired AS (
        SELECT b.document_id,b.hour_bucket FROM ${documentHistoryBuckets} b
        WHERE b.hour_bucket < (date_trunc('hour',${now}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '168 hours'
          AND NOT EXISTS (SELECT 1 FROM ${documentCheckpoints} c
            WHERE c.source_document_id=b.document_id AND c.kind='hourly' AND c.hour_bucket=b.hour_bucket)
        ORDER BY b.hour_bucket,b.document_id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ), removed AS (
        DELETE FROM ${documentHistoryBuckets} WHERE (document_id,hour_bucket) IN (SELECT document_id,hour_bucket FROM expired)
        RETURNING document_id
      ) SELECT count(*)::int AS removed FROM removed
    `)
    return removedCount(result.rows)
  }
}

function removedCount(rows: readonly { readonly removed: number }[]): number {
  const row = rows[0]
  if (row === undefined)
    throw new Error('历史保留期清理没有返回聚合计数')
  return row.removed
}

import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { asc, eq, lt, sql } from 'drizzle-orm'
import { documentSaveReceipts } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 一条回执（M3-P3 设计 §3.7）：内容相同、修订号没变的那次保存的确认与它的结果 */
export interface ReceiptRow {
  readonly requestId: string
  readonly documentId: string
  /** 那次给出的修订号（当时的当前修订） */
  readonly revision: number
  readonly payloadDigest: Buffer
  readonly savedBy: string
  /** 那次给出的保存时间（当时当前修订的时间） */
  readonly savedAt: Date
}

const t = documentSaveReceipts
const COLUMNS = {
  requestId: t.requestId,
  documentId: t.documentId,
  revision: t.revision,
  payloadDigest: t.payloadDigest,
  savedBy: t.savedBy,
  savedAt: t.savedAt,
}

/** 只有它读写 document_save_receipts（规范 §1.2）。 */
@Injectable()
export class DocumentSaveReceiptsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 这个 requestId 的回执。不带事务时在连接池上读（保存的重放预检在事务之外，见 DocumentRevisionsRepository.findByRequestId） */
  async findByRequestId(requestId: string, transaction?: Transaction): Promise<ReceiptRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(t).where(eq(t.requestId, requestId))
    return row
  }

  /**
   * 写一条回执（调用方锁着这份文档的行）。同一个 requestId 已经有回执（同时进行的、另一份文档上的同一个 requestId）时不写，
   * 返回 undefined：用 ON CONFLICT 而不是等主键报错，事务不会因此中止
   */
  async insert(receipt: ReceiptRow, transaction: Transaction): Promise<ReceiptRow | undefined> {
    const [row] = await executorOf(this.db, transaction).insert(t).values(receipt).onConflictDoNothing({ target: t.requestId }).returning(COLUMNS)
    return row
  }

  /**
   * 保留期的清理（M3-P3 设计 §3.9）：删掉至多 limit 条早于保留期（写下回执的时间早于 now 减 retentionDays 天）的回执，返回删了几条。
   * 按写下的时间算，不按回执里记的保存时间（那是当时当前修订的时间，可能早得多）：保留期是这次请求的幂等窗口。
   * 只锁要删的行、跳过别人正锁着的（与 DocumentRevisionsRepository.deleteExpired 相同）；回执写下之后不再改，删除时不必再核对
   */
  async deleteExpired(now: Date, retentionDays: number, limit: number, transaction: Transaction): Promise<number> {
    const executor = executorOf(this.db, transaction)
    const expired = executor
      .select({ requestId: t.requestId })
      .from(t)
      .where(lt(t.createdAt, sql`${now}::timestamptz - make_interval(days => ${retentionDays})`))
      .orderBy(asc(t.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    // 子查询嵌进 sql 时 drizzle 自己加括号
    const deleted = await executor.delete(t).where(sql`${t.requestId} IN ${expired}`).returning({ requestId: t.requestId })
    return deleted.length
  }
}

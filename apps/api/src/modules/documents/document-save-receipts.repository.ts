import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
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
}

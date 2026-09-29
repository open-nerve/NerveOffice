import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { documentContents, documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 要写入的快照：gzip 压缩的 JSON 字节与解压后的字节数。 */
export interface StoredSnapshot {
  readonly snapshot: Buffer
  readonly rawBytes: number
}

/** 当前内容与它对应的修订号。 */
export interface CurrentContent {
  readonly revision: number
  readonly snapshot: Buffer
}

const c = documentContents

/** 只有它读写 document_contents（规范 §1.2）。 */
@Injectable()
export class DocumentContentsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(documentId: string, content: StoredSnapshot, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).insert(c).values({ documentId, ...content, storedBytes: content.snapshot.length })
  }

  /**
   * 把源文档的当前快照复制给另一份文档（M2-P4 设计 §3.4 第 4 条）：INSERT … SELECT，压缩后的字节原样搬过去，
   * 不经解压与 JSON.parse（DEF-018 说的解析开销不放大），副本与源因此逐字节一致（A10）。
   * 源文档没有内容行（数据不一致）时什么也不写，返回 false
   */
  async copyFrom(sourceId: string, targetId: string, transaction: Transaction): Promise<boolean> {
    const inserted = await executorOf(this.db, transaction).execute(sql`
      INSERT INTO ${c} (document_id, snapshot, raw_bytes, stored_bytes)
      SELECT ${targetId}::uuid, ${c.snapshot}, ${c.rawBytes}, ${c.storedBytes} FROM ${c} WHERE ${c.documentId} = ${sourceId}::uuid`)
    return inserted.rowCount === 1
  }

  /** 换成新的快照；没有内容行（数据不一致）时返回 false。 */
  async replace(documentId: string, content: StoredSnapshot, transaction: Transaction): Promise<boolean> {
    const updated = await executorOf(this.db, transaction)
      .update(c)
      .set({ ...content, storedBytes: content.snapshot.length, updatedAt: sql`now()` })
      .where(eq(c.documentId, documentId))
      .returning({ documentId: c.documentId })
    return updated.length === 1
  }

  /**
   * 当前内容与修订号：一条语句同时读两张表。保存在同一个事务里更新两者，一条语句看到的要么都是旧的、要么都是新的，
   * 修订号（ETag）与内容一定对应；分两次读会在中间插进一次保存，客户端拿着新内容与旧修订号，下次保存就误报冲突。
   */
  async findCurrent(documentId: string): Promise<CurrentContent | undefined> {
    const [row] = await this.db
      .select({ revision: documents.revision, snapshot: c.snapshot })
      .from(c)
      .innerJoin(documents, eq(documents.id, c.documentId))
      .where(eq(c.documentId, documentId))
    return row
  }
}

import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { documentContents, documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/**
 * 要写入的快照：gzip 压缩的 JSON 字节与解压后的字节数，连同规范化的内容哈希与这一版非空的资源名（M3-P3 设计 §3.4：
 * P3 起每次写入都带上，下一次保存按它们判断"内容相同"与"不缩水"）。
 */
export interface StoredSnapshot {
  readonly snapshot: Buffer
  readonly rawBytes: number
  readonly contentHash: Buffer
  readonly resourceNames: readonly string[]
}

/** 当前内容与它对应的修订号。 */
export interface CurrentContent {
  readonly revision: number
  readonly snapshot: Buffer
}

/**
 * 保存在锁下要比较的：当前内容的哈希与非空的资源名（M3-P3 设计 §3.3、§3.7）。存量（P3 之前写的）两者都为空——哈希为空按"不同"处理；
 * 资源名为空时 legacySnapshot 是压缩的快照（只这时才读出来），由调用方解析出上一版非空的资源
 */
export interface ContentEnvelope {
  readonly contentHash: Buffer | null
  readonly resourceNames: readonly string[] | null
  readonly legacySnapshot: Buffer | null
}

/** 复制过去的内容：它的哈希（源文档是存量时为空），副本的修订记录照样记下 */
export interface CopiedContent {
  readonly contentHash: Buffer | null
}

const c = documentContents

/** 只有它读写 document_contents（规范 §1.2）。 */
@Injectable()
export class DocumentContentsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(documentId: string, content: StoredSnapshot, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).insert(c).values({ documentId, ...content, resourceNames: [...content.resourceNames], storedBytes: content.snapshot.length })
  }

  /**
   * 把源文档的当前快照复制给另一份文档（M2-P4 设计 §3.4 第 4 条）：INSERT … SELECT，压缩后的字节原样搬过去，
   * 不经解压与 JSON.parse（DEF-018 说的解析开销不放大），副本与源因此逐字节一致（A10）；内容哈希与非空的资源名一起搬（M3-P3 设计 §3.1：
   * 内容相同，它们也相同；源是存量时照样为空）。源文档没有内容行（数据不一致）时什么也不写，返回 undefined
   */
  async copyFrom(sourceId: string, targetId: string, transaction: Transaction): Promise<CopiedContent | undefined> {
    const inserted = await executorOf(this.db, transaction).execute<{ content_hash: Buffer | null }>(sql`
      INSERT INTO ${c} (document_id, snapshot, raw_bytes, stored_bytes, content_hash, resource_names)
      SELECT ${targetId}::uuid, ${c.snapshot}, ${c.rawBytes}, ${c.storedBytes}, ${c.contentHash}, ${c.resourceNames} FROM ${c} WHERE ${c.documentId} = ${sourceId}::uuid
      RETURNING ${c.contentHash}`)
    const row = inserted.rows[0]
    return row === undefined ? undefined : { contentHash: row.content_hash }
  }

  /** 换成新的快照（连同哈希与非空的资源名）；没有内容行（数据不一致）时返回 false。 */
  async replace(documentId: string, content: StoredSnapshot, transaction: Transaction): Promise<boolean> {
    const updated = await executorOf(this.db, transaction)
      .update(c)
      .set({ ...content, resourceNames: [...content.resourceNames], storedBytes: content.snapshot.length, updatedAt: sql`now()` })
      .where(eq(c.documentId, documentId))
      .returning({ documentId: c.documentId })
    return updated.length === 1
  }

  /**
   * 保存在文档行的锁下读的（见 ContentEnvelope）：一条语句，按主键。快照的字节只在资源名为空（存量）时读出来，
   * 平常的保存不把几 MiB 的 bytea 搬出数据库。没有内容行（数据不一致）时为 undefined
   */
  async findEnvelope(documentId: string, transaction: Transaction): Promise<ContentEnvelope | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select({
        contentHash: c.contentHash,
        resourceNames: c.resourceNames,
        legacySnapshot: sql<Buffer | null>`CASE WHEN ${c.resourceNames} IS NULL THEN ${c.snapshot} END`,
      })
      .from(c)
      .where(eq(c.documentId, documentId))
    return row
  }

  /**
   * 当前内容与修订号：一条语句同时读两张表。保存在同一个事务里更新两者，一条语句看到的要么都是旧的、要么都是新的，
   * 修订号（ETag）与内容一定对应；分两次读会在中间插进一次保存，客户端拿着新内容与旧修订号，下次保存就误报冲突。
   */
  async findCurrent(documentId: string, transaction?: Transaction): Promise<CurrentContent | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select({ revision: documents.revision, snapshot: c.snapshot })
      .from(c)
      .innerJoin(documents, eq(documents.id, c.documentId))
      .where(eq(c.documentId, documentId))
    return row
  }
}

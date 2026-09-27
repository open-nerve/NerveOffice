import type { DocumentProfile, DocumentType, PlatformFormatVersion } from '@nerve-office/contracts'
import type { Database, Transaction } from '../database/index.ts'
import type { DocumentCursor } from './document-cursor.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, sql } from 'drizzle-orm'
import { documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

export interface DocumentRow {
  readonly id: string
  readonly spaceId: string
  readonly type: DocumentType
  readonly title: string
  readonly createdAt: Date
  readonly updatedAt: Date
  /** 游标用的更新时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
  readonly revision: number
  readonly unitId: string
  readonly profile: DocumentProfile
  readonly formatVersion: number
}

/** 新建文档要写的列：修订号从 1 开始，状态为正常，时间取数据库的当前时间。 */
export interface NewDocument {
  readonly spaceId: string
  readonly type: DocumentType
  readonly title: string
  readonly createdBy: string
  readonly unitId: string
  readonly profile: DocumentProfile
  readonly formatVersion: PlatformFormatVersion
  readonly sdkVersion: string
}

const d = documents
const COLUMNS = {
  id: d.id,
  spaceId: d.spaceId,
  type: d.type,
  title: d.title,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  position: sql<string>`to_char(${d.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  revision: d.revision,
  unitId: d.unitId,
  profile: d.profile,
  formatVersion: d.formatVersion,
}

/** documents 表的读写在这里（规范 §1.2）。一处例外：读取内容时修订号要与内容一起读，那条联表的语句在同一模块的 document-contents.repository.ts。 */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 一个空间里正常状态的文档，按更新时间从新到旧；after 是上一页最后一条的位置（keyset）。 */
  async listInSpace(spaceId: string, limit: number, after?: DocumentCursor): Promise<DocumentRow[]> {
    return this.db
      .select(COLUMNS)
      .from(d)
      .where(and(
        eq(d.spaceId, spaceId),
        eq(d.status, 'active'),
        after === undefined ? undefined : sql`(${d.updatedAt}, ${d.id}) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`,
      ))
      .orderBy(desc(d.updatedAt), desc(d.id))
      .limit(limit)
  }

  async findById(id: string, transaction?: Transaction): Promise<DocumentRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(d).where(and(eq(d.id, id), eq(d.status, 'active')))
    return row
  }

  /** 锁住文档行（FOR UPDATE）：同一份文档的保存按到达的顺序逐个执行，修订号的判断与加一之间不会插进别的保存。 */
  async lockById(id: string, transaction: Transaction): Promise<DocumentRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(d).where(and(eq(d.id, id), eq(d.status, 'active'))).for('update')
    return row
  }

  async insert(document: NewDocument, transaction: Transaction): Promise<DocumentRow> {
    const [row] = await executorOf(this.db, transaction).insert(d).values({ ...document, revision: 1 }).returning(COLUMNS)
    if (row === undefined)
      throw new Error('新建文档没有返回记录')
    return row
  }

  /**
   * 修订号前进到 revision（调用方已经锁住这一行并核对过当前修订号），同时更新更新时间与写入时的 SDK 版本。
   * 条件里再核对一次前一个修订号：万一调用方没有锁住这一行，也不会把修订号写乱。
   */
  async advanceRevision(id: string, revision: number, sdkVersion: string, transaction: Transaction): Promise<void> {
    const updated = await executorOf(this.db, transaction)
      .update(d)
      .set({ revision, sdkVersion, updatedAt: sql`now()` })
      .where(and(eq(d.id, id), eq(d.revision, revision - 1)))
      .returning({ id: d.id })
    if (updated.length !== 1)
      throw new Error(`修订号没有从 ${revision - 1} 前进到 ${revision}：${id}`)
  }
}

import type { DocumentType } from '@nerve-office/contracts'
import type { Database } from '../database/index.ts'
import type { DocumentCursor } from './document-cursor.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, sql } from 'drizzle-orm'
import { documents } from '../../db/schema/documents/index.ts'
import { DATABASE } from '../database/index.ts'

export interface DocumentRow {
  readonly id: string
  readonly spaceId: string
  readonly type: DocumentType
  readonly title: string
  readonly createdAt: Date
  readonly updatedAt: Date
  /** 游标用的更新时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
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
}

/** 只有它读写 documents（规范 §1.2）。 */
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

  async findById(id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db.select(COLUMNS).from(d).where(and(eq(d.id, id), eq(d.status, 'active')))
    return row
  }
}

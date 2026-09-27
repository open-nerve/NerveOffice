import type { Buffer } from 'node:buffer'
import type { DocumentRevisionKind } from '../../db/schema/documents/index.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import { documentRevisions } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 保存的来源：编辑器页的实例与捕获时的本地修改序号。 */
export interface RevisionSource {
  readonly clientInstanceId: string
  readonly localSeq: number
}

export interface RevisionRow {
  readonly documentId: string
  readonly revision: number
  readonly kind: DocumentRevisionKind
  readonly payloadDigest: Buffer
  readonly savedBy: string
  readonly createdAt: Date
  /** 新建的修订没有来源 */
  readonly source: RevisionSource | null
}

export interface NewRevision {
  readonly documentId: string
  readonly revision: number
  readonly kind: DocumentRevisionKind
  readonly requestId: string
  readonly payloadDigest: Buffer
  readonly source: RevisionSource | null
  readonly savedBy: string
}

/** advisory lock 的命名空间（两个 int4 的形式，与单个 bigint 的形式互不冲突）：新建文档按 requestId 排队。 */
const CREATE_REQUEST_LOCK_SPACE = 1_020_401

const r = documentRevisions
const COLUMNS = {
  documentId: r.documentId,
  revision: r.revision,
  kind: r.kind,
  payloadDigest: r.payloadDigest,
  savedBy: r.savedBy,
  createdAt: r.createdAt,
  clientInstanceId: r.clientInstanceId,
  localSeq: r.localSeq,
}

/** 查询出来的一行：来源还是分开的两列。 */
interface SelectedRevision extends Omit<RevisionRow, 'source'> {
  readonly clientInstanceId: string | null
  readonly localSeq: number | null
}

function toRevision(row: SelectedRevision): RevisionRow {
  const { clientInstanceId, localSeq, ...rest } = row
  // 两列同时有或同时没有由 CHECK 约束保证
  return { ...rest, source: clientInstanceId === null || localSeq === null ? null : { clientInstanceId, localSeq } }
}

/** 只有它读写 document_revisions（规范 §1.2）。 */
@Injectable()
export class DocumentRevisionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * 事务级的 advisory lock：同一个 requestId 的新建排队执行，后到的一方在查修订记录时就能看到前一方的结果（P4 设计 §3.4）。
   * 不同的 requestId 哈希相同时只是多排一次队。
   */
  async lockCreateRequest(requestId: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).execute(sql`SELECT pg_advisory_xact_lock(${CREATE_REQUEST_LOCK_SPACE}, hashtext(${requestId}))`)
  }

  async findByRequestId(requestId: string, transaction: Transaction): Promise<RevisionRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(r).where(eq(r.requestId, requestId))
    return row === undefined ? undefined : toRevision(row)
  }

  async findByRevision(documentId: string, revision: number, transaction: Transaction): Promise<RevisionRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(r).where(and(eq(r.documentId, documentId), eq(r.revision, revision)))
    return row === undefined ? undefined : toRevision(row)
  }

  /**
   * 写一行修订记录。requestId 已经被别的请求用掉（例如同时进行的、另一份文档的保存）时不写，返回 undefined：
   * 用 ON CONFLICT 而不是等唯一约束报错，事务不会因此中止。
   */
  async insert(revision: NewRevision, transaction: Transaction): Promise<RevisionRow | undefined> {
    const { source, ...columns } = revision
    const [row] = await executorOf(this.db, transaction)
      .insert(r)
      .values({ ...columns, clientInstanceId: source?.clientInstanceId ?? null, localSeq: source?.localSeq ?? null })
      .onConflictDoNothing({ target: r.requestId })
      .returning(COLUMNS)
    return row === undefined ? undefined : toRevision(row)
  }
}

import type { Buffer } from 'node:buffer'
import type { DocumentRevisionKind } from '../../db/schema/documents/index.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { documentRevisions, documents } from '../../db/schema/documents/index.ts'
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
  /** 这一版的规范化内容哈希（M3-P3 设计 §3.4）；复制存量的源文档时为空 */
  readonly contentHash: Buffer | null
  /** 写入这一版的页面的构建（保存、另存为副本）；新建与复制是服务端写的，为空 */
  readonly clientBuild: string | null
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
   * 锁键用数据库规范化之后的 UUID：同一个 UUID 的大写与小写写法，唯一约束（uuid 类型）认作同一个 requestId，
   * 锁也必须认作同一个，否则两者各拿一把锁、同时越过"是否已经新建"的检查（Codex 评审 CX7）
   */
  async lockCreateRequest(requestId: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).execute(sql`SELECT pg_advisory_xact_lock(${CREATE_REQUEST_LOCK_SPACE}, hashtext((${requestId})::uuid::text))`)
  }

  /**
   * 这个 requestId 的修订记录。不带事务时在连接池上读：保存与另存为副本的重放预检在事务之外（M3-P3 设计 §3.1 第 2 步），
   * 读到的修订记录写下之后不再改，单独一条语句读出就是完整的
   */
  async findByRequestId(requestId: string, transaction?: Transaction): Promise<RevisionRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(r).where(eq(r.requestId, requestId))
    return row === undefined ? undefined : toRevision(row)
  }

  async findByRevision(documentId: string, revision: number, transaction: Transaction): Promise<RevisionRow | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(r).where(and(eq(r.documentId, documentId), eq(r.revision, revision)))
    return row === undefined ? undefined : toRevision(row)
  }

  /**
   * 保留期的清理（M3-P3 设计 §3.9）：删掉至多 limit 行早于保留期（created_at 早于 now 减 retentionDays 天）、**而且不是文档当前修订**的
   * 修订记录，返回删了几行。now 由调用方给（定时任务每一轮开头从时钟取一次，生产里是数据库的时间），天数的换算也在 SQL 里。
   * - 当前修订那一行一直留着：修订号冲突的来源、申请编辑权的来源与"内容相同不递增"的保存时间都读它；
   * - "不是当前修订"写成"修订号小于文档现在的修订号"：修订号只增不减（advanceRevision 只从 n 前进到 n + 1），一行一旦不是当前修订，
   *   之后永远不是；文档的修订号与新的那一行由同一个事务写下，同一个快照里两者要么都看得见、要么都看不见——所以按这条语句的快照判断
   *   就是安全的，与并发的保存不需要任何锁：保存还没提交时它的上一版仍是当前修订、不删（留给下一轮），提交了就不是了；
   * - 只锁要删的行（FOR UPDATE SKIP LOCKED），不锁文档行：不与保存、申请编辑权排队；别人正锁着的行（正在永久删除的文档，外键级联）
   *   跳过、留给下一轮，所以不会与永久删除互相等待、形成死锁；
   * - 按时间从旧到新取（created_at 的索引）。修订记录写下之后不再改，取出来的行到删除时仍满足条件，删除时不必再核对
   */
  async deleteExpired(now: Date, retentionDays: number, limit: number, transaction: Transaction): Promise<number> {
    const executor = executorOf(this.db, transaction)
    const expired = executor
      .select({ id: r.id })
      .from(r)
      .where(and(
        lt(r.createdAt, sql`${now}::timestamptz - make_interval(days => ${retentionDays})`),
        sql`${r.revision} < (SELECT ${documents.revision} FROM ${documents} WHERE ${documents.id} = ${r.documentId})`,
      ))
      .orderBy(asc(r.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    // 子查询嵌进 sql 时 drizzle 自己加括号；文档的 inIdArray 只收一串 id，这里是子查询，不展开参数
    const deleted = await executor.delete(r).where(sql`${r.id} IN ${expired}`).returning({ id: r.id })
    return deleted.length
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

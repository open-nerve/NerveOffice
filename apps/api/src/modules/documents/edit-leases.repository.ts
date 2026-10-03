import type { SQL } from 'drizzle-orm'
import type { Buffer } from 'node:buffer'
import type { EditLeaseEndReason } from '../../db/schema/documents/index.ts'
import type { Database, Transaction } from '../database/index.ts'
import type { WriteAccessScope } from './write-access.ts'
import { EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { documentEditLeases, documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'

const l = documentEditLeases
const d = documents

/** 一条编辑租约（M3-P1 设计 §3.3）：每份文档至多一行，时间都是数据库写下的 */
export interface EditLeaseRow {
  readonly documentId: string
  readonly holderId: string
  /** 绑定的登录 */
  readonly sessionId: string
  /** 绑定的标签页 */
  readonly clientInstanceId: string
  /** 令牌的 SHA-256 摘要（32 字节） */
  readonly tokenDigest: Buffer
  /** 这一代的代次：申请时文档的代次加一之后的值 */
  readonly writeEpoch: number
  readonly acquiredAt: Date
  /** 最近一次续租的时间（申请时等于 acquiredAt） */
  readonly renewedAt: Date
  readonly expiresAt: Date
  readonly lastActiveAt: Date
  /** 明确结束（释放、收回写入权）的时间与原因：两者同时为空或同时有值 */
  readonly endedAt: Date | null
  readonly endReason: EditLeaseEndReason | null
}

/**
 * 读出的租约行，连同读它的那条语句里数据库的 now()（事务开始的时刻；同一个事务里之后写下的 now() 也是它）：
 * 有效条件按它判断（edit-lease-rules.ts），不用应用主机的时钟（规范 §5）
 */
export interface ObservedEditLease extends EditLeaseRow {
  readonly now: Date
}

/** 改写为新的一代要写的东西：时间由数据库给出（申请、续租与最后活动是 now()，到期是 now() 加有效期） */
export interface NewEditLease {
  readonly documentId: string
  readonly holderId: string
  readonly sessionId: string
  readonly clientInstanceId: string
  readonly tokenDigest: Buffer
  readonly writeEpoch: number
}

/** 收回写入权时锁住的一条租约，连同那份文档现在所在的空间（对应 coversWriter 的 DocumentWriter：持有者、文档、空间） */
export interface RevocableEditLease extends ObservedEditLease {
  readonly spaceId: string
}

const COLUMNS = {
  documentId: l.documentId,
  holderId: l.holderId,
  sessionId: l.sessionId,
  clientInstanceId: l.clientInstanceId,
  tokenDigest: l.tokenDigest,
  writeEpoch: l.writeEpoch,
  acquiredAt: l.acquiredAt,
  renewedAt: l.renewedAt,
  expiresAt: l.expiresAt,
  lastActiveAt: l.lastActiveAt,
  endedAt: l.endedAt,
  endReason: l.endReason,
  // 与行出自同一条语句；按时间列的写法换成 Date（驱动把 timestamptz 原样当文本交回）
  now: sql<Date>`now()`.mapWith(l.acquiredAt),
}

/** 到期的时刻：数据库的 now() 加上有效期（申请与每次续租） */
const EXPIRES_AT = sql`now() + make_interval(secs => ${EDIT_LEASE_TTL_SECONDS})`

/**
 * 收回写入权的范围涉及哪些租约：租约与文档连查的条件，与 write-access.ts 的 coversWriter 逐种同义。
 * coversWriter 的 DocumentWriter 在这里是：userId——租约的持有者（holder_id），documentId——租约的文档，
 * spaceId——那份文档现在所在的空间（documents.space_id）。
 * - user：持有者是这个人（停用）；
 * - membership：持有者是这个人，而且文档在这个空间里（移出空间、调整空间角色）；
 * - space：文档在这个空间里，不论持有者（归档）；
 * - documents：这些文档，不论持有者（删除、跨空间移动、转移）；
 * - userDocuments：持有者是这个人，而且是这些文档（取消或降低单独授权）。
 * 一串文档 id 作为一个数组参数（inIdArray，规范 §5）。改这里时同时改 coversWriter，反过来也一样：
 * edit-lease-statements.test.ts 逐种核对两边按同样的几项、同样的值筛选（多一项、少一项都算不一致）；真实数据库上的效果由 S5 的集成测试覆盖
 */
function writersIn(scope: WriteAccessScope): SQL | undefined {
  switch (scope.kind) {
    case 'user':
      return eq(l.holderId, scope.userId)
    case 'membership':
      return and(eq(l.holderId, scope.userId), eq(d.spaceId, scope.spaceId))
    case 'space':
      return eq(d.spaceId, scope.spaceId)
    case 'documents':
      return inIdArray(l.documentId, scope.documentIds)
    case 'userDocuments':
      return and(eq(l.holderId, scope.userId), inIdArray(l.documentId, scope.documentIds))
  }
}

/**
 * 编辑租约（M3-P1 设计 §3.3）：只有它读写 document_edit_leases（一表一仓储，规范 §1.2）。只在 documents 模块里用，
 * 不从模块的公开入口转出（lint 拦下）。时间都写数据库的 now()，读出的行带上同一条语句里的 now()（ObservedEditLease）。
 * 锁的顺序是文档行（FOR UPDATE）→ 租约行（P1 设计 §3.4.6）：申请与收回写入权先锁文档行、再锁租约行并改写它；
 * 心跳与释放只锁租约行；保存在文档行的锁下读它、不加锁——能改写它的都要先拿到文档行的锁
 */
@Injectable()
export class EditLeasesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 这份文档的租约（不加锁），没有时为 undefined：编辑状态在只读快照里读它，保存在文档行的锁下读它 */
  async findByDocument(documentId: string, transaction: Transaction): Promise<ObservedEditLease | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(l).where(eq(l.documentId, documentId))
    return row
  }

  /**
   * 锁住这份文档的租约行（FOR UPDATE），没有时为 undefined。申请在文档行的锁下调用（同一份文档上的申请因此逐个进行，
   * 不会两个都看到"没有这一行"再各自插入）；心跳与释放直接调用
   */
  async lockByDocument(documentId: string, transaction: Transaction): Promise<ObservedEditLease | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(l).where(eq(l.documentId, documentId)).for('update')
    return row
  }

  /**
   * 改写为新的一代（调用方已锁住文档行并给文档的代次加了一，lease.writeEpoch 是加一之后的值）：没有这一行就插入，有就整行改写——
   * 持有者、登录、标签页、令牌摘要与代次换成新的，申请、续租与最后活动的时间是 now()，到期是 now() 加有效期，清掉明确结束的两列。
   * 返回写下的这一行
   */
  async replace(lease: NewEditLease, transaction: Transaction): Promise<ObservedEditLease> {
    const generation = {
      holderId: lease.holderId,
      sessionId: lease.sessionId,
      clientInstanceId: lease.clientInstanceId,
      tokenDigest: lease.tokenDigest,
      writeEpoch: lease.writeEpoch,
      acquiredAt: sql`now()`,
      renewedAt: sql`now()`,
      expiresAt: EXPIRES_AT,
      lastActiveAt: sql`now()`,
      endedAt: null,
      endReason: null,
    }
    const [row] = await executorOf(this.db, transaction)
      .insert(l)
      .values({ documentId: lease.documentId, ...generation })
      .onConflictDoUpdate({ target: l.documentId, set: generation })
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error(`改写租约没有返回记录：${lease.documentId}`)
    return row
  }

  /**
   * 续租（调用方已锁住租约行，并判断过它仍然有效）：续租的时间是 now()，到期是 now() 加有效期；最后活动的时间是 now() 减去
   * 页面上报的空闲秒数，不早于申请的时间、不晚于 now()（P1 设计 §3.3）。夹取写在这条语句里，按数据库的时间算到微秒——
   * 在应用里用 Date 算会截到毫秒，最后活动可能比申请还早一点。返回续租之后的这一行
   */
  async renew(documentId: string, idleSeconds: number, transaction: Transaction): Promise<ObservedEditLease> {
    const [row] = await executorOf(this.db, transaction)
      .update(l)
      .set({
        renewedAt: sql`now()`,
        expiresAt: EXPIRES_AT,
        lastActiveAt: sql`least(greatest(now() - make_interval(secs => ${idleSeconds}), ${l.acquiredAt}), now())`,
      })
      .where(eq(l.documentId, documentId))
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error(`续租时租约不在了：${documentId}`)
    return row
  }

  /**
   * 记下明确结束（释放 released、收回写入权 revoked）：结束的时间是 now()。已经明确结束的不再改动，先记下的原因留着；
   * 返回这一次结束了没有（没有这一行、已经结束过时为假）。调用方已锁住租约行
   */
  async end(documentId: string, reason: EditLeaseEndReason, transaction: Transaction): Promise<boolean> {
    const rows = await executorOf(this.db, transaction)
      .update(l)
      .set({ endedAt: sql`now()`, endReason: reason })
      .where(and(eq(l.documentId, documentId), isNull(l.endedAt)))
      .returning({ documentId: l.documentId })
    return rows.length > 0
  }

  /**
   * 收回写入权（P1 设计 §3.4.6 第 1 步）：找出这次范围涉及的、没有明确结束的租约（范围的条件见 writersIn，与 coversWriter 同义），
   * 先按文档 id 的顺序锁住它们的文档行，再按同样的顺序锁住这些租约行，返回锁住的租约（带文档所在的空间）。
   * 调用方在改动权限的事务里调用，之前已经持有账户行、空间行、成员行或这些文档行（ADR-014 的锁顺序，文档行之后才是租约行）。
   * 第二步把条件再核对一次：第一步等文档行的锁时，别的申请可能已经提交、改写了租约（换了持有者），那条语句是按旧的租约行判断的范围；
   * 现在持着文档行的锁，租约不会再被改写（申请要先拿文档行的锁），读到的就是最终的。
   * 申请在撤权提交之前判断了权限、在它之后才提交时，租约行不在这里找得到的范围里，由有效条件的第 7 条在每次使用时让它失效（§3.4.6）。
   * 文档的状态不过滤：删除的调用方先把文档放进回收站，它们上面的租约同样要结束
   */
  async lockInScope(scope: WriteAccessScope, transaction: Transaction): Promise<RevocableEditLease[]> {
    if ((scope.kind === 'documents' || scope.kind === 'userDocuments') && scope.documentIds.length === 0)
      return []
    const executor = executorOf(this.db, transaction)
    const open = and(isNull(l.endedAt), writersIn(scope))
    const locked = await executor
      .select({ id: d.id })
      .from(d)
      .innerJoin(l, eq(l.documentId, d.id))
      .where(open)
      .orderBy(asc(d.id))
      .for('update', { of: d })
    if (locked.length === 0)
      return []
    return executor
      .select({ ...COLUMNS, spaceId: d.spaceId })
      .from(l)
      .innerJoin(d, eq(d.id, l.documentId))
      .where(and(inIdArray(l.documentId, locked.map(row => row.id)), open))
      .orderBy(asc(l.documentId))
      .for('update', { of: l })
  }
}

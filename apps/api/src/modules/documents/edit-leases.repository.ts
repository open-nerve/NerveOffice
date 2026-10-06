import type { DocumentStatus } from '@nerve-office/contracts'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Buffer } from 'node:buffer'
import type { EditLeaseEndReason, EditLeaseTakeover } from '../../db/schema/documents/index.ts'
import type { Database, Transaction } from '../database/index.ts'
import type { WriteAccessScope } from './write-access.ts'
import { EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { documentEditLeases, documents } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf, inIdArray } from '../database/index.ts'

const l = documentEditLeases
const d = documents

/** 一条编辑租约（M3-P1 设计 §3.3；M3-P5 设计 §3.2 的请求、保留与接管标记）：每份文档至多一行，时间都是数据库写下的 */
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
  /** 最后一次操作的时间：申请时是 now() 减去续上的页面带来的空闲，之后由心跳只往前推（M3-P5 设计 §3.5） */
  readonly lastActiveAt: Date
  /** 明确结束（释放、收回写入权、交出）的时间与原因：两者同时为空或同时有值 */
  readonly endedAt: Date | null
  readonly endReason: EditLeaseEndReason | null
  /**
   * 请求编辑（M3-P5 设计 §3.6，单槽）：请求的标识、请求方、请求方的登录、发出的时刻与有效期（请求方续期时往后推）同时为空或同时有值；
   * 持有者谢绝的时刻只在有请求时有值
   */
  readonly requestId: string | null
  readonly requestedBy: string | null
  readonly requestSessionId: string | null
  readonly requestedAt: Date | null
  readonly requestExpiresAt: Date | null
  readonly requestDeclinedAt: Date | null
  /** 交出之后的保留（只在明确结束的原因是 handed_over 时有）：留给谁、留到何时 */
  readonly reservedFor: string | null
  readonly reservedUntil: Date | null
  /** 接管标记：这一代接管的那一代的令牌摘要与方式（本人 self、强制 forced），旧令牌据此得到 taken_over */
  readonly takenOverTokenDigest: Buffer | null
  readonly takeover: EditLeaseTakeover | null
}

/**
 * 读出的租约行，连同读它的那条语句里数据库的 now()（事务开始的时刻；同一个事务里之后写下的 now() 也是它）：
 * 有效条件按它判断（edit-lease-rules.ts），不用应用主机的时钟（规范 §5）
 */
export interface ObservedEditLease extends EditLeaseRow {
  readonly now: Date
}

/** 接管标记（M3-P5 设计 §3.7、§3.8）：这一代接管的那一代的令牌摘要（不存令牌本身）与方式 */
export interface TakeoverMarker {
  readonly tokenDigest: Buffer
  readonly takeover: EditLeaseTakeover
}

/**
 * 改写为新的一代要写的东西：时间由数据库给出（申请与续租是 now()，到期是 now() 加有效期）；最后活动是 now() 减去 idleSeconds——
 * 续上的页面带来的本页空闲秒数（M3-P5 设计 §3.5，复验 P1-C5：服务端的空闲兜底不因续上而重新计时），别的申请是 0。
 * takenOver：这一代接管了占着的那一代（本人接管、强制接管）时写下的接管标记；不是接管时为 undefined，接管标记只在同一个页面重试时沿用
 */
export interface NewEditLease {
  readonly documentId: string
  readonly holderId: string
  readonly sessionId: string
  readonly clientInstanceId: string
  readonly tokenDigest: Buffer
  readonly writeEpoch: number
  readonly idleSeconds: number
  readonly takenOver: TakeoverMarker | undefined
}

/**
 * 收回写入权时锁住的一条租约，连同那份文档现在的几项属性（锁住文档行之后读的，看得到调用方刚做的改动）：
 * 所在的空间（对应 coversWriter 的 DocumentWriter：持有者、文档、空间）、创建人（与空间一起是访问策略判断用的 AccessTarget）、
 * 状态（删除的调用方先把文档放进回收站：回收站里的文档谁也不能编辑）
 */
export interface RevocableEditLease extends ObservedEditLease {
  readonly spaceId: string
  readonly createdBy: string
  readonly documentStatus: DocumentStatus
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
  requestId: l.requestId,
  requestedBy: l.requestedBy,
  requestSessionId: l.requestSessionId,
  requestedAt: l.requestedAt,
  requestExpiresAt: l.requestExpiresAt,
  requestDeclinedAt: l.requestDeclinedAt,
  reservedFor: l.reservedFor,
  reservedUntil: l.reservedUntil,
  takenOverTokenDigest: l.takenOverTokenDigest,
  takeover: l.takeover,
  // 与行出自同一条语句；按时间列的写法换成 Date（驱动把 timestamptz 原样当文本交回）
  now: sql<Date>`now()`.mapWith(l.acquiredAt),
}

/** 到期的时刻：数据库的 now() 加上有效期（申请与每次续租） */
const EXPIRES_AT = sql`now() + make_interval(secs => ${EDIT_LEASE_TTL_SECONDS})`

/**
 * 按时间还活着（M3-P5 设计 §3.5，DEF-044）：没到期、空闲不满 12 分钟——与有效条件的第 4、5 条（edit-lease-rules.ts）边界逐一相同，
 * 恰好到期、恰好空闲 12 分钟都算已经死了
 */
const ALIVE_BY_TIME = and(
  gt(l.expiresAt, sql`now()`),
  gt(l.lastActiveAt, sql`now() - make_interval(secs => ${EDIT_LEASE_IDLE_RECLAIM_SECONDS})`),
)

/** 改写为新的一代时旧行的这一列：条件成立就沿用，否则清空（条件与列都按旧行算：ON CONFLICT DO UPDATE 里表名指的是已有的那一行） */
function keptWhen(condition: SQL, column: AnyPgColumn): SQL {
  return sql`case when ${condition} then ${column} end`
}

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
 * edit-lease-statements.test.ts 逐种核对两边按同样的几项、同样的值筛选（多一项、少一项都算不一致）；真实数据库上的效果（结束谁的租约、
 * 只锁涉及的行、锁下再核对）由 tests/integration 的 documents/lease-revocation.test.ts 与 lease-revocation-locks.test.ts 覆盖
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
 * 心跳与释放只锁租约行；保存在文档行的锁下读它、不加锁。不加锁读是安全的，但理由要说全（M3-P1 审查 A7）：
 * 换成新的一代（申请）与收回（撤权）都要先拿文档行的锁，保存持着它，所以这两种改写不会夹在保存的读与提交之间；
 * 心跳与释放不锁文档行也会改这一行，但它们只续期或结束——与保存交错时，保存按"读到的那一刻"线性化（读到有效就是续期之前或结束之前）。
 * 以后要在不锁文档行的路上改别的列（例如持有者、代次）之前，先重新论证这一条
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
   * 持有者、登录、标签页、令牌摘要与代次换成新的，申请与续租的时间是 now()，最后活动是 now() 减去续上的页面带来的空闲秒数
   * （M3-P5 设计 §3.5），到期是 now() 加有效期，清掉明确结束的两列。M3-P5 的三组列（设计 §3.6、§3.7，探索报告 §3.4）：
   * - 请求编辑：新的持有者还是旧行的持有者（他自己的重试、续上、本人接管）就原样沿用，包括已谢绝的状态——否则持有者续上一次
   *   就把别人的请求悄悄弄丢了；换了别人就清掉（请求方续期得知请求已不在）。新的持有者就是请求方时，他不是旧行的持有者（表上的约束），
   *   同样清掉：请求已经实现，"请求方不是持有者"的约束要求在这同一条语句里清；
   * - 交出之后的保留：一律清掉。它只在明确结束的原因是 handed_over 时有（表上的约束），而这条语句清掉了明确结束，必须在同一条语句里清；
   * - 接管标记：这一代接管了占着的那一代（lease.takenOver：本人接管、强制接管）就写下它；不是接管时只在同一个页面（同一个登录、
   *   同一个标签页）重试时沿用上一代的——否则一次重试（包括一次接管的重试）就把"被接管"变回了笼统的 replaced；别的申请清掉。
   *   插入那一半同样写下给出的标记：接管时这一行一定在，写上只是让"给了就写下"不依赖这一点。
   * 沿用与否按旧行判断，写在这条语句里：改写之前的那一行在文档行的锁下，就是调用方判断时读到的那一行。返回写下的这一行
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
      lastActiveAt: sql`now() - make_interval(secs => ${lease.idleSeconds})`,
      endedAt: null,
      endReason: null,
    }
    const sameHolder = sql`${l.holderId} = ${lease.holderId}`
    const samePage = sql`${l.sessionId} = ${lease.sessionId} and ${l.clientInstanceId} = ${lease.clientInstanceId}`
    const written = lease.takenOver === undefined ? undefined : { takenOverTokenDigest: lease.takenOver.tokenDigest, takeover: lease.takenOver.takeover }
    const [row] = await executorOf(this.db, transaction)
      .insert(l)
      .values({ documentId: lease.documentId, ...generation, ...written })
      .onConflictDoUpdate({
        target: l.documentId,
        set: {
          ...generation,
          requestId: keptWhen(sameHolder, l.requestId),
          requestedBy: keptWhen(sameHolder, l.requestedBy),
          requestSessionId: keptWhen(sameHolder, l.requestSessionId),
          requestedAt: keptWhen(sameHolder, l.requestedAt),
          requestExpiresAt: keptWhen(sameHolder, l.requestExpiresAt),
          requestDeclinedAt: keptWhen(sameHolder, l.requestDeclinedAt),
          reservedFor: null,
          reservedUntil: null,
          ...written ?? { takenOverTokenDigest: keptWhen(samePage, l.takenOverTokenDigest), takeover: keptWhen(samePage, l.takeover) },
        },
      })
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error(`改写租约没有返回记录：${lease.documentId}`)
    return row
  }

  /**
   * 续租（调用方已锁住租约行，并判断过它仍然有效）：续租的时间是 now()，到期是 now() 加有效期；最后活动的时间是 now() 减去
   * 页面上报的空闲秒数，只前进不后退（不早于这一行原来的最后活动，M3-P5 设计 §3.5：续上的那一代带着页面的空闲，下一次心跳
   * 不能把它抹掉）、不晚于 now()。夹取写在这条语句里，按数据库的时间算到微秒——在应用里用 Date 算会截到毫秒。返回续租之后的这一行
   */
  async renew(documentId: string, idleSeconds: number, transaction: Transaction): Promise<ObservedEditLease> {
    const [row] = await executorOf(this.db, transaction)
      .update(l)
      .set({
        renewedAt: sql`now()`,
        expiresAt: EXPIRES_AT,
        lastActiveAt: sql`least(greatest(now() - make_interval(secs => ${idleSeconds}), ${l.lastActiveAt}), now())`,
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
   * 同 end，一条语句记下这些文档上的租约明确结束（收回写入权的第 3 步，P1 设计 §3.4.6：文件夹连同子树移走、归档时一次是一批，
   * 不逐份发语句）。调用方已按文档 id 的顺序锁住了这些文档行与租约行（lockInScope）；已经明确结束的不改。一串 id 作为一个数组参数
   */
  async endAll(documentIds: readonly string[], reason: EditLeaseEndReason, transaction: Transaction): Promise<void> {
    if (documentIds.length === 0)
      return
    await executorOf(this.db, transaction)
      .update(l)
      .set({ endedAt: sql`now()`, endReason: reason })
      .where(and(inIdArray(l.documentId, documentIds), isNull(l.endedAt)))
  }

  /**
   * 收回写入权（P1 设计 §3.4.6 第 1 步）：找出这次范围涉及的、没有明确结束而且按时间还活着的租约（范围的条件见 writersIn，
   * 与 coversWriter 同义；时间条件见 ALIVE_BY_TIME），先按文档 id 的顺序锁住它们的文档行，再按同样的顺序锁住这些租约行，
   * 返回锁住的租约（带文档所在的空间、创建人与状态：收回写入权按它们判断持有者还能不能编辑，见 RevocableEditLease）。
   * 调用方在改动权限的事务里调用，之前已经持有账户行、空间行、成员行或这些文档行（ADR-014 的锁顺序，文档行之后才是租约行）。
   * 第二步把条件再核对一次：第一步等文档行的锁时，别的申请可能已经提交、改写了租约（换了持有者），那条语句是按旧的租约行判断的范围；
   * 现在持着文档行的锁，租约不会再被改写（申请要先拿文档行的锁），读到的就是最终的。
   * 申请在撤权提交之前判断了权限、在它之后才提交时，租约行不在这里找得到的范围里，由有效条件的第 7 条在每次使用时让它失效（§3.4.6）。
   * 按时间已经死了的租约（到期、空闲满 12 分钟）不找（M3-P5 设计 §3.5，DEF-044）：它不可能再被续租或用来保存（心跳与保存都先判到期、
   * 空闲，续租要求有效），不必记 revoked、不必给代次加一——它照样按事实算异常结束，提醒得以保留；撤权也不再锁这批文档行。
   * 异常结束的租约里仍会被记 revoked 的只剩"登录已失效、还没到期"的（最长一个有效期）。时间按这个事务的 now() 判断：在它之前判断有效、在它之后
   * 才提交的心跳（租约恰好在两者之间到期）续上的租约不在这里，与申请交错的那一种同样由第 7 条（停用另由第 6 条）在每次使用时让它失效。
   * 文档的状态不过滤：删除的调用方先把文档放进回收站，它们上面的租约同样要结束
   */
  async lockInScope(scope: WriteAccessScope, transaction: Transaction): Promise<RevocableEditLease[]> {
    if ((scope.kind === 'documents' || scope.kind === 'userDocuments') && scope.documentIds.length === 0)
      return []
    const executor = executorOf(this.db, transaction)
    const open = and(isNull(l.endedAt), ALIVE_BY_TIME, writersIn(scope))
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
      .select({ ...COLUMNS, spaceId: d.spaceId, createdBy: d.createdBy, documentStatus: d.status })
      .from(l)
      .innerJoin(d, eq(d.id, l.documentId))
      .where(and(inIdArray(l.documentId, locked.map(row => row.id)), open))
      .orderBy(asc(l.documentId))
      .for('update', { of: l })
  }
}

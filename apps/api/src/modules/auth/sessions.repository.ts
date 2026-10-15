import type { Buffer } from 'node:buffer'
import type { SessionRevokeReason } from '../../db/schema/auth/index.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { authSessions } from '../../db/schema/auth/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

export interface NewSession {
  readonly userId: string
  readonly tokenHash: Buffer
  readonly idleMinutes: number
  readonly absoluteMinutes: number
}

export interface ActiveSession {
  readonly id: string
  readonly userId: string
  /** 距上次记录活动已超过顺延的间隔 */
  readonly stale: boolean
}

/** 同一行的有效性与最初撤销原因，避免写事务在两次读取之间取得矛盾事实。 */
export interface SessionState {
  readonly userId: string
  readonly revokedReason: SessionRevokeReason | null
  readonly active: boolean
}

const s = authSessions
const ACTIVE = sql<boolean>`${s.revokedAt} IS NULL AND ${s.idleExpiresAt} > now() AND ${s.absoluteExpiresAt} > now()`
const STATE_COLUMNS = { userId: s.userId, revokedReason: s.revokedReason, active: ACTIVE }

/** 活动顺延的最小间隔：不必每个请求都写一次库。 */
const TOUCH_INTERVAL = sql`interval '1 minute'`
/** 过期或撤销超过这么久的会话被清理。 */
const RETENTION = sql`interval '30 days'`
const PURGE_BATCH = 100

/** 只有它读写 auth_sessions（规范 §1.2）。时间一律用数据库时间。 */
@Injectable()
export class SessionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(session: NewSession, transaction?: Transaction): Promise<{ id: string }> {
    const [row] = await executorOf(this.db, transaction)
      .insert(authSessions)
      .values({
        userId: session.userId,
        tokenHash: session.tokenHash,
        idleExpiresAt: sql`now() + make_interval(mins => ${session.idleMinutes})`,
        absoluteExpiresAt: sql`now() + make_interval(mins => ${session.absoluteMinutes})`,
      })
      .returning({ id: authSessions.id })
    if (row === undefined)
      throw new Error('新建会话没有返回记录')
    return row
  }

  /** 没有撤销、没有超过空闲过期与绝对过期的会话。 */
  async findActive(tokenHash: Buffer): Promise<ActiveSession | undefined> {
    const [row] = await this.db
      .select({ id: s.id, userId: s.userId, stale: sql<boolean>`${s.lastSeenAt} < now() - ${TOUCH_INTERVAL}` })
      .from(s)
      .where(and(eq(s.tokenHash, tokenHash), ACTIVE))
    return row
  }

  /**
   * 这条会话（按 id，主键）仍然有效：没有撤销、没有超过空闲过期与绝对过期，条件与 findActive 相同。
   * 租约与请求编辑的规则在所在快照/事务中询问；当前请求的开场复核经 stateById 同时取得失效原因。
   */
  async isActiveById(id: string, transaction: Transaction): Promise<boolean> {
    const [row] = await executorOf(this.db, transaction)
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.id, id), ACTIVE))
    return row !== undefined
  }

  /** 已认证的请求在原快照/写事务里复核，失效原因与有效性来自同一条语句。 */
  async stateById(id: string, transaction: Transaction): Promise<SessionState | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select(STATE_COLUMNS)
      .from(s)
      .where(eq(s.id, id))
    return row
  }

  /** 只按真正持有的令牌摘要识别；不通过用户名推测已失效的会话。 */
  async stateByTokenHash(tokenHash: Buffer, transaction?: Transaction): Promise<SessionState | undefined> {
    const [row] = await executorOf(this.db, transaction)
      .select(STATE_COLUMNS)
      .from(s)
      .where(eq(s.tokenHash, tokenHash))
    return row
  }

  /** 记录活动，空闲过期顺延，但不超过绝对过期。 */
  async touch(id: string, idleMinutes: number): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ lastSeenAt: sql`now()`, idleExpiresAt: sql`least(now() + make_interval(mins => ${idleMinutes}), ${authSessions.absoluteExpiresAt})` })
      .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)))
  }

  /** 撤销；空闲过期一并提前到现在，清理只看这一列。返回这次撤销了没有：已经撤销过的不再改（原因保留最初的那个），返回假 */
  async revoke(where: { id: string } | { tokenHash: Buffer }, reason: SessionRevokeReason, transaction?: Transaction): Promise<boolean> {
    const target = 'id' in where ? eq(authSessions.id, where.id) : eq(authSessions.tokenHash, where.tokenHash)
    const rows = await executorOf(this.db, transaction)
      .update(authSessions)
      .set({ revokedAt: sql`now()`, revokedReason: reason, idleExpiresAt: sql`least(${authSessions.idleExpiresAt}, now())` })
      .where(and(target, isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id })
    return rows.length > 0
  }

  /**
   * 撤销这个人全部未撤销的会话（M2-P1 设计 §3.5）。
   * 已经过期的也一并标记：不影响结果，清理照常按空闲过期的时间。
   */
  async revokeAllOfUser(userId: string, reason: SessionRevokeReason, transaction?: Transaction): Promise<void> {
    await executorOf(this.db, transaction)
      .update(authSessions)
      .set({ revokedAt: sql`now()`, revokedReason: reason, idleExpiresAt: sql`least(${authSessions.idleExpiresAt}, now())` })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
  }

  /**
   * 删除一小批过期或撤销已超过 30 天的会话。
   * 在事务之外执行，跳过别人正锁着的行，不与登录、退出互相等待（P3 审查 A2）；删除时再核对一次过期条件。
   */
  async purgeExpired(): Promise<void> {
    const expired = lt(authSessions.idleExpiresAt, sql`now() - ${RETENTION}`)
    const batch = this.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(expired)
      .limit(PURGE_BATCH)
      .for('update', { skipLocked: true })
    await this.db.delete(authSessions).where(and(inArray(authSessions.id, batch), expired))
  }
}

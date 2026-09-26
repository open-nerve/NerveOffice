import type { Buffer } from 'node:buffer'
import type { SessionRevokeReason } from '../../db/schema/auth/index.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
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
    const s = authSessions
    const [row] = await this.db
      .select({ id: s.id, userId: s.userId, stale: sql<boolean>`${s.lastSeenAt} < now() - ${TOUCH_INTERVAL}` })
      .from(s)
      .where(and(eq(s.tokenHash, tokenHash), isNull(s.revokedAt), gt(s.idleExpiresAt, sql`now()`), gt(s.absoluteExpiresAt, sql`now()`)))
    return row
  }

  /** 记录活动，空闲过期顺延，但不超过绝对过期。 */
  async touch(id: string, idleMinutes: number): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ lastSeenAt: sql`now()`, idleExpiresAt: sql`least(now() + make_interval(mins => ${idleMinutes}), ${authSessions.absoluteExpiresAt})` })
      .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)))
  }

  /** 撤销；空闲过期一并提前到现在，清理只看这一列。 */
  async revoke(where: { id: string } | { tokenHash: Buffer }, reason: SessionRevokeReason, transaction?: Transaction): Promise<void> {
    const target = 'id' in where ? eq(authSessions.id, where.id) : eq(authSessions.tokenHash, where.tokenHash)
    await executorOf(this.db, transaction)
      .update(authSessions)
      .set({ revokedAt: sql`now()`, revokedReason: reason, idleExpiresAt: sql`least(${authSessions.idleExpiresAt}, now())` })
      .where(and(target, isNull(authSessions.revokedAt)))
  }

  /** 删除一小批过期或撤销已超过 30 天的会话。 */
  async purgeExpired(transaction?: Transaction): Promise<void> {
    const expired = this.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(lt(authSessions.idleExpiresAt, sql`now() - ${RETENTION}`))
      .limit(PURGE_BATCH)
    await executorOf(this.db, transaction).delete(authSessions).where(inArray(authSessions.id, expired))
  }
}

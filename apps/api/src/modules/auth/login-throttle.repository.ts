import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { authLoginThrottles } from '../../db/schema/auth/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

export interface ThrottlePolicy {
  readonly maxFailures: number
  readonly windowMinutes: number
  readonly lockoutMinutes: number
}

/** 离解锁还有多少秒（向上取整，用数据库时间）；没有锁定时为 undefined。 */
export type LockedForSeconds = number | undefined

/** 清理时每次最多删除的条数：顺带执行，不能拖慢登录。 */
const PURGE_BATCH = 100

/** 只有它读写 auth_login_throttles（规范 §1.2）。计数的键只存摘要。 */
@Injectable()
export class LoginThrottleRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 这些键里仍在锁定中的，最晚的那个还要多久解锁。 */
  async lockedFor(keyHashes: readonly Buffer[]): Promise<LockedForSeconds> {
    const [row] = await this.db
      .select({ seconds: sql<string | null>`ceil(extract(epoch from max(${authLoginThrottles.lockedUntil}) - now()))` })
      .from(authLoginThrottles)
      .where(and(inArray(authLoginThrottles.keyHash, [...keyHashes]), gt(authLoginThrottles.lockedUntil, sql`now()`)))
    return row?.seconds === null || row?.seconds === undefined ? undefined : Number(row.seconds)
  }

  /**
   * 记一次失败，原子地更新计数（一条 INSERT … ON CONFLICT）：
   * 窗口已过，或者上一次的锁定已经结束，就从 1 重新计数；达到上限时锁定。返回这个键因此锁定的时长。
   */
  async recordFailure(keyHash: Buffer, policy: ThrottlePolicy, transaction?: Transaction): Promise<LockedForSeconds> {
    const t = authLoginThrottles
    const window = sql`make_interval(mins => ${policy.windowMinutes})`
    const lockout = sql`make_interval(mins => ${policy.lockoutMinutes})`
    const restart = sql`(${t.windowStartedAt} <= now() - ${window} OR (${t.lockedUntil} IS NOT NULL AND ${t.lockedUntil} <= now()))`
    const failures = sql`CASE WHEN ${restart} THEN 1 ELSE ${t.failures} + 1 END`
    const [row] = await executorOf(this.db, transaction)
      .insert(t)
      .values({
        keyHash,
        failures: 1,
        windowStartedAt: sql`now()`,
        lockedUntil: sql`CASE WHEN 1 >= ${policy.maxFailures} THEN now() + ${lockout} ELSE NULL END`,
      })
      .onConflictDoUpdate({
        target: t.keyHash,
        set: {
          failures,
          windowStartedAt: sql`CASE WHEN ${restart} THEN now() ELSE ${t.windowStartedAt} END`,
          lockedUntil: sql`CASE WHEN ${failures} >= ${policy.maxFailures} THEN now() + ${lockout} WHEN ${restart} THEN NULL ELSE ${t.lockedUntil} END`,
        },
      })
      .returning({ seconds: sql<string | null>`ceil(extract(epoch from ${t.lockedUntil} - now()))` })
    return row?.seconds === null || row?.seconds === undefined ? undefined : Number(row.seconds)
  }

  async reset(keyHash: Buffer, transaction?: Transaction): Promise<void> {
    await executorOf(this.db, transaction).delete(authLoginThrottles).where(eq(authLoginThrottles.keyHash, keyHash))
  }

  /** 删除一小批窗口与锁定都已过期的计数：表不会无限增长。 */
  async purgeExpired(windowMinutes: number, transaction?: Transaction): Promise<void> {
    const t = authLoginThrottles
    const expired = this.db
      .select({ keyHash: t.keyHash })
      .from(t)
      .where(and(
        lt(t.windowStartedAt, sql`now() - make_interval(mins => ${windowMinutes})`),
        or(isNull(t.lockedUntil), lt(t.lockedUntil, sql`now()`)),
      ))
      .limit(PURGE_BATCH)
    await executorOf(this.db, transaction).delete(t).where(inArray(t.keyHash, expired))
  }
}

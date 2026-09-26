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

/** 占到的一个名额。 */
export interface Reservation {
  /** 占用时所在窗口的开始时间（UTC 文本，精确到微秒）：退回时核对，窗口已经重新开始就不退 */
  readonly window: string
  /** 这次占用使计数达到上限而锁定时，离解锁的秒数 */
  readonly lockedForSeconds: LockedForSeconds
}

/** 清理时每次最多删除的条数：顺带执行，不能拖慢登录。 */
const PURGE_BATCH = 100

function toSeconds(value: string | null | undefined): LockedForSeconds {
  return value === null || value === undefined ? undefined : Number(value)
}

/**
 * 只有它读写 auth_login_throttles（规范 §1.2）。计数的键只存摘要。
 * failures 是窗口内失败与正在验证的尝试次数：验证之前先占用名额（P3 设计 §3.5），成功时再退回。
 */
@Injectable()
export class LoginThrottleRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 这些键里仍在锁定中的，最晚的那个还要多久解锁。 */
  async lockedFor(keyHashes: readonly Buffer[]): Promise<LockedForSeconds> {
    const [row] = await this.db
      .select({ seconds: sql<string | null>`ceil(extract(epoch from max(${authLoginThrottles.lockedUntil}) - now()))` })
      .from(authLoginThrottles)
      .where(and(inArray(authLoginThrottles.keyHash, [...keyHashes]), gt(authLoginThrottles.lockedUntil, sql`now()`)))
    return toSeconds(row?.seconds)
  }

  /**
   * 占用一个名额，一条 INSERT … ON CONFLICT 原子地完成：
   * 计数加一，窗口已过或者上一次的锁定已经结束时从 1 重新计数，加到上限时锁定。
   * 锁定中不占用（不更新，也就不返回行），返回 undefined。
   */
  async reserve(keyHash: Buffer, policy: ThrottlePolicy): Promise<Reservation | undefined> {
    const t = authLoginThrottles
    const window = sql`make_interval(mins => ${policy.windowMinutes})`
    const lockout = sql`make_interval(mins => ${policy.lockoutMinutes})`
    const restart = sql`(${t.windowStartedAt} <= now() - ${window} OR (${t.lockedUntil} IS NOT NULL AND ${t.lockedUntil} <= now()))`
    const count = sql`CASE WHEN ${restart} THEN 1 ELSE ${t.failures} + 1 END`
    const [row] = await this.db
      .insert(t)
      .values({
        keyHash,
        failures: 1,
        windowStartedAt: sql`now()`,
        lockedUntil: sql`CASE WHEN 1 >= ${policy.maxFailures} THEN now() + ${lockout} END`,
      })
      .onConflictDoUpdate({
        target: t.keyHash,
        set: {
          failures: count,
          windowStartedAt: sql`CASE WHEN ${restart} THEN now() ELSE ${t.windowStartedAt} END`,
          lockedUntil: sql`CASE WHEN ${count} >= ${policy.maxFailures} THEN now() + ${lockout} END`,
        },
        setWhere: sql`${t.lockedUntil} IS NULL OR ${t.lockedUntil} <= now()`,
      })
      .returning({
        // 与文档列表的游标一样用 UTC 文本：换成 JavaScript 的 Date 会丢掉微秒，也不受连接的时区与日期格式影响
        window: sql<string>`to_char(${t.windowStartedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        lockedForSeconds: sql<string | null>`ceil(extract(epoch from ${t.lockedUntil} - now()))`,
      })
    return row === undefined ? undefined : { window: row.window, lockedForSeconds: toSeconds(row.lockedForSeconds) }
  }

  /**
   * 退回一个名额：计数减一；计数只有达到上限时才会锁定，退回之后低于上限，还在生效的锁定随之解除。
   * 窗口已经重新开始时不退，免得减掉新窗口的计数。
   */
  async release(keyHash: Buffer, window: string, transaction?: Transaction): Promise<void> {
    const t = authLoginThrottles
    await executorOf(this.db, transaction)
      .update(t)
      .set({
        failures: sql`${t.failures} - 1`,
        lockedUntil: sql`CASE WHEN ${t.lockedUntil} > now() THEN NULL ELSE ${t.lockedUntil} END`,
      })
      .where(and(eq(t.keyHash, keyHash), eq(t.windowStartedAt, sql`${window}::timestamptz`), gt(t.failures, 0)))
  }

  async reset(keyHash: Buffer, transaction?: Transaction): Promise<void> {
    await executorOf(this.db, transaction).delete(authLoginThrottles).where(eq(authLoginThrottles.keyHash, keyHash))
  }

  /**
   * 删除一小批窗口与锁定都已过期的计数，表不会无限增长。
   * 在事务之外执行，跳过别人正锁着的行：放在登录的事务里时，并发的清理互相等待、死锁（P3 审查 A2）。
   * 删除时再核对一次过期条件，不删刚刚重新开始计数的行。
   */
  async purgeExpired(windowMinutes: number): Promise<void> {
    const t = authLoginThrottles
    const expired = and(
      lt(t.windowStartedAt, sql`now() - make_interval(mins => ${windowMinutes})`),
      or(isNull(t.lockedUntil), lt(t.lockedUntil, sql`now()`)),
    )
    const batch = this.db
      .select({ keyHash: t.keyHash })
      .from(t)
      .where(expired)
      .limit(PURGE_BATCH)
      .for('update', { skipLocked: true })
    await this.db.delete(t).where(and(inArray(t.keyHash, batch), expired))
  }
}

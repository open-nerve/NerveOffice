// 两个连接的并发测试（M2-P1 审查 A1、A2、A9、A10、A12）：一个连接开着事务、持有锁；等被测的请求在这把锁上等着了，
// 再在同一个事务里改数据、提交。被测的请求随后拿到锁，看到的是改过的数据。不靠固定时长的等待，结果是确定的。
import type pg from 'pg'
import type { TestDatabase } from './database.ts'
import { setTimeout as delay } from 'node:timers/promises'

export interface HeldLockRace<T> {
  /** 在事务里取锁（例如 SELECT … FOR UPDATE、pg_advisory_xact_lock） */
  readonly hold: (client: pg.Client) => Promise<unknown>
  /** 被测的请求：会在这把锁上等待 */
  readonly request: () => Promise<T>
  /** 请求等着的时候，在同一个事务里改数据；随后提交 */
  readonly change: (client: pg.Client) => Promise<unknown>
  /**
   * 要等到几个连接在等锁（默认 1）：并发的几个请求都走到锁上再放开。只数这个库里的连接，
   * 被持锁的事务挡住的、排在别的请求后面的都算（pg_blocking_pids 不为空）
   */
  readonly waiting?: number
}

/** 等到这个库里有 count 个连接在等锁，其中至少一个被 holderPid 挡住 */
async function waitUntilBlocked(database: TestDatabase, holderPid: number, count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const blocked = await database.query(async client => (await client.query<{ total: number, byHolder: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS "byHolder"
       FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      [holderPid],
    )).rows[0])
    if (blocked !== undefined && blocked.byHolder > 0 && blocked.total >= count)
      return
    if (performance.now() > deadline)
      throw new Error(`${timeoutMs} ms 内没有等到 ${count} 个请求在锁上等待（现在 ${blocked?.total ?? 0} 个）`)
    await delay(20)
  }
}

export async function raceAgainstHeldLock<T>(database: TestDatabase, race: HeldLockRace<T>): Promise<T> {
  return database.query(async (client) => {
    await client.query('BEGIN')
    let pending: Promise<T> | undefined
    try {
      await race.hold(client)
      const holderPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
      if (holderPid === undefined)
        throw new Error('取不到持锁连接的进程号')
      pending = race.request()
      // 请求在锁上等着之前就失败了：由下面的 await pending 报告，这里不让它成为未处理的拒绝
      pending.catch(() => {})
      await waitUntilBlocked(database, holderPid, race.waiting ?? 1)
      await race.change(client)
      await client.query('COMMIT')
    }
    catch (error) {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      throw error
    }
    return pending
  })
}

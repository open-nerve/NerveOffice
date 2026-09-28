// 两个连接的并发测试（M2-P1 审查 A1、A2、A9、A10、A12）：一个连接开着事务、持有锁；等被测的请求在锁上等着了，
// 再在同一个事务里改数据、提交。被测的请求随后拿到锁，看到的是改过的数据。不靠固定时长的等待，结果是确定的。
import type pg from 'pg'
import type { TestDatabase } from './database.ts'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 等到这个库里有 count 个连接在等锁（被持锁的事务挡住的、排在别的请求后面的都算）。
 * inFlight 是已经发出的前几步：其中任何一步先结束了（没走到锁上），立即失败并报出它的结果（复验 X3）
 */
export type WaitForWaiting = (count: number, ...inFlight: Promise<unknown>[]) => Promise<void>

export interface HeldLockRace<T> {
  /** 在事务里取锁（例如 SELECT … FOR UPDATE、pg_advisory_xact_lock） */
  readonly hold: (client: pg.Client) => Promise<unknown>
  /**
   * 被测的请求：会在这把锁上等待。分几步发出时（例如先让停用锁住账户行、再发登录），
   * 用 waitForWaiting 等前面的请求在锁上等着了再发下一个
   */
  readonly request: (waitForWaiting: WaitForWaiting) => Promise<T>
  /** 请求等着的时候，在同一个事务里改数据；随后提交 */
  readonly change: (client: pg.Client) => Promise<unknown>
  /**
   * 要等到几个连接在等锁（默认 1）：并发的几个请求都走到锁上再放开。只数这个库里的连接，
   * 被持锁的事务挡住的、排在别的请求后面的都算（pg_blocking_pids 不为空）
   */
  readonly waiting?: number
}

/** 最多等多久：比应用的锁等待上限（5 秒）长也没关系，请求先结束就立即失败（见 waitUntilBlocked） */
const WAIT_TIMEOUT_MS = 10_000

/**
 * 等到这个库里有 count 个连接在等锁，其中至少一个被 holderPid 挡住。
 * 被测的请求已经结束（没走到锁上就完成了，或者在别处等锁超时）时立即失败，报出它的结果，不空等到超时（复验 N5）
 */
async function waitUntilBlocked(database: TestDatabase, holderPid: number, count: number, ended: () => string | undefined): Promise<void> {
  const deadline = performance.now() + WAIT_TIMEOUT_MS
  for (;;) {
    const blocked = await database.query(async client => (await client.query<{ total: number, byHolder: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS "byHolder"
       FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      [holderPid],
    )).rows[0])
    if (blocked !== undefined && blocked.byHolder > 0 && blocked.total >= count)
      return
    const outcome = ended()
    if (outcome !== undefined)
      throw new Error(`被测的请求在锁上等待之前就结束了（${outcome}），没有等到 ${count} 个请求等锁（现在 ${blocked?.total ?? 0} 个）`)
    if (performance.now() > deadline)
      throw new Error(`${WAIT_TIMEOUT_MS} ms 内没有等到 ${count} 个请求在锁上等待（现在 ${blocked?.total ?? 0} 个）`)
    await delay(20)
  }
}

/** 请求结束时的简短说明：HTTP 响应给出状态码 */
function describeOutcome(value: unknown): string {
  const responses = (Array.isArray(value) ? value : [value]).filter((item): item is Response => item instanceof Response)
  return responses.length > 0 ? `HTTP ${responses.map(response => response.status).join('、')}` : '已完成'
}

/** 记下一个请求的结局；同时接住它的拒绝，免得在等待出错时成为未处理的拒绝 */
function watch(promise: Promise<unknown>): () => string | undefined {
  let outcome: string | undefined
  promise.then(
    (value) => {
      outcome = describeOutcome(value)
    },
    (error: unknown) => {
      outcome = `失败：${String(error)}`
    },
  )
  return () => outcome
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
      /** 整个请求的结局：请求发出之后才开始记 */
      let requestOutcome: () => string | undefined = () => undefined
      const ended = (): string | undefined => requestOutcome()
      pending = race.request(async (count, ...inFlight) => {
        const steps = inFlight.map(watch)
        return waitUntilBlocked(database, holderPid, count, () => steps.map(step => step()).find(result => result !== undefined) ?? ended())
      })
      requestOutcome = watch(pending)
      await waitUntilBlocked(database, holderPid, race.waiting ?? 1, ended)
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

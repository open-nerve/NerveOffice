// 两个连接的并发测试（M2-P1 审查 A1、A2、A9、A10、A12）：一个连接开着事务、持有锁；等被测的请求在锁上等着了，
// 再在同一个事务里改数据、提交。被测的请求随后拿到锁，看到的是改过的数据。不靠固定时长的等待，结果是确定的。
// 数据库繁忙的用例（M2-P6 复核 A 的 G-2）另用 whileHolding 与表锁：持着锁直到被测的请求结束，请求一定是等满时限失败。
import type { TestDatabase } from './database.ts'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

/** 分几步发出请求时用：每一步经 step 登记；waitForWaiting 等到这个库里有 count 个连接在等锁 */
export interface HeldLockSteps {
  /** 登记一步：任何登记过的一步先结束了（没走到锁上），等待立即失败并报出它的结果（复验 X3） */
  readonly step: <S>(request: Promise<S>) => Promise<S>
  /** 等到这个库里有 count 个连接在等锁（被持锁的事务挡住的、排在别的请求后面的都算） */
  readonly waitForWaiting: (count: number) => Promise<void>
}

export interface HeldLockRace<T> {
  /** 在事务里取锁（例如 SELECT … FOR UPDATE、pg_advisory_xact_lock） */
  readonly hold: (client: pg.Client) => Promise<unknown>
  /**
   * 被测的请求：会在这把锁上等待。分几步发出时（例如先让停用锁住账户行、再发登录），每一步经 step 登记，
   * 用 waitForWaiting 等前面的请求在锁上等着了再发下一个
   */
  readonly request: (steps: HeldLockSteps) => Promise<T>
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

/** 这个库里在等锁的连接数（被谁挡住的都算） */
async function waitingConnections(database: TestDatabase): Promise<number> {
  const row = await database.query(async client => (await client.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0',
  )).rows[0])
  return row?.total ?? 0
}

/**
 * 持锁期间发出的请求是不是不等锁就走完了：等到它结束（true），或者这个库里等锁的连接到了 waiting 个、它也在等锁了（false）。
 * 用在 raceAgainstHeldLock 的 change 里：被测的请求已经在锁上等着，这时发出的另一个请求应当不受它影响（M2-P6 复验 N1）。
 * 返回 false 时请求仍在进行，调用方放锁之后再取它的结果
 */
export async function completesWithoutWaiting(database: TestDatabase, request: Promise<unknown>, waiting: number): Promise<boolean> {
  let ended = false
  const settled = (): void => {
    ended = true
  }
  request.then(settled, settled)
  const deadline = performance.now() + WAIT_TIMEOUT_MS
  for (;;) {
    if (ended)
      return true
    const total = await waitingConnections(database)
    // 查询期间它可能刚结束：结束了就不算在等锁
    if (ended)
      return true
    if (total >= waiting)
      return false
    if (performance.now() > deadline)
      throw new Error(`${WAIT_TIMEOUT_MS} ms 内请求既没有结束，也没有等到 ${waiting} 个连接在等锁（现在 ${total} 个）`)
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
      /** 登记过的每一步与整个请求的结局：任何一个先有了结局，等待就立即失败 */
      const outcomes: (() => string | undefined)[] = []
      const ended = (): string | undefined => outcomes.map(outcome => outcome()).find(result => result !== undefined)
      pending = race.request({
        step: async (request) => {
          outcomes.push(watch(request))
          return request
        },
        waitForWaiting: async count => waitUntilBlocked(database, holderPid, count, ended),
      })
      outcomes.push(watch(pending))
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

/**
 * 在一个事务里持着锁，直到 request 结束（不论成败）才回滚：被测的请求一定是等满时限失败，而不是抢在锁之前
 * （数据库繁忙的用例：应用把等锁的时限调小，M2-P6 复核 A 的 G-2）
 */
export async function whileHolding<T>(database: TestDatabase, hold: (client: pg.Client) => Promise<unknown>, request: () => Promise<T>): Promise<T> {
  return database.query(async (client) => {
    await client.query('BEGIN')
    try {
      await hold(client)
      return await request()
    }
    finally {
      await client.query('ROLLBACK')
    }
  })
}

/** 在持锁的事务里锁住整张表（ACCESS EXCLUSIVE）：连普通的读也要等它。表名是测试里写定的 */
export function lockTable(table: string) {
  return async (client: pg.Client) => client.query(`LOCK TABLE ${pg.escapeIdentifier(table)} IN ACCESS EXCLUSIVE MODE`)
}

/** 另一个连接上要的一把表锁 */
export interface TableLock {
  /** 拿到锁时兑现（别的事务持有这张表上的锁时，它排着） */
  readonly granted: Promise<void>
  /** 断开那个连接：没拿到的不再排，拿到的随事务一起放开 */
  readonly release: () => Promise<void>
}

/**
 * 在另一个连接上给整张表要一把 ACCESS EXCLUSIVE 锁，不等拿到就返回（M2-P6 第 3 片复验）。
 * 排着的这把锁挡住之后所有新来的读写；已经持有这张表上的锁的事务再要锁时，PostgreSQL 让它排到等待者前面，不受影响。
 * 所以给一个碰过这张表、还没提交的事务排上这把锁：它在提交之前读这张表照常，提交之后谁再读都要等到超时
 */
export async function requestTableLock(database: TestDatabase, table: string): Promise<TableLock> {
  const client = new pg.Client({ connectionString: database.url, connectionTimeoutMillis: 5_000 })
  await client.connect()
  await client.query('BEGIN')
  const granted = client.query(`LOCK TABLE ${pg.escapeIdentifier(table)} IN ACCESS EXCLUSIVE MODE`).then(() => undefined)
  // 先接住：断开时还没拿到的话，它以连接断开失败
  granted.catch(() => {})
  return { granted, release: async () => client.end() }
}

import type { AppConfig } from '../config/index.ts'
import type { AppLogger } from '../logging/index.ts'
import type { SnapshotScope } from './snapshot-scope.ts'
import pg from 'pg'

/** 出现在 pg_stat_activity 里的应用名，便于排查连接。 */
export const APPLICATION_NAME = 'nerve-office-api'

/** 只读快照进行中在连接池上查询、借连接的说明（ADR-017）。 */
export const POOL_IN_SNAPSHOT_MESSAGE = '只读快照进行中不能在连接池上查询或借连接：快照里的读方法要传快照的事务（ADR-017），否则读到的是快照之外的数据'

/** 客户端侧的查询时限比语句超时多出的余量：语句超时由数据库执行，这里只兜住数据库没有回应的情况。 */
const QUERY_TIMEOUT_MARGIN_MS = 5_000
/** 连接空闲多久开始发 TCP keepalive 探测：不设时用系统默认（常见是 2 小时），等于没开（复验 N2）。 */
export const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000

/**
 * 连接池与超时（P2 设计 §3.7）：处理时间的上限由语句超时、等锁超时与取连接的超时保证。
 * 只读快照进行中，连接池上的查询与借连接一律报错（refuseInsideSnapshot）
 */
export function createPool(settings: AppConfig['database'], logger: AppLogger, snapshots: SnapshotScope): pg.Pool {
  const pool = new pg.Pool({
    connectionString: settings.url.reveal(),
    max: settings.poolMax,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: APPLICATION_NAME,
    statement_timeout: settings.statementTimeoutMs,
    lock_timeout: settings.lockTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
    // 连接静默断开（主机宕机、NAT 丢弃连接）时，TCP keepalive 让它尽快失败，查询不会无限等待（审查 A8）
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
    query_timeout: settings.statementTimeoutMs + QUERY_TIMEOUT_MARGIN_MS,
  })
  // 借出期间连接被断开（事务中空闲超时、数据库重启、管理员终止、网络中断）时，pg 在这个连接上触发 error；
  // 连接池借出连接时会摘掉自己的监听，没有监听者的 error 事件会让整个进程退出（审查 A1）。
  // 所以每个新连接都挂一个常驻的监听；出错的连接归还时，连接池会把它丢弃
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.error('数据库连接出错', { err: error })
    })
  })
  // 空闲连接出错时连接池也会转发一次；连接上的监听已经记过日志，这里只为不让它成为未监听的 error 事件
  pool.on('error', () => {})
  refuseInsideSnapshot(pool, snapshots)
  return pool
}

/** 连接池上会被包装的两个入口：查询（仓储的 Drizzle 实例在连接池上执行语句就是它）与借连接 */
type PoolEntries = Pick<pg.Pool, 'query' | 'connect'>

/** 包装时不区分 pg 的各种重载：参数原样转交，结果原样交回 */
type PoolEntry = (...args: unknown[]) => unknown

/**
 * 只读快照进行中，连接池上的查询与借连接一律报错（M2 Codex 评审复验的必须修 1，ADR-017）。
 * 快照里的语句都在快照借出的那个连接上（pg.PoolClient 的 query），不经这里；经这里的就是快照之外的语句：
 * - 仓储的读方法漏传了快照的事务，executorOf 退回连接池；
 * - 仓储直接用连接池（this.db）的写法。
 * 它们读到的是此刻最新的数据，不在快照的时刻：判断权限与读数据又分开了，撤权之后才写进去的数据可能被带出去。
 * 原来这样漏传是悄悄的（复验的变异 M06–M08 去掉三处事务参数，整套测试都没发现），现在直接报错：测试与 E2E 里立刻失败，
 * 生产里是意外错误（500）——宁可失败，不越权。快照里再开事务由 TransactionRunner 先拒绝（NESTED_IN_SNAPSHOT_MESSAGE），走不到这里。
 * 照 pg 的约定交回错误：带回调的调用经回调（异步），否则返回被拒绝的 Promise，不同步抛出。
 * 只看"正在快照里"的标记（SnapshotScope）：快照之外、快照结束之后（快照里排下、结束之后才执行的操作）照常
 */
export function refuseInsideSnapshot(pool: PoolEntries, snapshots: SnapshotScope): void {
  pool.query = guarded(pool.query.bind(pool), snapshots) as unknown as PoolEntries['query']
  pool.connect = guarded(pool.connect.bind(pool), snapshots) as unknown as PoolEntries['connect']
}

function guarded(original: PoolEntry, snapshots: SnapshotScope): PoolEntry {
  return (...args) => {
    if (!snapshots.active())
      return original(...args)
    const error = new Error(POOL_IN_SNAPSHOT_MESSAGE)
    const callback = args.at(-1)
    if (typeof callback !== 'function')
      return Promise.reject(error)
    queueMicrotask(() => (callback as (error: Error) => void)(error))
    return undefined
  }
}

import type { AppConfig } from '../config/index.ts'
import type { AppLogger } from '../logging/index.ts'
import pg from 'pg'

/** 出现在 pg_stat_activity 里的应用名，便于排查连接。 */
export const APPLICATION_NAME = 'nerve-office-api'

/** 客户端侧的查询时限比语句超时多出的余量：语句超时由数据库执行，这里只兜住数据库没有回应的情况。 */
const QUERY_TIMEOUT_MARGIN_MS = 5_000
/** 连接空闲多久开始发 TCP keepalive 探测：不设时用系统默认（常见是 2 小时），等于没开（复验 N2）。 */
export const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000

/** 连接池与超时（P2 设计 §3.7）：处理时间的上限由语句超时、等锁超时与取连接的超时保证。 */
export function createPool(settings: AppConfig['database'], logger: AppLogger): pg.Pool {
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
  return pool
}

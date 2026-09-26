import type { AppConfig } from '../config/index.ts'
import type { AppLogger } from '../logging/index.ts'
import pg from 'pg'

/** 出现在 pg_stat_activity 里的应用名，便于排查连接。 */
export const APPLICATION_NAME = 'nerve-office-api'

/** 连接池与超时（P2 设计 §3.7）：处理时间的上限由语句超时、等锁超时与取连接的超时保证。 */
export function createPool(settings: AppConfig['database'], logger: AppLogger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: settings.url,
    max: settings.poolMax,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: APPLICATION_NAME,
    statement_timeout: settings.statementTimeoutMs,
    lock_timeout: settings.lockTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
  })
  // 空闲连接被数据库断开等错误只记日志；没有监听时，pg 会把它当作未处理的错误让进程退出
  pool.on('error', (error) => {
    logger.error('连接池里的空闲连接出错', { err: error })
  })
  return pool
}

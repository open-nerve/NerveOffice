import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/index.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { APPLICATION_NAME, createPool, KEEP_ALIVE_INITIAL_DELAY_MS } from './pool.ts'

const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())

describe('createPool', () => {
  it('连接参数：超时取自配置，TCP keepalive 从空闲 10 秒开始探测，客户端侧的查询时限比语句超时多 5 秒（审查 A8、复验 N2）', async () => {
    const settings = loadConfig({
      NERVE_DATABASE_URL: 'postgres://nerve:pw@127.0.0.1:1/nerve',
      NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '3000',
    }).database
    // 连接池按需建立连接：这里不会真的连接数据库
    const pool = createPool(settings, logger)
    try {
      expect(pool.options).toMatchObject({
        max: settings.poolMax,
        connectionTimeoutMillis: settings.connectTimeoutMs,
        application_name: APPLICATION_NAME,
        statement_timeout: 3_000,
        lock_timeout: settings.lockTimeoutMs,
        idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
        query_timeout: 8_000,
      })
      expect(KEEP_ALIVE_INITIAL_DELAY_MS).toBe(10_000)
    }
    finally {
      await pool.end()
    }
  })
})

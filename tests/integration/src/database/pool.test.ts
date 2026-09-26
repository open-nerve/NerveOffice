// 连接池的超时设置（P2 设计 §3.3、§3.7）：取自配置，作用在应用的每个连接上。
import type { Database } from '@nerve-office/api'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { DATABASE } from '@nerve-office/api'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({
    env: {
      NERVE_DATABASE_URL: database.url,
      NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '300',
      NERVE_DATABASE_LOCK_TIMEOUT_MS: '400',
      NERVE_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '500',
    },
  })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

describe('连接池', () => {
  it('每个连接都带上配置的超时与应用名', async () => {
    const db = app.runtime.get<Database>(DATABASE)
    const result = await db.execute<{ statement_timeout: string, lock_timeout: string, idle: string, application_name: string }>(sql`
      SELECT current_setting('statement_timeout') AS statement_timeout,
             current_setting('lock_timeout') AS lock_timeout,
             current_setting('idle_in_transaction_session_timeout') AS idle,
             current_setting('application_name') AS application_name`)
    expect(result.rows[0]).toEqual({ statement_timeout: '300ms', lock_timeout: '400ms', idle: '500ms', application_name: 'nerve-office-api' })
  })

  it('超过语句超时的查询被数据库取消', async () => {
    const db = app.runtime.get<Database>(DATABASE)
    await expect(db.execute(sql`SELECT pg_sleep(2)`)).rejects.toMatchObject({ cause: { code: '57014' } })
  })
})

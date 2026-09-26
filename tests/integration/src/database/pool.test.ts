// 连接池（P2 设计 §3.3、§3.7）：超时设置取自配置；连接出错不让进程退出（审查 A1）；数据库报错的日志不带参数（审查 A2）。
import type { Database, Transaction } from '@nerve-office/api'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError, DATABASE, DatabaseModule, TransactionRunner } from '@nerve-office/api'
import { Controller, Get, Inject, Module } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'

const SENSITIVE = 'SENSITIVE-PARAM-7c1f'

@Controller('__test/database')
class DatabaseProbeController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 带着一个"敏感"的参数执行一条会失败的查询（不是合法的 UUID） */
  @Get('failure')
  async failure(): Promise<void> {
    await this.db.execute(sql`SELECT ${SENSITIVE}::uuid`)
  }
}

@Module({ imports: [DatabaseModule], controllers: [DatabaseProbeController] })
class DatabaseProbeModule {}

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({
    databaseUrl: database.url,
    env: {
      NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '300',
      NERVE_DATABASE_LOCK_TIMEOUT_MS: '400',
      NERVE_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '500',
    },
    additionalModules: [DatabaseProbeModule],
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

  it('借出期间连接被数据库断开（事务中空闲超时）：只记日志，进程不受影响，坏连接被丢弃', async () => {
    // 没有监听时，这里的 error 事件会成为未捕获的异常：进程退出，Vitest 也会因为未处理的错误而失败
    await expect(app.runtime.get(TransactionRunner).run(async () => {
      await delay(1_000)
    })).rejects.toThrow()
    expect(app.logs.entries()).toContainEqual(expect.objectContaining({ level: 'error', msg: '数据库连接出错' }))
    const db = app.runtime.get<Database>(DATABASE)
    expect((await db.execute<{ one: number }>(sql`SELECT 1 AS one`)).rows).toEqual([{ one: 1 }])
  })

  it('数据库报错时，响应只有通用说明；日志留下 SQLSTATE 与带占位符的语句，不带参数与行里的值', async () => {
    const response = await fetch(`${app.baseUrl}/api/__test/database/failure`)
    expect(response.status).toBe(500)
    const requestId = response.headers.get('x-request-id')
    const entry = app.logs.entries().find(log => log.requestId === requestId && log.level === 'error')
    expect(entry).toMatchObject({ err: { type: 'DrizzleQueryError', query: 'SELECT $1::uuid', cause: { type: 'DatabaseError', sqlState: '22P02' } } })
    expect(app.logs.text()).not.toContain(SENSITIVE)
  })
})

describe('事务的连接（TransactionRunner，复验 N8）', () => {
  // 连接池只有一个连接：放回的连接一定被下一个事务借到，换没换连接看后端的进程号
  let single: TestApp

  beforeAll(async () => {
    single = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_POOL_MAX: '1' } })
  })

  afterAll(async () => {
    await single.close()
  })

  /** 测试直接在事务上查询（应用代码只能把事务交给仓储） */
  async function backendPid(transaction: Transaction): Promise<number> {
    const result = await (transaction as unknown as Database).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
    return Number(result.rows[0]?.pid)
  }

  it('业务错误结束的事务：回滚后连接照常放回；其他失败：丢弃这个连接，之后的事务用新连接', async () => {
    const runner = single.runtime.get(TransactionRunner)
    const first = await runner.run(backendPid)
    await expect(runner.run(async (transaction) => {
      await backendPid(transaction)
      throw new AppError('NOT_FOUND')
    })).rejects.toBeInstanceOf(AppError)
    expect(await runner.run(backendPid)).toBe(first)

    await expect(runner.run(async (transaction) => {
      await (transaction as unknown as Database).execute(sql`SELECT ${'不是 UUID'}::uuid`)
    })).rejects.toMatchObject({ cause: { code: '22P02' } })
    const replaced = await runner.run(backendPid)
    expect(replaced).not.toBe(first)
    // 被丢弃的连接确实断开了
    const db = single.runtime.get<Database>(DATABASE)
    const alive = await db.execute<{ count: string }>(sql`SELECT count(*) AS count FROM pg_stat_activity WHERE pid = ${first}`)
    expect(alive.rows[0]?.count).toBe('0')
  })

  it('work 吞掉失败的语句却正常返回：事务已中止，不当作成功；预期会失败的语句放进保存点则照常提交', async () => {
    const runner = single.runtime.get(TransactionRunner)
    await expect(runner.run(async (transaction) => {
      await (transaction as unknown as Database).execute(sql`SELECT ${'不是 UUID'}::uuid`).catch(() => {})
      return '完成'
    })).rejects.toThrow('事务已中止')
    await expect(runner.run(async (transaction) => {
      await (transaction as unknown as Database).transaction(async (savepoint) => {
        await savepoint.execute(sql`SELECT ${'不是 UUID'}::uuid`)
      }).catch(() => {})
      return '完成'
    })).resolves.toBe('完成')
  })
})

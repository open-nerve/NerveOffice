// 优雅退出（P2 设计 §3.9，M1 总设计 §5 的 P2 验收）：在途请求（含数据库查询）正常完成，新连接被拒绝，连接池关闭；超过时限强制退出。
import type { Database } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseModule, Public } from '@nerve-office/api'
import { APPLICATION_NAME, DATABASE } from '@nerve-office/api/testing'
import { Controller, Get, Inject, Module } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { statusOnNewConnection } from '../support/http.ts'
import { waitFor } from '../support/wait.ts'

/** 慢请求的闸门：请求进入后通知测试，等测试放行后才查询数据库并返回。 */
class Gate {
  readonly entered: Promise<void>
  readonly opened: Promise<void>
  #enter: () => void = () => {}
  #open: () => void = () => {}

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#enter = resolve
    })
    this.opened = new Promise((resolve) => {
      this.#open = resolve
    })
  }

  enter(): void {
    this.#enter()
  }

  open(): void {
    this.#open()
  }
}

let gate = new Gate()

// 只在测试里存在的接口：不经登录（认证本身由 auth 的测试覆盖）
@Public()
@Controller('__test/slow')
class SlowController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  async slow(): Promise<{ answer: number }> {
    gate.enter()
    await gate.opened
    const result = await this.db.execute<{ answer: number }>(sql`SELECT 42 AS answer`)
    return { answer: Number(result.rows[0]?.answer) }
  }
}

@Module({ imports: [DatabaseModule], controllers: [SlowController] })
class SlowModule {}

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.drop()
})

async function startApp(env: Record<string, string> = {}): Promise<TestApp> {
  gate = new Gate()
  return startTestApp({ databaseUrl: database.url, env, additionalModules: [SlowModule] })
}

async function applicationConnections(): Promise<number> {
  return database.query(async (client) => {
    const result = await client.query<{ count: string }>('SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND application_name = $2', [database.name, APPLICATION_NAME])
    return Number(result.rows[0]?.count)
  })
}

/**
 * 退出之前的正向对照（M2 Codex 评审第二轮复验的建议 3）：经应用的连接池查询一次，按应用名数到的连接大于 0。
 * 退出之后"应用的连接数为 0"是按应用名数的，连接不带应用名时那里同样数到 0：连接即使泄漏，那条断言也会悄悄通过。
 * 先在这里数到它们，这样的改动在这一步就失败
 */
async function expectConnected(app: TestApp): Promise<void> {
  await app.runtime.get<Database>(DATABASE).execute(sql`SELECT 1`)
  expect(await applicationConnections()).toBeGreaterThan(0)
}

describe('优雅退出', () => {
  it('在途请求（含数据库查询）正常完成；新连接被拒绝；连接池关闭；结果为正常退出', async () => {
    const app = await startApp()
    const slow = fetch(`${app.baseUrl}/api/__test/slow`)
    await gate.entered

    await expectConnected(app)
    const shutdown = app.runtime.shutdown('测试')
    await expect(statusOnNewConnection(`${app.baseUrl}/api/health/live`)).rejects.toThrow()

    gate.open()
    const response = await slow
    expect(response.status).toBe(200)
    expect(response.headers.get('connection')).toBe('close')
    expect(await response.json()).toEqual({ answer: 42 })
    expect(await shutdown).toBe('graceful')
    expect(await applicationConnections()).toBe(0)
    expect(app.logs.entries().map(entry => entry.msg)).toEqual(expect.arrayContaining(['开始退出', '已退出']))
  })

  it('客户端中途断开、处理器仍在执行（占着数据库连接）：要等处理器结束才关闭连接池', async () => {
    const app = await startApp({ NERVE_SHUTDOWN_TIMEOUT_MS: '5000' })
    const controller = new AbortController()
    const slow = fetch(`${app.baseUrl}/api/__test/slow`, { signal: controller.signal }).catch(() => 'aborted')
    await gate.entered
    controller.abort()
    expect(await slow).toBe('aborted')
    await waitFor(() => app.logs.entries().some(entry => entry.msg === '请求中断'), '请求中断的日志')

    await expectConnected(app)
    let finished = false
    const shutdown = app.runtime.shutdown('测试').then((result) => {
      finished = true
      return result
    })
    await delay(300)
    expect(finished).toBe(false)
    gate.open()
    expect(await shutdown).toBe('graceful')
    expect(await applicationConnections()).toBe(0)
  })

  it('在途请求超过退出时限：强制断开，结果为强制退出', async () => {
    const app = await startApp({ NERVE_SHUTDOWN_TIMEOUT_MS: '300' })
    const slow = fetch(`${app.baseUrl}/api/__test/slow`).then(() => 'responded', () => 'disconnected')
    await gate.entered

    await expectConnected(app)
    const started = performance.now()
    expect(await app.runtime.shutdown('测试')).toBe('forced')
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(await slow).toBe('disconnected')
    expect(app.logs.entries()).toContainEqual(expect.objectContaining({ level: 'warn', msg: '在途请求超过退出时限，强制断开' }))
    expect(await applicationConnections()).toBe(0)
  })
})

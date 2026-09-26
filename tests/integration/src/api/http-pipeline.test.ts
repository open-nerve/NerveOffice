// HTTP 管线（P2 设计 §3.2–§3.6）：经真实应用验证错误响应、安全头、请求标识与请求日志。
// 用一个只在测试里存在的控制器制造各种情况。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LogEntry } from '../support/log-capture.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { AppError, AppLogger, Public } from '@nerve-office/api'
import { errorResponseSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, Module, Post } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { waitFor } from '../support/wait.ts'

const echoSchema = z.strictObject({ name: z.string().min(1).max(20), password: z.string().optional() })

// 只在测试里存在的接口：不经登录（认证本身由 auth 的测试覆盖）
@Public()
@Controller('__test')
class PipelineProbeController {
  readonly #logger: AppLogger

  constructor(logger: AppLogger) {
    this.#logger = logger.with({ context: 'PipelineProbe' })
  }

  @Post('echo')
  echo(@Body({ schema: echoSchema }) body: z.infer<typeof echoSchema>): { name: string } {
    this.#logger.info('收到请求', { password: body.password, nested: { token: 'tok-123456' } })
    return { name: body.name }
  }

  @Get('app-error')
  appError(): never {
    throw new AppError('NOT_FOUND', '找不到测试资源')
  }

  @Get('crash')
  crash(): never {
    throw new Error('内部细节：数据库密码是 hunter2')
  }

  /** 过一会儿才失败：客户端可以在失败之前断开 */
  @Get('slow-crash')
  async slowCrash(): Promise<never> {
    await delay(300)
    throw new Error('客户端断开之后处理失败')
  }
}

@Module({ controllers: [PipelineProbeController] })
class PipelineProbeModule {}

const EXPECTED_CSP = 'default-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\'; font-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\''
const JSON_HEADERS = { 'content-type': 'application/json' }

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_HTTP_JSON_BODY_LIMIT_BYTES: '65536' }, additionalModules: [PipelineProbeModule] })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 状态变更请求要带与公开地址相同的 Origin（P3 设计 §3.5），浏览器会自动带上 */
async function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, { ...init, headers: { origin: TEST_PUBLIC_ORIGIN, ...init.headers } })
}

async function postJson(path: string, body: string, headers: Record<string, string> = JSON_HEADERS): Promise<Response> {
  return request(path, { method: 'POST', body, headers })
}

/** 断言统一的错误响应，返回其中的 error。 */
async function expectError(response: Response, status: number, code: string): Promise<{ code: string, message: string, requestId: string }> {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  const { error } = errorResponseSchema.parse(await response.json())
  expect(error.code).toBe(code)
  expect(error.requestId).toBe(response.headers.get('x-request-id'))
  return error
}

function logsOf(requestId: string): LogEntry[] {
  return app.logs.entries().filter(entry => entry.requestId === requestId)
}

describe('错误响应（规范 §4、ADR-006）', () => {
  it('没有匹配的路由 → 404 NOT_FOUND', async () => {
    await expectError(await request('/api/no-such-route'), 404, 'NOT_FOUND')
  })

  it('业务错误（AppError）→ 登记的状态与它自己的说明', async () => {
    const error = await expectError(await request('/api/__test/app-error'), 404, 'NOT_FOUND')
    expect(error.message).toBe('找不到测试资源')
  })

  it('意外错误 → 500 INTERNAL_ERROR，只回通用说明；异常与堆栈写进这个请求的日志', async () => {
    const error = await expectError(await request('/api/__test/crash'), 500, 'INTERNAL_ERROR')
    expect(error.message).toBe('服务器内部错误，请稍后重试')
    const [entry] = logsOf(error.requestId)
    expect(entry).toMatchObject({ level: 'error', statusCode: 500, route: '/api/__test/crash', err: { message: '内部细节：数据库密码是 hunter2' } })
    expect(String((entry?.err as { stack?: unknown } | undefined)?.stack)).toContain('crash')
  })

  it('请求体不是合法的 JSON → 400 REQUEST_INVALID，不回显请求内容', async () => {
    const error = await expectError(await postJson('/api/__test/echo', '{"name": "secret-fragment'), 400, 'REQUEST_INVALID')
    expect(error.message).toBe('请求体不是合法的 JSON')
  })

  it('请求体超过上限 → 413 PAYLOAD_TOO_LARGE', async () => {
    const body = JSON.stringify({ name: 'x'.repeat(70_000) })
    const error = await expectError(await postJson('/api/__test/echo', body), 413, 'PAYLOAD_TOO_LARGE')
    expect(error.message).toBe('请求体超过上限（65536 字节）')
  })

  it('嵌套过深、元素过多 → 413 PAYLOAD_TOO_LARGE', async () => {
    const deep = `${'['.repeat(40)}1${']'.repeat(40)}`
    await expectError(await postJson('/api/__test/echo', deep), 413, 'PAYLOAD_TOO_LARGE')
    const many = JSON.stringify(Array.from({ length: 10_001 }).fill(0))
    await expectError(await postJson('/api/__test/echo', many), 413, 'PAYLOAD_TOO_LARGE')
  })

  it('字符集或内容编码不受支持 → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    await expectError(await postJson('/api/__test/echo', '{"name":"a"}', { 'content-type': 'application/json; charset=gbk' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await expectError(await postJson('/api/__test/echo', '{"name":"a"}', { ...JSON_HEADERS, 'content-encoding': 'compress' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
  })

  it('压缩的请求体：损坏时 400；解压后超过上限（压缩炸弹）时 413，按解压后的大小计算', async () => {
    const gzip = { ...JSON_HEADERS, 'content-encoding': 'gzip' }
    const corrupted = await expectError(await postJson('/api/__test/echo', 'not gzip at all', gzip), 400, 'REQUEST_INVALID')
    expect(corrupted.message).toBe('请求体无法解压或解析')
    const bomb = gzipSync(JSON.stringify({ name: 'a'.repeat(5 * 1024 * 1024) }))
    expect(bomb.byteLength).toBeLessThan(65_536)
    const response = await request('/api/__test/echo', { method: 'POST', body: bomb, headers: gzip })
    await expectError(response, 413, 'PAYLOAD_TOO_LARGE')
    const valid = await request('/api/__test/echo', { method: 'POST', body: gzipSync(JSON.stringify({ name: '压缩' })), headers: gzip })
    expect(await valid.json()).toEqual({ name: '压缩' })
  })

  it('校验失败 → 400 REQUEST_INVALID，列出字段路径，不回显取值', async () => {
    const error = await expectError(await postJson('/api/__test/echo', JSON.stringify({ name: '', extra: 'secret-value' })), 400, 'REQUEST_INVALID')
    expect(error.message).toContain('name')
    expect(error.message).not.toContain('secret-value')
  })

  it('合法的请求通过校验，控制器拿到解析后的值', async () => {
    const response = await postJson('/api/__test/echo', JSON.stringify({ name: '张三' }))
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ name: '张三' })
  })
})

describe('安全响应头（P2 设计 §3.6）', () => {
  it.each([
    ['存活探针', '/api/health/live', undefined, 200],
    ['没有匹配的路由', '/api/no-such-route', undefined, 404],
    ['意外错误', '/api/__test/crash', undefined, 500],
    ['请求体解析失败', '/api/__test/echo', '{', 400],
  ])('%s（%s）的响应带全部安全头', async (_case, path, body, status) => {
    const response = body === undefined ? await request(path) : await postJson(path, body)
    expect(response.status).toBe(status)
    expect(response.headers.get('content-security-policy')).toBe(EXPECTED_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.has('x-powered-by')).toBe(false)
    expect(response.headers.has('strict-transport-security')).toBe(false)
  })

  it('HSTS 只在经信任的反向代理转发的 HTTPS 请求上下发', async () => {
    const forwardedHttps = { 'x-forwarded-proto': 'https' }
    // 不信任代理时，客户端自己写的 X-Forwarded-Proto 不算数
    expect((await request('/api/health/live', { headers: forwardedHttps })).headers.has('strict-transport-security')).toBe(false)
    const proxied = await startTestApp({ databaseUrl: database.url, env: { NERVE_TRUST_PROXY: 'loopback' } })
    try {
      expect((await fetch(`${proxied.baseUrl}/api/health/live`, { headers: forwardedHttps })).headers.get('strict-transport-security')).toBe('max-age=31536000')
      expect((await fetch(`${proxied.baseUrl}/api/health/live`)).headers.has('strict-transport-security')).toBe(false)
    }
    finally {
      await proxied.close()
    }
  })
})

describe('请求标识与请求日志（规范 §7）', () => {
  it('透传合法的 X-Request-Id：响应头、错误响应与日志一致', async () => {
    const response = await request('/api/no-such-route', { headers: { 'x-request-id': 'client-trace-42' } })
    expect(response.headers.get('x-request-id')).toBe('client-trace-42')
    const error = await expectError(response, 404, 'NOT_FOUND')
    expect(error.requestId).toBe('client-trace-42')
    expect(logsOf('client-trace-42')).toMatchObject([{ level: 'warn', statusCode: 404, path: '/api/no-such-route' }])
  })

  it('不合法的 X-Request-Id 换成新生成的 UUID', async () => {
    const response = await request('/api/health/live', { headers: { 'x-request-id': 'has space <and> quotes"' } })
    expect(response.headers.get('x-request-id')).toMatch(/^[\da-f-]{36}$/)
  })

  it('请求结束时记一条日志：方法、路由模板、路径、状态码、耗时；不记请求体与查询串', async () => {
    const response = await postJson('/api/__test/echo?token=query-secret', JSON.stringify({ name: '李四', password: 'body-password' }))
    expect(response.status).toBe(201)
    const requestId = response.headers.get('x-request-id') ?? ''
    const completed = logsOf(requestId).find(entry => entry.msg === '请求完成')
    expect(completed).toMatchObject({ level: 'info', method: 'POST', route: '/api/__test/echo', path: '/api/__test/echo', statusCode: 201 })
    expect(completed?.durationMs).toBeTypeOf('number')
    expect(app.logs.text()).not.toContain('query-secret')
    expect(app.logs.text()).not.toContain('body-password')
  })

  it('请求内的应用日志带上请求标识，敏感字段脱敏', async () => {
    const response = await postJson('/api/__test/echo', JSON.stringify({ name: '王五', password: 'another-password' }))
    const requestId = response.headers.get('x-request-id') ?? ''
    expect(logsOf(requestId).find(entry => entry.msg === '收到请求')).toMatchObject({
      context: 'PipelineProbe',
      password: '[已脱敏]',
      nested: { token: '[已脱敏]' },
    })
    expect(app.logs.text()).not.toContain('another-password')
    expect(app.logs.text()).not.toContain('tok-123456')
  })

  it('客户端中途断开：记一条"请求中断"（warn，不记状态码）；之后处理器失败也记进这个请求的日志', async () => {
    const controller = new AbortController()
    const aborted = fetch(`${app.baseUrl}/api/__test/slow-crash`, { signal: controller.signal, headers: { 'x-request-id': 'abort-trace-1' } }).catch(() => 'aborted')
    await delay(50)
    controller.abort()
    expect(await aborted).toBe('aborted')
    await waitFor(() => logsOf('abort-trace-1').some(entry => entry.msg === '请求中断之后处理失败'), '处理器失败的日志')
    const entries = logsOf('abort-trace-1')
    expect(entries.find(entry => entry.msg === '请求中断')).toMatchObject({ level: 'warn', aborted: true, route: '/api/__test/slow-crash' })
    expect(entries.find(entry => entry.msg === '请求中断')).not.toHaveProperty('statusCode')
    expect(entries.find(entry => entry.msg === '请求中断之后处理失败')).toMatchObject({ level: 'error', err: { message: '客户端断开之后处理失败' } })
  })

  it('探针的成功请求不记日志', async () => {
    const response = await request('/api/health/live')
    expect(logsOf(response.headers.get('x-request-id') ?? '')).toEqual([])
  })
})

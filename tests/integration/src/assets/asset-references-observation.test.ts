import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { TestDatabase } from '../support/database.ts'
import type { BulkReferenceObservation } from './asset-references-observation.test-support.ts'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import process from 'node:process'
import { APPLICATION_NAME } from '@nerve-office/api/testing'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createTestDatabase, testDatabaseUrl } from '../support/database.ts'
import { captureStatements } from '../support/statement-capture.ts'
import { observeBulkReferences } from './asset-references-observation.test-support.ts'

const SECRET = 'observation-private-value'
const DOCUMENT = '0199a2c4-1111-7000-8000-000000000001'
let database: TestDatabase
let server: Server
let baseUrl: string
const requests: { method: string | undefined, body: string, cookie: string | undefined }[] = []
let releaseResponse: (() => void) | undefined

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.from(chunk as Uint8Array))
  requests.push({ method: request.method, body: Buffer.concat(chunks).toString(), cookie: request.headers.cookie })
  if (request.headers['x-pause'] === 'yes')
    await new Promise<void>((resolve) => { releaseResponse = resolve })
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ value: SECRET }))
}

beforeAll(async () => {
  database = await createTestDatabase()
  server = createServer((request, response) => {
    void respond(request, response).catch(() => response.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('本地观测服务器没有 TCP 地址')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  releaseResponse?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await database?.drop()
})

function output() {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const lines = () => spy.mock.calls.map(call => String(call[0]))
  return { spy, lines, events: () => lines().map(line => JSON.parse(line) as Record<string, unknown>) }
}

function observe(): BulkReferenceObservation {
  return observeBulkReferences({ databaseName: database.name, baseUrl, assetCount: 7 })
}

function deferred<T>() {
  let complete: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    complete = resolve
  })
  return { promise, resolve: (value: T) => complete(value) }
}

/* eslint-disable ts/promise-function-async -- 这些回调用来核对原 Promise 身份，不能用 async 产生替身。 */
it('原动作未完成时已有 started；原 Promise、值和拒绝对象不变，不读取异常 getter', async () => {
  const log = output()
  const observation = observe()
  const pending = deferred<object>()
  const value = { privateValue: SECRET }
  const failure = Object.defineProperty({}, 'message', { get: () => {
    throw new Error('不应读取')
  } })
  try {
    const result = observation.stage('login', () => pending.promise)
    expect(result).toBe(pending.promise)
    expect(log.events()).toEqual([expect.objectContaining({ kind: 'stage', name: 'login', status: 'started', assetCount: 7 })])
    pending.resolve(value)
    expect(await result).toBe(value)
    await expect(observation.stage('authorize', () => Promise.reject(failure))).rejects.toBe(failure)
    expect(() => observation.stage('setup', () => {
      throw failure
    })).toThrow()
    expect(log.events().map(event => event.status)).toEqual(['started', 'passed', 'started', 'failed', 'started', 'failed'])
    expect(log.lines().join('').includes(SECRET)).toBe(false)
    expect(log.events().every(event => typeof event.totalMs === 'number' && Number.isFinite(event.totalMs))).toBe(true)
  }
  finally {
    pending.resolve(value)
    observation.restore()
    log.spy.mockRestore()
  }
})

it('超过旧 128 个操作的有限链仍记录终尾，不能在正式读回和断言前截断', async () => {
  const log = output()
  const observation = observe()
  let completed = 0
  try {
    for (let index = 0; index < 160; index += 1)
      await observation.stage('prepare', async () => { completed += 1 })
    const result = await observation.stage('http-read-back', async () => SECRET)
    observation.stage('http-assertions', () => expect(result).toBe(SECRET))
    expect(completed).toBe(160)
    expect(log.events()).toContainEqual(expect.objectContaining({ name: 'http-read-back', status: 'passed' }))
    expect(log.events()).toContainEqual(expect.objectContaining({ name: 'http-assertions', status: 'passed' }))
    expect(log.events().filter(event => event.status === 'truncated')).toEqual([])
    expect(log.lines().join('').includes(SECRET)).toBe(false)
  }
  finally {
    observation.restore()
    log.spy.mockRestore()
  }
})

it('重复动作仍执行，日志条数和字节有界且只出现一次 truncated', async () => {
  const log = output()
  const observation = observe()
  let completed = 0
  try {
    for (let index = 0; index < 400; index += 1)
      await observation.stage('prepare', async () => { completed += 1 })
    expect(completed).toBe(400)
    expect(log.events().filter(event => event.status === 'truncated')).toHaveLength(1)
    expect(log.lines().length).toBeLessThanOrEqual(512)
    expect(Buffer.byteLength(log.lines().join(''))).toBeLessThanOrEqual(96 * 1024)
  }
  finally {
    observation.restore()
    log.spy.mockRestore()
  }
})

it('同步断言与 gzip 准备的观测不制造 Promise 或新的等待', () => {
  const log = output()
  const observation = observe()
  const value = { unchanged: true }
  try {
    expect(observation.stage('http-prepare', () => value)).toBe(value)
    expect(log.events().map(event => event.status)).toEqual(['started', 'passed'])
  }
  finally {
    observation.restore()
    log.spy.mockRestore()
  }
})

it('输出失败不覆盖成功或原失败；恢复后在途完成不再写日志', async () => {
  const log = output()
  const observation = observe()
  const pending = deferred<number>()
  try {
    const result = observation.stage('setup', () => pending.promise)
    observation.restore()
    observation.restore()
    const count = log.lines().length
    pending.resolve(3)
    expect(await result).toBe(3)
    expect(log.lines()).toHaveLength(count)
  }
  finally {
    pending.resolve(3)
    observation.restore()
    log.spy.mockRestore()
  }
  const broken = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
    throw new Error(SECRET)
  })
  const another = observe()
  const failure = new Error('原动作失败')
  try {
    expect(await another.stage('setup', async () => 7)).toBe(7)
    await expect(another.stage('setup', () => Promise.reject(failure))).rejects.toBe(failure)
  }
  finally {
    another.restore()
    broken.mockRestore()
  }
})

it('真实 PG promise/callback 完整往返并保留拒绝，与 single-query 和 statement capture 叠加后反向恢复', async () => {
  const client = new pg.Client({ connectionString: database.url, application_name: APPLICATION_NAME })
  await client.connect()
  const prototype = pg.Client.prototype as unknown as { query: (this: object, ...args: unknown[]) => unknown }
  const initial = prototype.query
  const capture = captureStatements(database.name)
  const beforeObservation = prototype.query
  const log = output()
  const observation = observe()
  let pendingQuery: Promise<pg.QueryResult<{ value: string }>> | undefined
  try {
    pendingQuery = client.query<{ value: string }>('SELECT pg_sleep(0.02), $1::text AS value', [SECRET])
    expect(log.events()).toEqual([expect.objectContaining({ kind: 'sql', name: 'select', status: 'started', connection: 1 })])
    expect((await pendingQuery).rows[0]?.value).toBe(SECRET)
    const captured = await capture.during(async () => client.query('SELECT $1::text AS value', [SECRET]))
    expect(captured.queries).toHaveLength(1)
    expect(captured.queries[0]?.values).toEqual([SECRET])
    const callbackResult = await new Promise<pg.QueryResult<{ value: string }>>((resolve, reject) => {
      client.query<{ value: string }>('SELECT $1::text AS value', [SECRET], (error, result) => error === null ? resolve(result) : reject(error))
    })
    expect(callbackResult.rows[0]?.value).toBe(SECRET)
    await expect(client.query('SELECT $1::integer', [SECRET])).rejects.toMatchObject({ code: '22P02' })
    await client.query('BEGIN')
    await client.query('COMMIT')
    expect(log.events()).toContainEqual(expect.objectContaining({ kind: 'sql', name: 'commit', status: 'passed' }))
    expect(log.events()).toContainEqual(expect.objectContaining({ kind: 'sql', name: 'select', status: 'failed' }))
    expect(log.lines().join('').includes(SECRET)).toBe(false)
    observation.restore()
    expect(prototype.query).toBe(beforeObservation)
  }
  finally {
    await pendingQuery?.then(() => {}, () => {})
    observation.restore()
    capture.restore()
    expect(prototype.query).toBe(initial)
    log.spy.mockRestore()
    await client.end()
  }
})

it('别的数据库或非应用 PG 连接仍正常执行，不记录它们', async () => {
  const log = output()
  const observation = observe()
  const clients = [
    new pg.Client({ connectionString: testDatabaseUrl(), application_name: APPLICATION_NAME }),
    new pg.Client({ connectionString: database.url, application_name: 'unrelated-test' }),
  ]
  try {
    for (const client of clients) {
      await client.connect()
      expect((await client.query<{ value: string }>('SELECT $1::text AS value', [SECRET])).rows[0]?.value).toBe(SECRET)
    }
    expect(log.events()).toEqual([])
  }
  finally {
    observation.restore()
    log.spy.mockRestore()
    for (const client of clients)
      await client.end()
  }
})

it('真实零行关系 INSERT 的固定分类和 COMMIT 可见，查询返回原 Promise，SQL 文本不输出', async () => {
  const client = new pg.Client({ connectionString: database.url, application_name: APPLICATION_NAME })
  await client.connect()
  const prototype = pg.Client.prototype as unknown as { query: (this: object, ...args: unknown[]) => unknown }
  const original = prototype.query
  let nativeResult: unknown
  prototype.query = function (...args) {
    nativeResult = original.apply(this, args)
    return nativeResult
  }
  const log = output()
  const observation = observe()
  try {
    const pending = client.query('BEGIN')
    expect(pending).toBe(nativeResult)
    await pending
    await client.query('INSERT INTO document_asset_links (document_id, asset_id) SELECT NULL::uuid, NULL::uuid WHERE false')
    await client.query('INSERT INTO document_checkpoint_assets (checkpoint_id, asset_id) SELECT NULL::uuid, NULL::uuid WHERE false')
    await client.query('DELETE FROM document_asset_links WHERE false')
    await client.query('COMMIT')
    expect(log.events().filter(event => event.status === 'passed').map(event => event.name)).toEqual(['begin', 'current-links-insert', 'checkpoint-links-insert', 'current-links-delete', 'commit'])
    const rejected = client.query('SELECT $1::integer', [SECRET])
    expect(rejected).toBe(nativeResult)
    const originalFailure: unknown = await (nativeResult as Promise<unknown>).catch((error: unknown) => error)
    await expect(rejected).rejects.toBe(originalFailure)
    expect(log.lines().join('').includes('NULL::uuid')).toBe(false)
  }
  finally {
    observation.restore()
    prototype.query = original
    log.spy.mockRestore()
    await client.end()
  }
})

it('真实登录、租约申请/释放及三种正文读取均可见，恢复后 Response 方法还原', async () => {
  const log = output()
  const observation = observe()
  const responses: Response[] = []
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', body: SECRET })
    responses.push(login)
    expect(await login.json()).toEqual({ value: SECRET })
    const acquired = await fetch(`${baseUrl}/api/documents/${DOCUMENT}/edit-lease`, { method: 'POST' })
    responses.push(acquired)
    expect(await acquired.text()).toBe(JSON.stringify({ value: SECRET }))
    const released = await fetch(`${baseUrl}/api/documents/${DOCUMENT}/edit-lease`, { method: 'DELETE' })
    responses.push(released)
    expect(Buffer.from(await released.arrayBuffer()).toString()).toBe(JSON.stringify({ value: SECRET }))
    expect(log.events().filter(event => event.status === 'passed').map(event => event.name)).toEqual(['login', 'login-json', 'lease-acquire', 'lease-acquire-text', 'lease-release', 'lease-release-arrayBuffer'])
    expect(log.lines().join('').includes(SECRET)).toBe(false)
  }
  finally {
    observation.restore()
    for (const response of responses) {
      expect(response.json).toBe(Response.prototype.json)
      expect(response.text).toBe(Response.prototype.text)
      expect(response.arrayBuffer).toBe(Response.prototype.arrayBuffer)
    }
    log.spy.mockRestore()
  }
})

it('真实 HTTP 请求和响应对象保持；完成前已见 started；不提前消费正文，参数和 Cookie 不泄露', async () => {
  const originalFetch = globalThis.fetch
  let nativePromise: Promise<Response> | undefined
  const forwarding = vi.spyOn(globalThis, 'fetch').mockImplementation((...args) => {
    nativePromise = originalFetch(...args)
    return nativePromise
  })
  const log = output()
  const observation = observe()
  let pending: Promise<Response> | undefined
  try {
    pending = fetch(`${baseUrl}/api/documents/${DOCUMENT}/content?secret=${SECRET}`, { method: 'PUT', headers: { 'cookie': SECRET, 'x-pause': 'yes' }, body: SECRET })
    await vi.waitFor(() => expect(releaseResponse).toBeTypeOf('function'))
    expect(pending).toBe(nativePromise)
    expect(log.events()).toEqual([expect.objectContaining({ kind: 'http', name: 'content-put', status: 'started' })])
    releaseResponse?.()
    releaseResponse = undefined
    const response = await pending
    expect(response.bodyUsed).toBe(false)
    expect(await response.json()).toEqual({ value: SECRET })
    expect(requests.at(-1)).toEqual({ method: 'PUT', body: SECRET, cookie: SECRET })
    expect(log.events()).toContainEqual(expect.objectContaining({ kind: 'body', name: 'content-put-json', status: 'passed' }))
    expect(log.lines().join('').includes(SECRET)).toBe(false)
  }
  finally {
    releaseResponse?.()
    releaseResponse = undefined
    await pending?.then(async response => response.bodyUsed ? undefined : response.arrayBuffer(), () => {})
    observation.restore()
    expect(globalThis.fetch).toBe(forwarding)
    log.spy.mockRestore()
    forwarding.mockRestore()
  }
})
/* eslint-enable ts/promise-function-async */

it('非匹配 HTTP 地址不记录；真实 fetch 取消保留原拒绝，恢复后无包装残留', async () => {
  const original = globalThis.fetch
  const log = output()
  const observation = observe()
  try {
    expect((await fetch(`${baseUrl}/unrelated?secret=${SECRET}`)).status).toBe(200)
    const foreign = baseUrl.replace('127.0.0.1', 'localhost')
    const response = await fetch(`${foreign}/api/documents/${DOCUMENT}/content`, { method: 'PUT' })
    await response.arrayBuffer()
    expect(log.events()).toEqual([])
    const failure = new Error(SECRET)
    await expect(fetch(`${baseUrl}/api/documents/${DOCUMENT}/edit-lease`, { method: 'POST', signal: AbortSignal.abort(failure) })).rejects.toBe(failure)
    expect(log.events()).toEqual([
      expect.objectContaining({ kind: 'http', name: 'lease-acquire', status: 'started' }),
      expect.objectContaining({ kind: 'http', name: 'lease-acquire', status: 'failed' }),
    ])
    expect(log.lines().join('').includes(SECRET)).toBe(false)
  }
  finally {
    observation.restore()
    expect(globalThis.fetch).toBe(original)
    log.spy.mockRestore()
  }
})

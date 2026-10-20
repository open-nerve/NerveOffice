import type { ClientRequest, IncomingMessage } from 'node:http'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { AssetUploadService, ImageRunner } from '@nerve-office/api/testing'
import { ASSET_MAX_BYTES, CSRF_TOKEN_HEADER, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount, DEFAULT_PASSWORD } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let session: LoggedIn
let data: Buffer
const clients: ClientRequest[] = []
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const account = await createAccount(database, { username: 'asset-stream-uploader' })
  session = await login(app.baseUrl, account.username, account.password)
  data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0))
    client.destroy()
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

interface RawResponse { readonly status: number, readonly headers: IncomingMessage['headers'], readonly body: string }
function deferred<T>() {
  let complete: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    complete = resolve
  })
  return { promise, resolve: (value: T) => complete(value) }
}
function raw(headers: Record<string, string>) {
  const result = deferred<RawResponse | undefined>()
  const client = request(`${app.baseUrl}/api/assets`, {
    method: 'POST',
    headers: { 'cookie': session.cookie, 'origin': TEST_PUBLIC_ORIGIN, [CSRF_TOKEN_HEADER]: session.session.csrfToken, 'content-type': 'image/png', 'x-asset-extension': 'png', ...headers },
  }, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      body += chunk
    })
    response.once('end', () => result.resolve({ status: response.statusCode!, headers: response.headers, body }))
    response.once('error', () => result.resolve(undefined))
  })
  client.once('error', () => result.resolve(undefined))
  clients.push(client)
  return { client, response: result.promise }
}
async function upload() {
  return asUser(app.baseUrl, session, '/api/assets', { method: 'POST', binary: { contentType: 'image/png', bytes: data }, headers: { 'x-asset-extension': 'png' } })
}
function observeReaders() {
  const firstRead = deferred<void>()
  const secondEntered = deferred<void>()
  const service = app.runtime.get(AssetUploadService)
  const original = service.upload.bind(service)
  let entered = 0
  let reads = 0
  // 仅观察真实 reader 开始的时刻，正文、子进程、文件与数据库全部照常执行。
  vi.spyOn(service, 'upload').mockImplementation(async (id, read, signal) => {
    if (++entered === 2)
      secondEntered.resolve()
    return original(id, async (combined) => {
      reads++
      firstRead.resolve()
      return read(combined)
    }, signal)
  })
  return { firstRead: firstRead.promise, secondEntered: secondEntered.promise, reads: () => reads }
}

describe('准入先于正文，断开与关闭覆盖真实 HTTP 流', () => {
  it('慢传占执行槽，第二份只排队不读正文；第三份繁忙，断开后下一份成功', async () => {
    const observed = observeReaders()
    const slow = raw({ 'content-length': '20000' })
    slow.client.write(data.subarray(0, 4))
    await observed.firstRead
    const queued = upload()
    await observed.secondEntered
    const busy = await upload()
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('10')
    expect(errorResponseSchema.parse(await busy.json()).error.code).toBe('ASSET_BUSY')
    expect(observed.reads()).toBe(1)
    slow.client.destroy()
    expect((await queued).status).toBe(201)
    expect(await slow.response).toBeUndefined()
    expect(observed.reads()).toBe(2)
    expect(app.runtime.get(ImageRunner).liveProcesses).toBe(0)
  })

  it('没有 Content-Length 的分块正文也在 5 MiB 拒绝，不影响下一次上传', async () => {
    const chunked = raw({ 'transfer-encoding': 'chunked' })
    chunked.client.end(Buffer.alloc(ASSET_MAX_BYTES + 1))
    const response = await chunked.response
    expect(response?.status).toBe(413)
    expect(errorResponseSchema.parse(JSON.parse(response!.body)).error.code).toBe('PAYLOAD_TOO_LARGE')
    expect((await upload()).status).toBe(201)
  })

  it('已拒绝的正文清理仍占准入槽，读完后返回 413、释放等待且不调用图片处理', async () => {
    const observed = observeReaders()
    const process = vi.spyOn(app.runtime.get(ImageRunner), 'process')
    const slow = raw({ 'content-length': String(ASSET_MAX_BYTES + 1) })
    slow.client.write(Buffer.alloc(4))
    await observed.firstRead
    const queued = upload()
    await observed.secondEntered
    expect((await upload()).status).toBe(503)
    expect(observed.reads()).toBe(1)
    expect(process).not.toHaveBeenCalled()
    slow.client.end(Buffer.alloc(ASSET_MAX_BYTES - 3))
    const response = await slow.response
    expect(response?.status).toBe(413)
    expect(errorResponseSchema.parse(JSON.parse(response!.body)).error.code).toBe('PAYLOAD_TOO_LARGE')
    expect((await queued).status).toBe(201)
    expect(process).toHaveBeenCalledTimes(1)
    expect((await upload()).status).toBe(201)
    expect(app.runtime.get(ImageRunner).liveProcesses).toBe(0)
  })

  it.each(['deadline', 'disconnect', 'bytes'] as const)('拒绝清理遇到 %s 即收尾，下一次上传可用且无资源被预留', async (boundary) => {
    const observed = observeReaders()
    const process = vi.spyOn(app.runtime.get(ImageRunner), 'process')
    const count = async () => database.query(async client => (await client.query<{ count: string }>('SELECT count(*) FROM assets')).rows[0]!.count)
    const before = await count()
    const slow = raw({ 'content-length': String(7 * 1024 * 1024) })
    slow.client.write(Buffer.alloc(4))
    await observed.firstRead
    if (boundary === 'disconnect')
      slow.client.destroy()
    else if (boundary === 'bytes')
      slow.client.write(Buffer.alloc(6 * 1024 * 1024))
    // deadline 不补正文，让真实 HTTP 流经历完整的十秒清理期限。
    expect(await slow.response).toBeUndefined()
    expect(process).not.toHaveBeenCalled()
    expect(await count()).toBe(before)
    expect((await upload()).status).toBe(201)
    expect(app.runtime.get(ImageRunner).liveProcesses).toBe(0)
  })

  it('认证通过后在慢传期间退出，不能继续预留配额或创建资源', async () => {
    const observed = observeReaders()
    const slow = raw({ 'content-length': String(data.length) })
    slow.client.write(data.subarray(0, 4))
    await observed.firstRead
    const before = await database.query(async client => (await client.query<{ count: string }>('SELECT count(*) FROM assets')).rows[0]!.count)
    try {
      expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
      slow.client.end(data.subarray(4))
      const response = await slow.response
      expect(response?.status).toBe(401)
      expect(errorResponseSchema.parse(JSON.parse(response!.body)).error).toMatchObject({ code: 'SESSION_EXPIRED', details: { reason: 'logout' } })
      expect(await database.query(async client => (await client.query<{ count: string }>('SELECT count(*) FROM assets')).rows[0]!.count)).toBe(before)
    }
    finally {
      session = await login(app.baseUrl, 'asset-stream-uploader', DEFAULT_PASSWORD)
    }
  })

  it.each([false, true])('开始关闭即取消慢传与等待，排空完成后才关库，不等正文补完：已拒绝=%s', async (rejected) => {
    const observed = observeReaders()
    const slow = raw({ 'content-length': rejected ? String(ASSET_MAX_BYTES + 1) : '20000' })
    slow.client.write(data.subarray(0, 4))
    await observed.firstRead
    const queued = upload()
    await observed.secondEntered
    expect(await app.runtime.shutdown('图片慢传关闭测试')).toBe('graceful')
    expect((await slow.response)?.status).toBe(503)
    expect((await queued).status).toBe(503)
    expect(observed.reads()).toBe(1)
    expect(app.runtime.get(ImageRunner).liveProcesses).toBe(0)
    vi.restoreAllMocks()
    app = await startTestApp({ databaseUrl: database.url })
    expect((await upload()).status).toBe(201)
  })
})

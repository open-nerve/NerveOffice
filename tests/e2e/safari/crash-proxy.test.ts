import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startCrashProxy } from './crash-proxy.ts'

describe('真实 Safari 崩溃同源代理', () => {
  const documentId = randomUUID()
  const clientInstanceId = randomUUID()
  const receive = vi.fn(() => ({ kind: 'wait' as const }))
  const forwarded: { method: string, url: string, body: Buffer, cookie: string | undefined, origin: string | undefined }[] = []
  let proxy: Awaited<ReturnType<typeof startCrashProxy>>
  let backendMode: 'normal' | 'hold' | 'reset' | 'reset-body' = 'normal'
  const backend = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      forwarded.push({ method: request.method ?? '', url: request.url ?? '', body, cookie: request.headers.cookie, origin: request.headers.origin })
      if (backendMode === 'hold')
        return
      if (backendMode === 'reset') {
        response.destroy()
        return
      }
      if (backendMode === 'reset-body') {
        response.writeHead(200, { 'content-length': '100' })
        response.flushHeaders()
        response.write('part')
        setTimeout(() => response.destroy(), 10)
        return
      }
      response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/octet-stream', 'x-test-preserved': 'yes' })
      response.end(body)
    })
  })

  beforeEach(async () => {
    forwarded.length = 0
    backendMode = 'normal'
    receive.mockClear()
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    proxy = await startCrashProxy({ runId: randomUUID(), backendOrigin: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` })
    proxy.configure({ documentId, entryFragment: 'user=test-user&password=test-only&document=test-document', receive })
  })

  afterEach(async () => {
    await proxy.close()
    backend.closeAllConnections()
    await new Promise<void>(resolve => backend.close(() => resolve()))
  })

  const post = async (path: string, body: string, origin = proxy.origin, contentType = 'application/json') => fetch(`${proxy.origin}${path}`, { method: 'POST', headers: { origin, 'content-type': contentType }, body })

  it('等待页不包含凭证，只有本机驱动解锁后才一次性进入现有 selftest 入口', async () => {
    const html = await (await fetch(proxy.startUrl)).text()
    expect(html).toContain('NerveOffice')
    expect(html).not.toContain('password')
    expect(await (await post(proxy.commandPath, '{}')).json()).toEqual({ kind: 'wait' })
    expect((await fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual' })).status).toBe(403)
    proxy.arm()
    expect(await (await post(proxy.commandPath, '{}')).json()).toEqual({ kind: 'start' })
    const entry = await fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual', headers: { referer: proxy.startUrl } })
    expect(entry.status).toBe(302)
    expect(entry.headers.get('location')).toBe('/selftest.html#user=test-user&password=test-only&document=test-document')
    expect((await fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual', headers: { referer: proxy.startUrl } })).status).toBe(403)
    expect(forwarded).toEqual([])
  })

  it('控制通道只交付合法 JSON，控制请求不转发后端', async () => {
    const message = { kind: 'boot', runId: randomUUID(), documentId, bootId: randomUUID() }
    proxy.arm()
    const result = await post(proxy.controlPath, JSON.stringify(message))
    expect(result.status).toBe(200)
    expect(receive).toHaveBeenCalledWith(message, expect.any(Number))
    expect(await result.json()).toEqual({ kind: 'wait' })
    expect(forwarded).toEqual([])
  })

  it('只有驱动确认重启后可再登录一次，公开请求不能续发入口', async () => {
    const enter = async () => fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual', headers: { referer: proxy.startUrl } })
    proxy.arm()
    expect((await enter()).status).toBe(302)
    proxy.observeRecovery()
    await post(proxy.commandPath, JSON.stringify({ kind: 'allow-recovery-entry' }))
    expect((await enter()).status).toBe(403)
    proxy.allowRecoveryEntry()
    expect((await fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual' })).status).toBe(403)
    expect((await post(proxy.entryPath, '{}')).status).toBe(403)
    const recovery = await enter()
    expect(recovery.status).toBe(302)
    expect(recovery.headers.get('location')).toBe('/selftest.html#user=test-user&password=test-only&document=test-document')
    expect((await enter()).status).toBe(403)
    expect(() => proxy.allowRecoveryEntry()).toThrow()
    expect(forwarded).toEqual([])
  })

  it('不能在初次登录和恢复观察开始前续发入口，也不能堆积许可', async () => {
    expect(() => proxy.allowRecoveryEntry()).toThrow()
    proxy.arm()
    expect(() => proxy.allowRecoveryEntry()).toThrow()
    expect((await fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual', headers: { referer: proxy.startUrl } })).status).toBe(302)
    expect(() => proxy.allowRecoveryEntry()).toThrow()
    proxy.observeRecovery()
    proxy.allowRecoveryEntry()
    expect(() => proxy.allowRecoveryEntry()).toThrow()
  })

  it.each([
    { name: '异源', body: '{}', origin: 'http://localhost:1234', type: 'application/json', status: 403 },
    { name: '错误媒体类型', body: '{}', origin: undefined, type: 'text/plain', status: 415 },
    { name: '破损 JSON', body: '{', origin: undefined, type: 'application/json', status: 400 },
    { name: '过大正文', body: JSON.stringify({ data: 'x'.repeat(8192) }), origin: undefined, type: 'application/json', status: 413 },
  ])('$name 不进入会话', async ({ body, origin, type, status }) => {
    proxy.arm()
    expect((await post(proxy.controlPath, body, origin ?? proxy.origin, type)).status).toBe(status)
    expect(receive).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
  })

  it('未解锁、错误 Host 与未知控制路径拒绝且没有信号操作', async () => {
    expect((await post(proxy.controlPath, '{}')).status).toBe(403)
    // fetch 会自行重建 Host；用真实 HTTP 请求验证错误 Host 的拒绝分支。
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(proxy.startUrl, { headers: { host: 'elsewhere.invalid' } }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(403)
    expect((await post('/__nerve-crash/unknown', '{}')).status).toBe(404)
    expect(receive).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
  })

  it('转发的 gzip、Cookie、Origin、查询串和响应逐字节不变；报告不含凭证或保存正文', async () => {
    const body = gzipSync('秘密的测试正文')
    const path = `/api/documents/${documentId}/content?requestId=${randomUUID()}`
    proxy.observeRecovery()
    const result = await fetch(`${proxy.origin}${path}`, { method: 'PUT', headers: { 'origin': proxy.origin, 'cookie': 'session=secret', 'content-encoding': 'gzip' }, body })
    expect(Buffer.from(await result.arrayBuffer())).toEqual(body)
    expect(result.headers.get('x-test-preserved')).toBe('yes')
    expect(forwarded).toEqual([{ method: 'PUT', url: path, body, cookie: 'session=secret', origin: proxy.origin }])
    expect(proxy.evidence()).toEqual({ acquires: [], saves: [{ status: 200 }], problems: [], clientAborts: 0 })
  })

  it('只收录实际结束进程之后的本次文档申请与保存，包括失败和重复请求', async () => {
    const path = `/api/documents/${documentId}/edit-lease`
    const body = JSON.stringify({ clientInstanceId, takeover: 'self', csrfToken: 'must-not-record' })
    await post(path, body)
    proxy.observeRecovery()
    await post(`/api/documents/${randomUUID()}/edit-lease`, body)
    await post(path, JSON.stringify({ clientInstanceId }))
    await post(path, body)
    expect(proxy.evidence()).toEqual({ acquires: [{ clientInstanceId, takeover: null, status: 201 }, { clientInstanceId, takeover: 'self', status: 201 }], saves: [], problems: [], clientAborts: 0 })
    expect(JSON.stringify(proxy.evidence())).not.toContain('must-not-record')
    expect(() => proxy.observeRecovery()).toThrow()
  })

  it('无法解析的真实申请仍转发，但不能成为通过证据；快照不能改写内部证据', async () => {
    proxy.observeRecovery()
    await post(`/api/documents/${documentId}/edit-lease`, '{')
    const result = proxy.evidence()
    expect(result.problems).toEqual(['恢复后的申请正文无法核对'])
    result.problems.length = 0
    expect(proxy.evidence().problems).toHaveLength(1)
    expect(forwarded[0]?.body.toString()).toBe('{')
  })

  it.each(['GET', 'POST', 'PUT'])('客户端崩溃中断 %s 不冒充后端故障，恢复申请/保存仍保持失败记账', async (method) => {
    backendMode = 'hold'
    proxy.observeRecovery()
    const path = method === 'GET' ? '/api/health/ready' : `/api/documents/${documentId}/${method === 'POST' ? 'edit-lease' : 'content'}`
    const request = httpRequest(`${proxy.origin}${path}`, { method, headers: { 'origin': proxy.origin, 'content-type': 'application/json' } })
    request.on('error', () => {})
    request.end(method === 'GET' ? undefined : JSON.stringify({ clientInstanceId }))
    await vi.waitFor(() => expect(forwarded).toHaveLength(1))
    request.destroy()
    await vi.waitFor(() => expect(proxy.evidence().clientAborts).toBe(1))
    expect(proxy.evidence().problems).toEqual([])
    if (method === 'POST')
      expect(proxy.evidence().acquires).toEqual([{ clientInstanceId, takeover: null, status: 0 }])
    if (method === 'PUT')
      expect(proxy.evidence().saves).toEqual([{ status: 0 }])
  })

  it('真正的后端连接中断仍失败，不能按 ECONNRESET 一概吞掉', async () => {
    backendMode = 'reset'
    expect((await fetch(`${proxy.origin}/api/health/ready`)).status).toBe(502)
    expect(proxy.evidence().problems).toEqual(['后端代理连接失败'])
  })

  it('后端已交回 200 但响应正文中途断开仍是后端故障', async () => {
    backendMode = 'reset-body'
    const result = await fetch(`${proxy.origin}/api/health/ready`)
    expect(result.status).toBe(200)
    await expect(result.arrayBuffer()).rejects.toThrow()
    expect(proxy.evidence().problems).toEqual(['后端代理连接失败'])
    expect(proxy.evidence().clientAborts).toBe(0)
  })
})

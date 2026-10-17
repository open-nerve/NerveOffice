import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { startLocalSaveProxy } from './local-save-proxy.ts'

async function setup(run: (fixture: {
  proxy: Awaited<ReturnType<typeof startLocalSaveProxy>>
  forwarded: string[]
  post: (path: string, body: string, origin?: string) => Promise<Response>
  release: () => void
}) => Promise<void>) {
  const forwarded: string[] = []
  let held: ServerResponse | undefined
  const backend = createServer((request, response) => {
    forwarded.push(request.url ?? '')
    if (request.url === '/api/hold') {
      held = response
      return
    }
    response.writeHead(200, { 'content-security-policy': 'default-src \'self\'' })
    response.end('actual backend')
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const proxy = await startLocalSaveProxy({ runId: randomUUID(), backendOrigin: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` })
  try {
    proxy.configure({ documentId: randomUUID(), entryFragment: 'test-fragment', receive: () => ({ kind: 'wait' }) })
    const post = async (path: string, body: string, origin = proxy.origin) => fetch(`${proxy.origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })
    await run({ proxy, forwarded, post, release: () => held?.end('settled') })
  }
  finally {
    await proxy.close()
    backend.closeAllConnections()
    await new Promise<void>(resolve => backend.close(() => resolve()))
  }
}

describe('本机保存测量的应用 API 切断', () => {
  it('切断后真实连接失败；应用不再到后端，控制和静态资源仍可用', async () => setup(async ({ proxy, forwarded, post }) => {
    expect(proxy.controlPath).toContain('/__nerve-local-save/')
    proxy.arm()
    expect(await (await fetch(`${proxy.origin}/api/baseline`)).text()).toBe('actual backend')
    await vi.waitFor(() => expect(proxy.network().inFlight).toBe(0))
    const cutAt = proxy.cutApi()
    await expect(fetch(`${proxy.origin}/api/documents/test/content`, { method: 'PUT', body: 'discarded' })).rejects.toThrow()
    expect((await post(proxy.controlPath, '{}')).status).toBe(200)
    expect(await (await fetch(`${proxy.origin}/assets/test.js`)).text()).toBe('actual backend')
    expect(forwarded).toEqual(['/api/baseline', '/assets/test.js'])
    const evidence = proxy.network()
    expect(evidence.cutAt).toBe(cutAt)
    expect(evidence.requests).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/baseline', forwarded: true, status: 200, completedAt: expect.any(Number) as unknown }),
      expect.objectContaining({ method: 'PUT', path: '/api/documents/test/content', forwarded: false, status: null, completedAt: expect.any(Number) as unknown }),
    ])
    expect(evidence.requests[1]?.startedAt).toBeGreaterThanOrEqual(cutAt)
    expect(proxy.evidence().problems).toEqual([])
    expect(() => proxy.cutApi()).toThrow()
    expect('allowRecoveryEntry' in proxy).toBe(false)
  }))

  it('在途应用响应没有结束时拒绝切断，结束后原始响应与终态留档', async () => setup(async ({ proxy, release }) => {
    proxy.arm()
    const request = fetch(`${proxy.origin}/api/hold`).then(async response => response.text()).then(text => ({ text }), (error: unknown) => ({ error }))
    await vi.waitFor(() => expect(proxy.network().inFlight).toBe(1))
    expect(() => proxy.cutApi()).toThrow('在途')
    expect(proxy.network().cutAt).toBeNull()
    release()
    expect(await request).toEqual({ text: 'settled' })
    await vi.waitFor(() => expect(proxy.network().inFlight).toBe(0))
    expect(proxy.cutApi()).toBeGreaterThanOrEqual(proxy.network().requests[0]?.completedAt ?? Infinity)
    expect(proxy.network().requests[0]?.status).toBe(200)
  }))

  it('未启动不能切断；控制消息不能调用切断操作', async () => setup(async ({ proxy, post }) => {
    expect(() => proxy.cutApi()).toThrow()
    expect((await post(proxy.controlPath, '{"kind":"cutApi"}')).status).toBe(403)
    proxy.arm()
    expect((await post(proxy.controlPath, '{"kind":"cutApi"}')).status).toBe(200)
    expect(proxy.network().cutAt).toBeNull()
  }))

  it('跨来源、错 Host、未知控制路径和超限正文不能穿透到后端', async () => setup(async ({ proxy, forwarded, post }) => {
    proxy.arm()
    expect((await post(proxy.controlPath, '{}', 'http://localhost:12345')).status).toBe(403)
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${proxy.origin}/api/x`, { headers: { host: 'localhost:12345' } }, (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
      request.end()
    })
    expect(wrongHost).toBe(403)
    for (const path of ['/__nerve-local-save/unknown', '/__nerve-pause/unknown', '/__nerve-crash/unknown'])
      expect((await post(path, '{}')).status).toBe(404)
    expect((await post(proxy.controlPath, JSON.stringify({ data: 'x'.repeat(65_536) }))).status).toBe(413)
    expect(forwarded).toEqual([])
  }))

  it.each(['https://127.0.0.1:12345', 'http://localhost:12345', 'http://127.0.0.1:80', 'http://127.0.0.1:12345/path'])('拒绝非本轮本机 HTTP 后端 %s', async (backendOrigin) => {
    await expect(startLocalSaveProxy({ runId: randomUUID(), backendOrigin })).rejects.toThrow()
  })
})

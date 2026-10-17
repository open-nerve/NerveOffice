import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { startPauseProxy } from './pause-proxy.ts'

describe('暂停专用同源代理', () => {
  it('使用独立路径、一次性入口和限定大小的页面报告，不暴露崩溃恢复续发操作', async () => {
    const forwarded: string[] = []
    const backend = createServer((request, response) => {
      forwarded.push(request.url ?? '')
      response.writeHead(200, { 'content-security-policy': 'default-src \'self\'' })
      request.pipe(response)
    })
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    const runId = randomUUID()
    const proxy = await startPauseProxy({ runId, backendOrigin: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` })
    try {
      const receive = vi.fn(() => ({ kind: 'wait' }))
      proxy.configure({ documentId: randomUUID(), entryFragment: 'test-only-password', receive })
      const post = async (path: string, body: string, origin = proxy.origin) => fetch(`${proxy.origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })
      expect(proxy.controlPath).toBe(`/__nerve-pause/${runId}`)
      const html = await (await fetch(proxy.startUrl)).text()
      expect(html).toContain('暂停恢复验证')
      expect(html).not.toContain('test-only-password')
      expect(html).not.toContain('__nerve-crash')
      expect((await post(proxy.controlPath, '{}')).status).toBe(403)
      proxy.arm()
      expect((await post(proxy.controlPath, '{}', 'http://localhost:12000')).status).toBe(403)
      expect((await post('/__nerve-pause/unknown', '{}')).status).toBe(404)
      expect((await post(`/__nerve-crash/${runId}`, '{}')).status).toBe(404)
      const message = { kind: 'complete', report: 'x'.repeat(16_384) }
      expect((await post(proxy.controlPath, JSON.stringify(message))).status).toBe(200)
      expect(receive).toHaveBeenCalledExactlyOnceWith(message, expect.any(Number))
      expect((await post(proxy.controlPath, JSON.stringify({ report: 'x'.repeat(65_536) }))).status).toBe(413)
      expect(receive).toHaveBeenCalledTimes(1)
      const enter = async () => fetch(`${proxy.origin}${proxy.entryPath}`, { redirect: 'manual', headers: { referer: proxy.startUrl } })
      expect((await enter()).status).toBe(302)
      expect((await enter()).status).toBe(403)
      expect('allowRecoveryEntry' in proxy).toBe(false)
      expect(forwarded).toEqual([])
      const response = await post('/api/test', 'unchanged')
      expect(await response.text()).toBe('unchanged')
      expect(response.headers.get('content-security-policy')).toBe('default-src \'self\'')
      expect(forwarded).toEqual(['/api/test'])
    }
    finally {
      await proxy.close()
      backend.closeAllConnections()
      await new Promise<void>(resolve => backend.close(() => resolve()))
    }
  })
})

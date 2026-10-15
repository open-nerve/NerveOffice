import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, setCsrfToken } from '../api/client.ts'
import { trackSessionRequest } from '../local-drafts/session-activation.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { apiError, installFakeApi, json } from './fake-api.test-support.ts'

vi.mock('../local-drafts/session-activation.ts', () => ({ trackSessionRequest: vi.fn() }))

const RESPONSE: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'new-csrf',
  features: { localDraftsEnabled: true },
}

interface SessionRequestEntry {
  readonly name: string
  readonly kind: 'query' | 'mutation'
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly call: () => Promise<SessionResponse>
}

export function sessionRequestCases(entries: readonly SessionRequestEntry[]): void {
  beforeEach(() => {
    vi.mocked(trackSessionRequest).mockReset()
    setCsrfToken('existing-csrf')
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('会话响应入口共用网络前票据', () => {
    for (const entry of entries) {
      it(`${entry.name} 先等待本机票据，再发送既有 API；响应与 CSRF 行为不变`, async () => {
        const started = deferred<void>()
        let tracked: SessionResponse | undefined
        vi.mocked(trackSessionRequest).mockImplementation(async (_kind, request) => {
          await started.promise
          const response = await request()
          tracked = response
          return response
        })
        const api = installFakeApi({
          [`${entry.method} ${entry.path}`]: () => json(200, RESPONSE),
          'POST /api/check-csrf': () => new Response(null, { status: 204 }),
        })
        const pending = entry.call()
        await vi.waitFor(() => expect(trackSessionRequest).toHaveBeenCalledTimes(1))
        expect(api.requests).toEqual([])
        expect(vi.mocked(trackSessionRequest).mock.calls[0]?.[0]).toBe(entry.kind)
        started.resolve()
        const response = await pending
        expect(response).toEqual(RESPONSE)
        expect(response).toBe(tracked)
        await apiFetch('/api/check-csrf', { method: 'POST' }, () => undefined)
        // 原查询不替调用方接纳令牌；四个变更入口保持原来自动安装新令牌的行为。
        expect(api.requests[1]?.headers['x-csrf-token']).toBe(entry.kind === 'query' ? 'existing-csrf' : 'new-csrf')
      })

      it(`${entry.name} 的网络失败穿过按需入口，不重复请求`, async () => {
        vi.mocked(trackSessionRequest).mockImplementation(async (_kind, request) => request())
        const api = installFakeApi({ [`${entry.method} ${entry.path}`]: () => apiError(503, 'INTERNAL_ERROR', '临时失败') })
        await expect(entry.call()).rejects.toMatchObject({ status: 503 })
        expect(trackSessionRequest).toHaveBeenCalledTimes(1)
        expect(api.requests).toHaveLength(1)
      })
    }
  })
}

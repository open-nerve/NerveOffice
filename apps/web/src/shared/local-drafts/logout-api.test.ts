import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apiRequest, setApiSession, setCsrfToken } from '../api/client.ts'
import { apiError, installFakeApi } from '../testing/fake-api.test-support.ts'
import { requestLogout } from './logout-api.ts'

const SESSION: SessionResponse = { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '甲' }, csrfToken: 'original-csrf', features: { localDraftsEnabled: true } }

afterEach(() => {
  setCsrfToken(undefined)
  vi.unstubAllGlobals()
})

it('退出请求只带确认时的令牌，不能使用或修改本页后来采纳的新令牌', async () => {
  const api = installFakeApi({ 'POST /api/auth/logout': () => new Response(null, { status: 204 }), 'POST /api/test': () => new Response(null, { status: 204 }) })
  setApiSession({ ...SESSION, csrfToken: 'new-csrf' })
  await requestLogout(SESSION)
  await apiRequest('/api/test', { method: 'POST', schema: z.undefined() })
  expect(api.requests.map(request => request.headers['x-csrf-token'])).toEqual(['original-csrf', 'new-csrf'])
})

it('原会话失效就原样报告，不查询或采纳同用户的新登录重发退出', async () => {
  const api = installFakeApi({ 'POST /api/auth/logout': () => apiError(401, 'SESSION_EXPIRED', '原登录失效') })
  setApiSession({ ...SESSION, csrfToken: 'new-csrf' })
  await expect(requestLogout(SESSION)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  expect(api.requests).toHaveLength(1)
  expect(api.requests[0]?.headers['x-csrf-token']).toBe('original-csrf')
})

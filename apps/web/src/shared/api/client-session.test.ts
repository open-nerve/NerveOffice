import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { ApiError, apiRequest, setApiSession, setCsrfToken } from './client.ts'
import { rememberSessionPermit } from './session-association.ts'
import { reportRequestSessionFailure } from './session-tracking.ts'

vi.mock('./session-tracking.ts', () => ({ reportRequestSessionFailure: vi.fn(async () => {}) }))

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
function session(generation: string): SessionResponse {
  const response: SessionResponse = { user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: USER, name: '甲' }, csrfToken: generation, features: { localDraftsEnabled: true } }
  rememberSessionPermit(response, Object.freeze({ userId: USER, generation }))
  return response
}
const disabled = () => json(401, { error: { code: 'SESSION_EXPIRED', message: '登录失效', requestId: 'req-disabled', details: { reason: 'account_disabled', userId: USER } } })

afterEach(() => {
  setCsrfToken(undefined)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('普通请求固定自己的本机会话来源', () => {
  it('明确绑定旧会话的请求，其错误也不能借页面当前的新许可', async () => {
    installFakeApi({ 'POST /api/test': disabled })
    const original = session(G1)
    setApiSession(session(G2))
    const error = await apiRequest('/api/test', { method: 'POST', session: original, schema: z.undefined() }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(reportRequestSessionFailure).toHaveBeenCalledExactlyOnceWith(error, { userId: USER, generation: G1 }))
  })

  it('调用方取消携带 ApiError 时仍是取消，不能据此清理请求来源', async () => {
    const controller = new AbortController()
    const reason = new ApiError(401, 'SESSION_EXPIRED', '取消携带的旧错误', { details: { reason: 'account_disabled', userId: USER } })
    controller.abort(reason)
    setApiSession(session(G1))
    await expect(apiRequest('/api/test', { method: 'POST', schema: z.undefined(), signal: controller.signal })).rejects.toBe(reason)
    expect(reportRequestSessionFailure).not.toHaveBeenCalled()
  })

  it('旧请求发出后采纳新登录，失败处理仍收到旧许可，CSRF 也不变', async () => {
    const waiting = deferred<Response>()
    const api = installFakeApi({ 'POST /api/test': async () => waiting.promise })
    setApiSession(session(G1))
    const request = apiRequest('/api/test', { method: 'POST', schema: z.undefined() }).catch((error: unknown) => error)
    setApiSession(session(G2))
    waiting.resolve(disabled())
    const error = await request
    expect(error).toMatchObject({ status: 401, code: 'SESSION_EXPIRED' })
    await vi.waitFor(() => expect(reportRequestSessionFailure).toHaveBeenCalledExactlyOnceWith(error, { userId: USER, generation: G1 }))
    expect(api.requests[0]?.headers['x-csrf-token']).toBe(G1)
    expect(api.requests).toHaveLength(1)
  })

  it('清除令牌也清除来源；没有关联的原响应不会继承上一人的许可', async () => {
    installFakeApi({ 'POST /api/test': disabled })
    setApiSession(session(G1))
    setCsrfToken(undefined)
    await expect(apiRequest('/api/test', { method: 'POST', schema: z.undefined() })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    const copied = { ...session(G2) }
    setApiSession(copied)
    await expect(apiRequest('/api/test', { method: 'POST', schema: z.undefined() })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(reportRequestSessionFailure).not.toHaveBeenCalled()
  })

  it('本机副作用挂起或失败，不延长原请求时限、不替换原错误、更不重发请求', async () => {
    const waiting = deferred<void>()
    vi.mocked(reportRequestSessionFailure).mockImplementationOnce(async () => waiting.promise)
    const api = installFakeApi({ 'POST /api/test': disabled })
    setApiSession(session(G1))
    await expect(apiRequest('/api/test', { method: 'POST', schema: z.undefined() })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    waiting.reject(new Error('本机步骤失败'))
    await vi.waitFor(() => expect(reportRequestSessionFailure).toHaveBeenCalledTimes(1))
    expect(api.requests).toHaveLength(1)
  })
})

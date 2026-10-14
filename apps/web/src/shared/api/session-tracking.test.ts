import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const RESPONSE: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'csrf',
  features: { localDraftsEnabled: true },
}

afterEach(() => {
  vi.doUnmock('../local-drafts/session-activation.ts')
  vi.doUnmock('../local-drafts/browser-session-failure.ts')
  vi.resetModules()
})

describe('按需入口只隔离加载失败', () => {
  it('普通请求先把错误校验成事实再交给存储，原来源透传', async () => {
    const { ApiError } = await import('./api-errors.ts')
    const handleRequestSessionFailure = vi.fn(async () => {})
    vi.doMock('../local-drafts/browser-session-failure.ts', () => ({ handleRequestSessionFailure }))
    const { reportRequestSessionFailure } = await import('./session-tracking.ts')
    const permit = { userId: RESPONSE.user.id, generation: 'original' }
    await reportRequestSessionFailure(new ApiError(401, 'SESSION_EXPIRED', '停用', { details: { userId: RESPONSE.user.id, reason: 'account_disabled' } }), permit)
    expect(handleRequestSessionFailure).toHaveBeenCalledExactlyOnceWith({ kind: 'disabled', userId: RESPONSE.user.id }, permit)
  })

  it('初查把原 ticket 的失败回调交给来源协调器，存储端只接收已校验事实', async () => {
    const { ApiError } = await import('./api-errors.ts')
    const ticket = { kind: 'query', generation: 'original' }
    const error = new ApiError(401, 'UNAUTHENTICATED', '登录已结束')
    const handleQuerySessionFailure = vi.fn(async () => {})
    vi.doMock('../local-drafts/browser-session-failure.ts', () => ({ handleQuerySessionFailure }))
    vi.doMock('../local-drafts/session-activation.ts', () => ({ trackSessionRequest: async (_kind: string, _request: unknown, _signal: unknown, rejected: (error: unknown, ticket: unknown) => Promise<void>) => {
      expect(typeof rejected).toBe('function')
      await rejected(error, ticket)
      throw error
    } }))
    const { requestWithLocalSession } = await import('./session-tracking.ts')
    await expect(requestWithLocalSession('query', async () => RESPONSE)).rejects.toBe(error)
    expect(handleQuerySessionFailure).toHaveBeenCalledExactlyOnceWith({ kind: 'preserve' }, ticket)
  })

  it('本机模块加载失败时仍请求一次，返回原认证结果', async () => {
    vi.doMock('../local-drafts/session-activation.ts', () => {
      throw new Error('模块加载失败')
    })
    const { requestWithLocalSession } = await import('./session-tracking.ts')
    const request = vi.fn(async () => RESPONSE)
    expect(await requestWithLocalSession('mutation', request)).toBe(RESPONSE)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('已经进入协调器之后的网络失败不能降级成第二次登录', async () => {
    const trackSessionRequest = vi.fn(async (_kind: string, request: () => Promise<SessionResponse>) => request())
    vi.doMock('../local-drafts/session-activation.ts', () => ({ trackSessionRequest }))
    const { requestWithLocalSession } = await import('./session-tracking.ts')
    const error = new Error('响应未知')
    const request = vi.fn(async (): Promise<SessionResponse> => {
      throw error
    })
    await expect(requestWithLocalSession('mutation', request)).rejects.toBe(error)
    expect(trackSessionRequest).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

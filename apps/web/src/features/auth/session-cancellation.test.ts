import type { SessionResponse } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, setApiSession, setCsrfToken } from '../../shared/api/client.ts'
import { rememberSessionPermit } from '../../shared/api/session-association.ts'
import { currentApiSession } from '../../shared/api/session-context.ts'
import { requestSession } from '../../shared/api/session.ts'
import { createSessionActivation, draftSessionPermitOf } from '../../shared/local-drafts/session-activation.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { installFakeApi } from '../../shared/testing/fake-api.test-support.ts'
import { fetchSession } from './session.ts'

vi.mock('../../shared/api/session.ts', () => ({ requestSession: vi.fn() }))

const USER = '0199a2c4-1f2e-7a3b-8c4d-00000000000a'
const OLD_GENERATION = '0199a2c4-1f2e-7a3b-8c4d-000000000001'
const NEXT_PERMIT = { userId: USER, generation: '0199a2c4-1f2e-7a3b-8c4d-000000000002' }
const OLD: SessionResponse = {
  user: { id: USER, username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: USER, name: '个人空间' },
  csrfToken: 'old-csrf',
  features: { localDraftsEnabled: true },
}
const NEW: SessionResponse = { ...OLD, csrfToken: 'new-csrf' }

afterEach(() => {
  vi.mocked(requestSession).mockReset()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

async function expectNewSession(): Promise<void> {
  expect(currentApiSession()).toBe(NEW)
  expect(draftSessionPermitOf(NEW)).toEqual(NEXT_PERMIT)
  const api = installFakeApi({ 'POST /api/check-csrf': () => new Response(null, { status: 204 }) })
  await apiFetch('/api/check-csrf', { method: 'POST' }, () => undefined)
  expect(api.requests[0]?.headers['x-csrf-token']).toBe('new-csrf')
}

describe('已取消会话查询不能覆盖较新全局来源', () => {
  it('HTTP 成功后摘要仍在等待，新登录已被采纳，取消的旧结果不得覆盖 CSRF 或许可', async () => {
    const controller = new AbortController()
    const reason = new Error('新登录取消旧查询')
    const sourceEntered = deferred<void>()
    const sourceReady = deferred<void>()
    const acceptSessionCheck = vi.fn(async () => ({ kind: 'session-invalid' as const }))
    const rejected = vi.fn()
    const activation = createSessionActivation({
      store: {
        beginSessionCheck: async () => ({ kind: 'ticket', ticket: { kind: 'query', generation: OLD_GENERATION } }),
        acceptSessionCheck,
        failSessionChange: vi.fn(async () => ({ kind: 'released' as const })),
      },
      exclusive: async work => work(),
      source: async () => {
        sourceEntered.resolve()
        await sourceReady.promise
        return { userId: USER, sourceHash: 'a'.repeat(64) }
      },
      rejected,
    })
    const network = vi.fn(async () => OLD)
    vi.mocked(requestSession).mockImplementationOnce(async signal => activation.track('query', network, signal))
    const pending = fetchSession(controller.signal)
    const cancellation = expect(pending).rejects.toBe(reason)
    await sourceEntered.promise
    expect(network).toHaveBeenCalledTimes(1)
    rememberSessionPermit(NEW, NEXT_PERMIT)
    setApiSession(NEW)
    controller.abort(reason)
    sourceReady.resolve()
    await cancellation
    expect(acceptSessionCheck).not.toHaveBeenCalled()
    expect(rejected).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(OLD)).toBeUndefined()
    await expectNewSession()
  })

  it('底层成功返回与最终采纳之间取消，调用方仍检查 signal，不安装旧响应', async () => {
    const controller = new AbortController()
    const reason = new Error('最终采纳前取消')
    rememberSessionPermit(NEW, NEXT_PERMIT)
    setApiSession(NEW)
    vi.mocked(requestSession).mockImplementationOnce(async () => {
      controller.abort(reason)
      return OLD
    })
    await expect(fetchSession(controller.signal)).rejects.toBe(reason)
    expect(requestSession).toHaveBeenCalledExactlyOnceWith(controller.signal)
    await expectNewSession()
  })
})

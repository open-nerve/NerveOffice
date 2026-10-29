import type { SessionResponse } from '@nerve-office/contracts'
import type { LocalSessionState, SessionCheckFailure } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { acceptSessionCheck, beginSessionChange, beginUserCleanup, rejectSessionCheck, suspendSession } from '../outbox/session-fence.ts'
import { installFakeApi, json } from '../testing/fake-api.test-support.ts'

export const COORD_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const COORD_GENERATION = '00000000-0000-4000-8000-000000000011'

/** 仅替换 IDB、锁与网络边界；请求入口、资格票据、失效处理和 fence 转移全部用生产代码。 */
export async function sessionCoordinationFixture() {
  vi.resetModules()
  let state: LocalSessionState = { phase: 'active', generation: COORD_GENERATION, source: { userId: COORD_USER, sourceHash: 'a'.repeat(64) }, activatedFrom: '00000000-0000-4000-8000-000000000010' }
  let sequence = 20
  const next = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  let locked = false
  let tail = Promise.resolve()
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail
    const done = deferred<void>()
    tail = done.promise
    await previous
    locked = true
    try {
      return await work()
    }
    finally {
      locked = false
      done.resolve()
    }
  }
  const store = {
    beginSessionCheck: vi.fn<SessionStore['beginSessionCheck']>(async (kind) => {
      expect(locked).toBe(true)
      if (kind === 'mutation') {
        const changing = beginSessionChange(state, next(), 1_000)
        state = changing.state
        return { kind: 'ticket', ticket: changing.ticket }
      }
      return { kind: 'ticket', ticket: { kind, generation: state.generation } }
    }),
    acceptSessionCheck: vi.fn<SessionStore['acceptSessionCheck']>(async (ticket, source, allow) => {
      expect(locked).toBe(true)
      if (allow?.() === false)
        return { kind: 'session-invalid' }
      const accepted = acceptSessionCheck(state, ticket, source, next(), 1_001)
      if (accepted === undefined)
        return { kind: 'session-invalid' }
      state = accepted.state
      return { kind: 'active', permit: accepted.permit }
    }),
    failSessionChange: vi.fn<SessionStore['failSessionChange']>(async () => ({ kind: 'released' })),
    suspendSession: vi.fn<SessionStore['suspendSession']>(async (permit) => {
      expect(locked).toBe(true)
      const stopped = suspendSession(state, permit, next())
      if (stopped === undefined)
        return { kind: 'session-invalid' }
      state = stopped
      return { kind: 'suspended' }
    }),
    beginUserCleanup: vi.fn<SessionStore['beginUserCleanup']>(async (permit, cause) => {
      expect(locked).toBe(true)
      const stopped = beginUserCleanup(state, permit, cause, next())
      if (stopped === undefined)
        return { kind: 'session-invalid' }
      state = stopped.state
      return { kind: 'clearing', permit: stopped.permit }
    }),
    rejectSessionCheck: vi.fn<SessionStore['rejectSessionCheck']>(async (ticket, facts) => {
      expect(locked).toBe(true)
      const stopped = rejectSessionCheck(state, ticket, facts, next())
      if (stopped === undefined)
        return { kind: 'invalidated' }
      state = stopped.state
      return stopped.result
    }),
  }
  vi.doMock('../outbox/session-store.ts', () => ({ createSessionStore: () => store }))
  vi.doMock('../outbox/outbox-lock.ts', () => ({ withOutboxLock: exclusive }))
  const { createSessionFailure } = await import('../local-drafts/session-failure.ts')
  const { publishLocalSession } = await import('../local-drafts/session-events.ts')
  const failure = createSessionFailure({ sessions: store, exclusive, stopped: (previous, cleanup) => publishLocalSession({ kind: 'stopped', previous, cleanup }) })
  const entered = deferred<void>()
  const preserved = deferred<void>()
  const disabled = deferred<void>()
  const completed: Promise<unknown>[] = []
  const handleRequestSessionFailure = async (facts: SessionCheckFailure, permit: unknown) => {
    entered.resolve()
    const operation = (async () => {
      await (facts.kind === 'disabled' ? disabled.promise : preserved.promise)
      return failure.request(facts, permit)
    })()
    completed.push(operation)
    return operation
  }
  vi.doMock('../local-drafts/browser-session-failure.ts', () => ({ handleRequestSessionFailure, handleQuerySessionFailure: failure.query }))
  const client = await import('./client.ts')
  const tracking = await import('./session-tracking.ts')
  const association = await import('./session-association.ts')
  const activation = await import('../local-drafts/session-activation.ts')
  const response = (token = 'csrf'): SessionResponse => ({ user: { id: COORD_USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: COORD_USER, name: '甲' }, csrfToken: token, features: { localDraftsEnabled: true } })
  // 使用与真实摘要一致的初始来源，确保普通 query 确实会共享 G1，而不是测试夹具误换代。
  state = { ...state, source: await activation.sessionSourceOf(response()) }
  const initial = await activation.trackSessionRequest('query', async () => response(), undefined, async () => {})
  store.beginSessionCheck.mockClear()
  store.acceptSessionCheck.mockClear()
  client.setApiSession(initial)
  const network = installFakeApi({ 'PUT /api/test-renew': () => json(403, { error: { code: 'CSRF_TOKEN_INVALID', message: '令牌失效', requestId: 'request-csrf' } }) })
  const query = vi.fn(async () => {
    expect(locked).toBe(false)
    return response()
  })
  return {
    client,
    tracking,
    association,
    activation,
    initial,
    response,
    query,
    store,
    entered,
    preserved,
    disabled,
    network,
    state: () => state,
    fail: async () => client.apiRequest('/api/test-renew', { method: 'PUT', schema: z.undefined() }),
    check: async (signal?: AbortSignal) => tracking.requestWithLocalSession('query', query, signal),
    finish: async () => {
      preserved.resolve()
      disabled.resolve()
      await Promise.all(completed)
    },
  }
}

export function resetSessionCoordinationFixture(): void {
  vi.doUnmock('../outbox/session-store.ts')
  vi.doUnmock('../outbox/outbox-lock.ts')
  vi.doUnmock('../local-drafts/browser-session-failure.ts')
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.useRealTimers()
}

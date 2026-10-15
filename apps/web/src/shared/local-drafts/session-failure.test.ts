import type { LocalSessionState, SessionCheckTicket } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../api/api-errors.ts'
import { sessionFailureOf } from '../api/session-failure-facts.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { beginUserCleanup, rejectSessionCheck, suspendSession } from '../outbox/session-fence.ts'
import { createSessionFailure } from './session-failure.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const G0 = '00000000-0000-4000-8000-000000000010'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const G3 = '00000000-0000-4000-8000-000000000013'
const PERMIT = { userId: USER, generation: G1 }
const TICKET: SessionCheckTicket = { kind: 'query', generation: G1 }
const source = { userId: USER, sourceHash: 'a'.repeat(64) }
const disabled = (userId: string = USER) => new ApiError(401, 'SESSION_EXPIRED', '已停用', { details: { reason: 'account_disabled', userId } })

function fixture() {
  let state: LocalSessionState | undefined = { phase: 'active', generation: G1, source, activatedFrom: G0 }
  let locked = false
  const stopped = vi.fn(async () => {
    expect(locked).toBe(false)
  })
  const sessions = {
    beginUserCleanup: vi.fn<SessionStore['beginUserCleanup']>(async (permit, cause) => {
      expect(locked).toBe(true)
      const next = state === undefined ? undefined : beginUserCleanup(state, permit, cause, G3)
      if (next === undefined)
        return { kind: 'session-invalid' }
      state = next.state
      return { kind: 'clearing', permit: next.permit }
    }),
    suspendSession: vi.fn<SessionStore['suspendSession']>(async (permit) => {
      expect(locked).toBe(true)
      const next = state === undefined ? undefined : suspendSession(state, permit, G3)
      if (next === undefined)
        return { kind: 'session-invalid' }
      state = next
      return { kind: 'suspended' }
    }),
    rejectSessionCheck: vi.fn<SessionStore['rejectSessionCheck']>(async (ticket, failure) => {
      expect(locked).toBe(true)
      const next = state === undefined ? undefined : rejectSessionCheck(state, ticket, failure, G3)
      if (next === undefined)
        return { kind: 'invalidated' }
      state = next.state
      return next.result
    }),
  }
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    expect(locked).toBe(false)
    locked = true
    try {
      return await work()
    }
    finally {
      locked = false
    }
  }
  const failure = createSessionFailure({ sessions, exclusive, stopped })
  return {
    request: async (error: unknown, original: unknown) => failure.request(sessionFailureOf(error), original),
    query: async (error: unknown, ticket: SessionCheckTicket) => failure.query(sessionFailureOf(error), ticket),
    sessions,
    stopped,
    state: () => state,
    replace: (next: LocalSessionState | undefined) => {
      state = next
    },
  }
}

describe('认证失败事实分类', () => {
  it('只有契约确认的停用和已知账户才能成为删除原因', () => {
    expect(sessionFailureOf(disabled())).toEqual({ kind: 'disabled', userId: USER })
    for (const details of [{ reason: 'account_disabled' }, { reason: 'account_disabled', userId: 'unknown' }, { reason: 'future', userId: USER }, undefined])
      expect(sessionFailureOf(new ApiError(401, 'SESSION_EXPIRED', 'x', { details }))).toEqual({ kind: 'preserve' })
  })
  it.each(['password_reset', 'password_changed', 'replaced', 'logout', 'expired'])('%s 只暂停本机写入并保留', (reason) => {
    expect(sessionFailureOf(new ApiError(401, 'SESSION_EXPIRED', 'x', { details: { reason, userId: USER } }))).toEqual({ kind: 'preserve' })
  })
  it.each([
    new NetworkError('断网'),
    new Error('中止'),
    new ApiError(500, 'SESSION_EXPIRED', '无效状态'),
    new ApiError(500, 'INTERNAL_ERROR', '失败'),
    new ApiError(403, 'PERMISSION_DENIED', '权限'),
  ])('网络未知/非认证错误不启动会话清理 %#', error => expect(sessionFailureOf(error)).toBeUndefined())
})

describe('原请求失效协调', () => {
  it('持久化停写资格后才通知本页与其他页；清理许可只属于该原账户', async () => {
    const t = fixture()
    const hold = deferred<Awaited<ReturnType<SessionStore['beginUserCleanup']>>>()
    t.sessions.beginUserCleanup.mockImplementationOnce(async () => hold.promise)
    const pending = t.request(disabled(), PERMIT)
    expect(t.stopped).not.toHaveBeenCalled()
    const permit = { userId: USER, generation: G3, cause: 'account_disabled' as const }
    hold.resolve({ kind: 'clearing', permit })
    await pending
    expect(t.stopped).toHaveBeenCalledExactlyOnceWith(PERMIT, permit)
  })
  it.each([USER, OTHER])('新登录 %s 后旧请求失败不能停止新来源，更不能取得清理许可', async (userId) => {
    const t = fixture()
    t.replace({ phase: 'active', generation: G2, source: { userId, sourceHash: 'b'.repeat(64) }, activatedFrom: G1 })
    await t.request(disabled(), PERMIT)
    await t.query(disabled(), TICKET)
    expect(t.state()?.generation).toBe(G2)
    expect(t.stopped).not.toHaveBeenCalled()
  })
  it('停用原因的 userId 不匹配、没有许可或许可形状未知时，不做删除', async () => {
    const t = fixture()
    await t.request(disabled(OTHER), PERMIT)
    await t.request(disabled(), undefined)
    await t.request(disabled(), { ...PERMIT, extra: true })
    expect(t.sessions.beginUserCleanup).not.toHaveBeenCalled()
    expect(t.stopped).not.toHaveBeenCalled()
  })
  it.each(['UNAUTHENTICATED', 'SESSION_EXPIRED', 'CSRF_TOKEN_INVALID'])('%s 的非停用失败保留原件，只撤销旧写入代次', async (code) => {
    const t = fixture()
    await t.request(new ApiError(code === 'CSRF_TOKEN_INVALID' ? 403 : 401, code, '需核对'), PERMIT)
    expect(t.state()?.phase).toBe('suspended')
    expect(t.sessions.beginUserCleanup).not.toHaveBeenCalled()
    expect(t.stopped).toHaveBeenCalledExactlyOnceWith(PERMIT, undefined)
  })
  it('没有页面许可的初始查询使用原 ticket，不能在错误回来后再拍一张', async () => {
    const t = fixture()
    await t.query(disabled(), TICKET)
    expect(t.sessions.rejectSessionCheck).toHaveBeenCalledExactlyOnceWith(TICKET, { kind: 'disabled', userId: USER })
    expect(t.stopped).toHaveBeenCalledExactlyOnceWith(PERMIT, { userId: USER, generation: G3, cause: 'account_disabled' })
  })
  it('同源通知引起再次查询时，已经暂停的来源不再通知，终止会话查询反馈循环', async () => {
    const t = fixture()
    t.replace({ phase: 'suspended', generation: G1, source })
    await t.query(new ApiError(401, 'UNAUTHENTICATED', '需登录'), TICKET)
    expect(t.state()).toEqual({ phase: 'suspended', generation: G1, source })
    expect(t.stopped).not.toHaveBeenCalled()
  })
  it('未知持久格式、IDB 故障和事件回调抛错都不能伪造完成或抛给原网络请求', async () => {
    const t = fixture()
    t.replace(undefined)
    await t.query(disabled(), TICKET)
    expect(t.stopped).not.toHaveBeenCalled()
    t.sessions.beginUserCleanup.mockRejectedValueOnce(new Error('库不可用'))
    await expect(t.request(disabled(), PERMIT)).resolves.toBeUndefined()
    expect(t.stopped).not.toHaveBeenCalled()
    t.sessions.suspendSession.mockResolvedValueOnce({ kind: 'suspended' })
    t.stopped.mockRejectedValueOnce(new Error('本页已经关闭'))
    await expect(t.request(new ApiError(401, 'UNAUTHENTICATED', '需登录'), PERMIT)).resolves.toBeUndefined()
  })
})

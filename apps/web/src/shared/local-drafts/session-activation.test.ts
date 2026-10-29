import type { SessionResponse } from '@nerve-office/contracts'
import type { SessionStore } from '../outbox/session-store.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/api-errors.ts'
import { rememberSessionPermit } from '../api/session-association.ts'
import { deferred, fakeOutboxLocks } from '../outbox/outbox-lock.test-support.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { createSessionActivation, draftSessionPermitOf, sessionSourceOf } from './session-activation.ts'

const USER = '0199a2c4-1f2e-7a3b-8c4d-00000000000a'
const INITIAL = '0199a2c4-1f2e-7a3b-8c4d-000000000001'
const NEXT = '0199a2c4-1f2e-7a3b-8c4d-000000000002'
const PERMIT = { userId: USER, generation: NEXT }
const SOURCE = { userId: USER, sourceHash: 'a'.repeat(64) }

function response(): SessionResponse {
  return {
    user: { id: USER, username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
    personalSpace: { id: '0199a2c4-1f2e-7a3b-8c4d-000000000003', name: '爱丽丝' },
    csrfToken: 'session-specific-csrf',
    features: { localDraftsEnabled: true },
  }
}

function fixture() {
  let locked = false
  const trace: string[] = []
  const store = {
    beginSessionCheck: vi.fn<SessionStore['beginSessionCheck']>(async (kind) => {
      expect(locked).toBe(true)
      trace.push(`begin:${kind}`)
      return { kind: 'ticket', ticket: { kind, generation: INITIAL } }
    }),
    acceptSessionCheck: vi.fn<SessionStore['acceptSessionCheck']>(async () => {
      expect(locked).toBe(true)
      trace.push('accept')
      return { kind: 'active', permit: PERMIT }
    }),
    failSessionChange: vi.fn<SessionStore['failSessionChange']>(async () => {
      expect(locked).toBe(true)
      trace.push('fail')
      return { kind: 'released' }
    }),
  }
  const locks = fakeOutboxLocks()
  const lockEntry = vi.fn<() => void>()
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    lockEntry()
    return withOutboxLock(async () => {
      expect(locked).toBe(false)
      locked = true
      try {
        return await work()
      }
      finally {
        locked = false
      }
    }, locks)
  }
  const source = vi.fn(async (_response: SessionResponse) => {
    expect(locked).toBe(false)
    trace.push('source')
    return SOURCE
  })
  const result = response()
  const request = vi.fn(async () => {
    expect(locked).toBe(false)
    trace.push('network')
    return result
  })
  const rejected = vi.fn(async (_error: unknown, _ticket: { readonly kind: 'query' | 'mutation', readonly generation: string }) => {
    expect(locked).toBe(false)
  })
  return { ...createSessionActivation({ store, exclusive, source, rejected }), store, locks, lockEntry, source, request, result, trace, rejected }
}

describe('真实请求前固定本机票据', () => {
  it('初查主动取消携带旧 ApiError 时原样抛出，不视为新的服务端停用证据', async () => {
    const t = fixture()
    const controller = new AbortController()
    const reason = new ApiError(401, 'SESSION_EXPIRED', '旧错误', { details: { reason: 'account_disabled', userId: USER } })
    controller.abort(reason)
    t.request.mockRejectedValue(reason)
    await expect(t.track('query', t.request, controller.signal)).rejects.toBe(reason)
    expect(t.rejected).not.toHaveBeenCalled()
  })

  it.each([true, false])('HTTP 已成功后取消（前置票据可用：%s），不继续本机激活或返回响应', async (available) => {
    const t = fixture()
    const controller = new AbortController()
    const reason = new Error('查询已取消')
    if (!available)
      t.store.beginSessionCheck.mockResolvedValueOnce({ kind: 'unavailable', reason: 'denied' })
    t.request.mockImplementationOnce(async () => {
      controller.abort(reason)
      return t.result
    })
    await expect(t.track('query', t.request, controller.signal)).rejects.toBe(reason)
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(t.source).not.toHaveBeenCalled()
    expect(t.store.acceptSessionCheck).not.toHaveBeenCalled()
    expect(t.rejected).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it.each([true, false])('摘要等待期间取消（摘要成功：%s），本机故障降级不能吞掉原取消原因', async (succeeds) => {
    const t = fixture()
    const controller = new AbortController()
    const reason = new ApiError(401, 'SESSION_EXPIRED', '只用作主动取消原因', { details: { reason: 'account_disabled', userId: USER } })
    const entered = deferred<void>()
    const source = deferred<typeof SOURCE>()
    t.source.mockImplementationOnce(async () => {
      entered.resolve()
      return source.promise
    })
    const waiting = t.track('query', t.request, controller.signal)
    const rejected = expect(waiting).rejects.toBe(reason)
    await entered.promise
    controller.abort(reason)
    if (succeeds)
      source.resolve(SOURCE)
    else
      source.reject(new Error('摘要失败'))
    await rejected
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(t.store.acceptSessionCheck).not.toHaveBeenCalled()
    expect(t.store.failSessionChange).not.toHaveBeenCalled()
    expect(t.rejected).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it('摘要已完成、接受票据正在排同源锁时取消，进入锁后仍不能建立许可', async () => {
    const t = fixture()
    const controller = new AbortController()
    const reason = new Error('排锁期间取消')
    const sourceEntered = deferred<void>()
    const sourceReady = deferred<typeof SOURCE>()
    t.source.mockImplementationOnce(async () => {
      sourceEntered.resolve()
      return sourceReady.promise
    })
    const waiting = t.track('query', t.request, controller.signal)
    const rejected = expect(waiting).rejects.toBe(reason)
    await sourceEntered.promise
    const locked = deferred<void>()
    const unlock = deferred<void>()
    const blocking = withOutboxLock(async () => {
      locked.resolve()
      await unlock.promise
    }, t.locks)
    await locked.promise
    sourceReady.resolve(SOURCE)
    await vi.waitFor(() => expect(t.lockEntry).toHaveBeenCalledTimes(2))
    expect(t.store.acceptSessionCheck).not.toHaveBeenCalled()
    controller.abort(reason)
    unlock.resolve()
    await blocking
    await rejected
    expect(t.store.acceptSessionCheck).not.toHaveBeenCalled()
    expect(t.rejected).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it('接受事务已开始后取消，不将稍后完成的原许可关联或返回给已取消的调用方', async () => {
    const t = fixture()
    const controller = new AbortController()
    const reason = new Error('等待事务期间取消')
    const entered = deferred<void>()
    const finish = deferred<void>()
    t.store.acceptSessionCheck.mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
      return { kind: 'active', permit: PERMIT }
    })
    const waiting = t.track('query', t.request, controller.signal)
    const rejected = expect(waiting).rejects.toBe(reason)
    await entered.promise
    controller.abort(reason)
    finish.resolve()
    await rejected
    expect(t.store.acceptSessionCheck).toHaveBeenCalledExactlyOnceWith({ kind: 'query', generation: INITIAL }, SOURCE, expect.any(Function))
    expect(t.store.failSessionChange).not.toHaveBeenCalled()
    expect(t.rejected).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it('接受已入锁但仓库尚未决定时取消，同步否决阻止真正接受且仍抛原取消原因', async () => {
    const t = fixture()
    const controller = new AbortController()
    const reason = new Error('IDB 读取期间取消')
    const entered = deferred<void>()
    const decide = deferred<void>()
    let accepted = false
    t.store.acceptSessionCheck.mockImplementationOnce(async (_ticket, _source, allow) => {
      entered.resolve()
      await decide.promise
      if (allow?.() === false)
        return { kind: 'session-invalid' }
      accepted = true
      return { kind: 'active', permit: PERMIT }
    })
    const waiting = t.track('query', t.request, controller.signal)
    const rejected = expect(waiting).rejects.toBe(reason)
    await entered.promise
    controller.abort(reason)
    decide.resolve()
    await rejected
    expect(accepted).toBe(false)
    expect(t.store.beginSessionCheck).toHaveBeenCalledOnce()
    expect(t.request).toHaveBeenCalledOnce()
    expect(t.rejected).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it('初次会话查询失败把原票据交给失效处理，不在响应后另取许可；处理失败仍只抛原网络错误', async () => {
    const t = fixture()
    const error = new ApiError(401, 'SESSION_EXPIRED', '账户已停用', { details: { reason: 'account_disabled', userId: USER } })
    t.request.mockRejectedValue(error)
    t.rejected.mockRejectedValue(new Error('存储失败'))
    await expect(t.track('query', t.request)).rejects.toBe(error)
    expect(t.rejected).toHaveBeenCalledExactlyOnceWith(error, { kind: 'query', generation: INITIAL })
    expect(t.store.beginSessionCheck).toHaveBeenCalledTimes(1)
    expect(t.request).toHaveBeenCalledTimes(1)
  })

  it.each(['query', 'mutation'] as const)('%s 的票据先于网络，摘要在锁外，接受后只关联原响应对象', async (kind) => {
    const t = fixture()
    const fields = Object.keys(t.result)
    expect(await t.track(kind, t.request)).toBe(t.result)
    expect(t.trace).toEqual([`begin:${kind}`, 'network', 'source', 'accept'])
    expect(t.store.acceptSessionCheck).toHaveBeenCalledExactlyOnceWith({ kind, generation: INITIAL }, SOURCE, expect.any(Function))
    expect(t.source).toHaveBeenCalledExactlyOnceWith(t.result)
    expect(draftSessionPermitOf(t.result)).toEqual(PERMIT)
    expect(draftSessionPermitOf({ ...t.result })).toBeUndefined()
    expect(Object.keys(t.result)).toEqual(fields)
  })

  it('较新请求完成后，迟到响应仍只用自己的旧票据，拒绝后不重新取票据', async () => {
    const t = fixture()
    const earlier = deferred<SessionResponse>()
    const waiting = t.track('query', async () => earlier.promise)
    await vi.waitFor(() => expect(t.store.beginSessionCheck).toHaveBeenCalledTimes(1))
    t.store.beginSessionCheck.mockResolvedValueOnce({ kind: 'ticket', ticket: { kind: 'mutation', generation: NEXT } })
    const newer = response()
    await t.track('mutation', async () => newer)
    t.store.acceptSessionCheck.mockResolvedValueOnce({ kind: 'session-invalid' })
    earlier.resolve(t.result)
    expect(await waiting).toBe(t.result)
    expect(t.store.beginSessionCheck).toHaveBeenCalledTimes(2)
    expect(t.store.acceptSessionCheck.mock.calls.map(call => call[0])).toEqual([
      { kind: 'mutation', generation: NEXT },
      { kind: 'query', generation: INITIAL },
    ])
    expect(draftSessionPermitOf(newer)).toEqual(PERMIT)
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it.each(['query', 'mutation'] as const)('%s 的网络错误原样抛出，变更仅释放自己原先的票据', async (kind) => {
    const t = fixture()
    const error = new Error('请求结果未知')
    t.request.mockRejectedValue(error)
    await expect(t.track(kind, t.request)).rejects.toBe(error)
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(t.store.acceptSessionCheck).not.toHaveBeenCalled()
    if (kind === 'mutation')
      expect(t.store.failSessionChange).toHaveBeenCalledExactlyOnceWith({ kind, generation: INITIAL })
    else
      expect(t.store.failSessionChange).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'quota' },
    { kind: 'unavailable', reason: 'unsupported' },
    { kind: 'failed', error: new Error('状态损坏') },
    { kind: 'session-invalid' },
  ] as const)('前置状态失败 %j 不吞认证结果，也不假发本机许可', async (problem) => {
    const t = fixture()
    t.store.beginSessionCheck.mockResolvedValue(problem)
    expect(await t.track('mutation', t.request)).toBe(t.result)
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(t.store.acceptSessionCheck).not.toHaveBeenCalled()
    expect(t.source).not.toHaveBeenCalled()
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it.each(['lock', 'begin', 'source', 'accept'] as const)('%s 抛错仍返回网络的成功结果，不重发请求', async (failure) => {
    const t = fixture()
    const error = new Error('本机环节失败')
    if (failure === 'lock')
      t.lockEntry.mockImplementationOnce(() => { throw error })
    if (failure === 'begin')
      t.store.beginSessionCheck.mockRejectedValueOnce(error)
    if (failure === 'source')
      t.source.mockRejectedValueOnce(error)
    if (failure === 'accept')
      t.store.acceptSessionCheck.mockRejectedValueOnce(error)
    expect(await t.track('query', t.request)).toBe(t.result)
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it('释放失败或旧变更已失效不能覆盖网络错误，也不能补拍新票据', async () => {
    const t = fixture()
    const network = new Error('网络中断')
    t.request.mockRejectedValue(network)
    t.store.failSessionChange.mockRejectedValue(new Error('本地连接断开'))
    await expect(t.track('mutation', t.request)).rejects.toBe(network)
    expect(t.store.beginSessionCheck).toHaveBeenCalledTimes(1)
    expect(t.store.failSessionChange).toHaveBeenCalledExactlyOnceWith({ kind: 'mutation', generation: INITIAL })
  })

  it('响应复用时失败结果删除旧关联；取得的许可始终是独立副本', async () => {
    const t = fixture()
    rememberSessionPermit(t.result, PERMIT)
    const first = draftSessionPermitOf(t.result)
    expect(first).toEqual(PERMIT)
    expect(first).not.toBe(PERMIT)
    t.store.acceptSessionCheck.mockResolvedValueOnce({ kind: 'session-invalid' })
    await t.track('query', t.request)
    expect(draftSessionPermitOf(t.result)).toBeUndefined()
  })

  it('用户不同或 CSRF 不同都产生不同的用途隔离摘要，状态不含原令牌', async () => {
    const current = response()
    const source = await sessionSourceOf(current)
    expect(source.userId).toBe(USER)
    expect(source.sourceHash).toMatch(/^[\da-f]{64}$/)
    expect(Object.keys(source)).toEqual(['userId', 'sourceHash'])
    expect(await sessionSourceOf({ ...current })).toEqual(source)
    expect((await sessionSourceOf({ ...current, csrfToken: 'another-session' })).sourceHash).not.toBe(source.sourceHash)
    expect((await sessionSourceOf({ ...current, user: { ...current.user, id: NEXT } })).sourceHash).not.toBe(source.sourceHash)
    expect(JSON.stringify(source)).not.toContain(current.csrfToken)
  })
})

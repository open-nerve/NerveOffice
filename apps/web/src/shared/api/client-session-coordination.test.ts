import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { COORD_GENERATION, resetSessionCoordinationFixture, sessionCoordinationFixture } from './session-coordination.test-support.ts'

afterEach(resetSessionCoordinationFixture)

describe('请求失败登记与后续真实会话查询', () => {
  it('原 403 立即返回，后续查询须等停写后再取票；一次查询获得新许可', async () => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ status: 403, code: 'CSRF_TOKEN_INVALID' })
    await t.entered.promise
    expect(t.state().phase).toBe('active')
    const check = t.check()
    await vi.dynamicImportSettled()
    // 若查询抢在已登记的停写前发出，旧 G1 会被重新采用，本断言和最终许可断言都会失败。
    expect.soft(t.query).not.toHaveBeenCalled()
    t.preserved.resolve()
    const confirmed = await check
    await t.finish()
    expect(t.network.requests).toHaveLength(1)
    expect(t.query).toHaveBeenCalledOnce()
    expect(t.activation.draftSessionPermitOf(confirmed)?.generation).not.toBe(COORD_GENERATION)
    expect(t.activation.draftSessionPermitOf(confirmed)).toEqual({ userId: t.initial.user.id, generation: t.state().generation })
    expect(t.state().phase).toBe('active')
  })

  it('副作用吞掉存储异常不代表停写成功，真实 200 不得重新关联原许可', async () => {
    const t = await sessionCoordinationFixture()
    t.store.suspendSession.mockRejectedValueOnce(new Error('IDB 暂不可用'))
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.finish()
    const confirmed = await t.check()
    expect(t.query).toHaveBeenCalledOnce()
    expect(confirmed).toEqual(t.response())
    expect(t.activation.draftSessionPermitOf(confirmed)).toBeUndefined()
    expect(t.state().generation).toBe(COORD_GENERATION)
  })

  it('采用无许可的同人响应不会忘掉原代次；后续查询重试本机事实才恢复', async () => {
    const t = await sessionCoordinationFixture()
    t.store.suspendSession.mockRejectedValueOnce(new Error('首次存储异常'))
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.finish()
    const first = await t.check()
    t.client.setApiSession(first)
    t.store.suspendSession.mockRejectedValueOnce(new Error('存储仍不可用'))
    const second = await t.check()
    expect(t.activation.draftSessionPermitOf(second)).toBeUndefined()
    t.client.setApiSession(second)
    const third = await t.check()
    expect(t.activation.draftSessionPermitOf(third)?.generation).not.toBe(COORD_GENERATION)
    expect(t.activation.draftSessionPermitOf(third)).toEqual({ userId: first.user.id, generation: t.state().generation })
    expect(t.query).toHaveBeenCalledTimes(3)
    expect(t.network.requests).toHaveLength(1)
  })

  it('等待最多三秒仍返回真实200，但原代次不授权；迟到停写后下一次真实确认恢复', async () => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.entered.promise
    const first = await t.check()
    expect(first).toEqual(t.response())
    expect(t.activation.draftSessionPermitOf(first)).toBeUndefined()
    expect(t.state().generation).toBe(COORD_GENERATION)
    t.client.setApiSession(first)
    await t.finish()
    const second = await t.check()
    expect(t.activation.draftSessionPermitOf(second)).toEqual({ userId: first.user.id, generation: t.state().generation })
    expect(t.activation.draftSessionPermitOf(second)?.generation).not.toBe(COORD_GENERATION)
    expect(t.query).toHaveBeenCalledTimes(2)
  })

  it('取消只结束本次等待，不发送查询，也不取消实际停写', async () => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    const controller = new AbortController()
    const reason = new Error('页面已离开')
    const check = expect(t.check(controller.signal)).rejects.toBe(reason)
    await vi.dynamicImportSettled()
    controller.abort(reason)
    await check
    expect(t.query).not.toHaveBeenCalled()
    expect(t.state().phase).toBe('active')
    await t.finish()
    expect(t.state().phase).toBe('suspended')
  })

  it('查询先在途时仍使用原票据；之后的停写不能给旧响应补拍新票据', async () => {
    const t = await sessionCoordinationFixture()
    const answer = deferred<ReturnType<typeof t.response>>()
    t.query.mockReturnValueOnce(answer.promise)
    const check = t.check()
    await vi.dynamicImportSettled()
    expect(t.query).toHaveBeenCalledOnce()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.finish()
    answer.resolve(t.response())
    expect(t.activation.draftSessionPermitOf(await check)).toBeUndefined()
    expect(t.store.beginSessionCheck).toHaveBeenCalledOnce()
    expect(t.state().phase).toBe('suspended')
  })

  it('查询先开始后登记的停写失败，不能重新关联原代次或忘掉持续否决', async () => {
    const t = await sessionCoordinationFixture()
    const answer = deferred<ReturnType<typeof t.response>>()
    t.query.mockReturnValueOnce(answer.promise)
    const checking = t.check()
    await vi.dynamicImportSettled()
    expect(t.query).toHaveBeenCalledOnce()
    t.store.suspendSession.mockRejectedValueOnce(new Error('在途查询期间停写落盘失败'))
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.finish()
    answer.resolve(t.response())
    const confirmed = await checking
    expect.soft(t.activation.draftSessionPermitOf(confirmed)).toBeUndefined()
    expect(t.state()).toMatchObject({ phase: 'active', generation: COORD_GENERATION })
    expect(t.store.beginSessionCheck).toHaveBeenCalledOnce()
    t.client.setApiSession(confirmed)
    t.store.suspendSession.mockRejectedValueOnce(new Error('后续确认期间仍不可写'))
    const again = await t.check()
    expect(t.activation.draftSessionPermitOf(again)).toBeUndefined()
    const fresh = await t.check()
    expect(t.activation.draftSessionPermitOf(fresh)?.generation).not.toBe(COORD_GENERATION)
    expect(t.network.requests).toHaveLength(1)
  })

  it.each(['pending', 'failed'] as const)('查询失败先暂停，下一次查询在途才登记的停用 %s 不能被重新激活吞掉', async (order) => {
    const t = await sessionCoordinationFixture()
    const expired = new t.client.ApiError(401, 'SESSION_EXPIRED', '查询会话过期')
    t.query.mockRejectedValueOnce(expired)
    await expect(t.check()).rejects.toBe(expired)
    const suspended = t.state()
    expect(suspended.phase).toBe('suspended')
    const answer = deferred<ReturnType<typeof t.response>>()
    t.query.mockReturnValueOnce(answer.promise)
    const checking = t.check()
    await vi.dynamicImportSettled()
    expect(t.query).toHaveBeenCalledTimes(2)
    if (order === 'failed')
      t.store.beginUserCleanup.mockRejectedValueOnce(new Error('在途查询期间停用落盘失败'))
    const disabled = new t.client.ApiError(401, 'SESSION_EXPIRED', '确证停用', { details: { reason: 'account_disabled', userId: t.initial.user.id } })
    const stopping = t.tracking.reportRequestSessionFailure(disabled, t.association.associatedSessionPermit(t.initial))
    if (order === 'failed') {
      t.disabled.resolve()
      await stopping
    }
    answer.resolve(t.response())
    const confirmed = await checking
    expect.soft(t.activation.draftSessionPermitOf(confirmed)).toBeUndefined()
    expect.soft(t.state()).toEqual(suspended)
    expect(t.store.beginSessionCheck).toHaveBeenCalledTimes(2)
    t.client.setApiSession(confirmed)
    t.disabled.resolve()
    await stopping
    if (order === 'failed')
      await t.check()
    expect(t.state().phase).toBe('clearing')
    await t.finish()
  })

  it.each(['different-token', 'different-user'] as const)('在途期间才登记旧停用，真实 %s 响应仍按原票取得新来源许可', async (change) => {
    const t = await sessionCoordinationFixture()
    const expired = new t.client.ApiError(401, 'SESSION_EXPIRED', '查询会话过期')
    t.query.mockRejectedValueOnce(expired)
    await expect(t.check()).rejects.toBe(expired)
    const answer = deferred<ReturnType<typeof t.response>>()
    t.query.mockReturnValueOnce(answer.promise)
    const checking = t.check()
    await vi.dynamicImportSettled()
    const disabled = new t.client.ApiError(401, 'SESSION_EXPIRED', '旧来源停用', { details: { reason: 'account_disabled', userId: t.initial.user.id } })
    const stopping = t.tracking.reportRequestSessionFailure(disabled, t.association.associatedSessionPermit(t.initial))
    const next = change === 'different-token' ? t.response('new-login') : { ...t.response(), user: { ...t.initial.user, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }
    answer.resolve(next)
    const fresh = await checking
    const permit = t.activation.draftSessionPermitOf(fresh)
    expect(permit).toEqual({ userId: next.user.id, generation: t.state().generation })
    expect(permit?.generation).not.toBe(COORD_GENERATION)
    expect(t.store.beginSessionCheck).toHaveBeenCalledTimes(2)
    await t.finish()
    await stopping
    expect(t.state()).toMatchObject({ phase: 'active', generation: permit?.generation })
  })

  it('确证停用仍未完成时真实 mutation 新登录不受旧 query 否决约束', async () => {
    const t = await sessionCoordinationFixture()
    const disabled = new t.client.ApiError(401, 'SESSION_EXPIRED', '旧来源停用', { details: { reason: 'account_disabled', userId: t.initial.user.id } })
    const stopping = t.tracking.reportRequestSessionFailure(disabled, t.association.associatedSessionPermit(t.initial))
    const fresh = await t.tracking.requestWithLocalSession('mutation', async () => t.response('new-login'))
    const permit = t.activation.draftSessionPermitOf(fresh)
    expect(permit).toEqual({ userId: fresh.user.id, generation: t.state().generation })
    expect(permit?.generation).not.toBe(COORD_GENERATION)
    t.client.setApiSession(fresh)
    await t.finish()
    await stopping
    expect(t.state()).toMatchObject({ phase: 'active', generation: permit?.generation })
  })

  it.each(['pending', 'late'] as const)('真实新登录不等待旧来源的 %s 失败，旧副作用也不能停止新许可', async (order) => {
    const t = await sessionCoordinationFixture()
    if (order === 'pending') {
      await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
      await t.entered.promise
    }
    const fresh = await t.tracking.requestWithLocalSession('mutation', async () => t.response('new-login'))
    t.client.setApiSession(fresh)
    if (order === 'late') {
      await expect(t.client.apiRequest('/api/test-renew', { method: 'PUT', session: t.initial, schema: z.undefined() })).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
      await t.entered.promise
    }
    const generation = t.activation.draftSessionPermitOf(fresh)?.generation
    t.query.mockImplementation(async () => t.response('new-login'))
    const check = t.check()
    await vi.dynamicImportSettled()
    expect(t.query).toHaveBeenCalledOnce()
    expect(t.activation.draftSessionPermitOf(await check)?.generation).toBe(generation)
    await t.finish()
    expect(t.state().phase).toBe('active')
    expect(t.state().generation).toBe(generation)
  })

  it.each(['pending', 'completed'] as const)('普通失效 %s 时到达的确证停用不被合并丢失', async (order) => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.entered.promise
    if (order === 'completed') {
      t.preserved.resolve()
      await vi.dynamicImportSettled()
      await vi.waitFor(() => expect(t.state().phase).toBe('suspended'))
    }
    const error = new t.client.ApiError(401, 'SESSION_EXPIRED', '确证停用', { details: { reason: 'account_disabled', userId: t.initial.user.id } })
    const stopped = t.tracking.reportRequestSessionFailure(error, t.association.associatedSessionPermit(t.initial))
    const check = t.check()
    t.preserved.resolve()
    await vi.dynamicImportSettled()
    expect(t.query).not.toHaveBeenCalled()
    t.disabled.resolve()
    await stopped
    expect(t.activation.draftSessionPermitOf(await check)).toBeUndefined()
    expect(t.state().phase).toBe('clearing')
    expect(t.query).toHaveBeenCalledOnce()
    await t.finish()
  })

  it('没有已登记失败的初始存储 unavailable 仍执行一次原请求并返回内存模式响应', async () => {
    const t = await sessionCoordinationFixture()
    t.client.setCsrfToken(undefined)
    t.store.beginSessionCheck.mockResolvedValueOnce({ kind: 'unavailable', reason: 'denied' })
    const confirmed = await t.check()
    expect(confirmed).toEqual(t.response())
    expect(t.query).toHaveBeenCalledOnce()
    expect(t.activation.draftSessionPermitOf(confirmed)).toBeUndefined()
  })

  it.each(['pending', 'failed'] as const)('暂停后的同源停用事实 %s，查询不能先重新激活并使原停用失效', async (order) => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    t.preserved.resolve()
    await vi.waitFor(() => expect(t.state().phase).toBe('suspended'))
    if (order === 'failed')
      t.store.beginUserCleanup.mockRejectedValueOnce(new Error('停用落盘失败'))
    const error = new t.client.ApiError(401, 'SESSION_EXPIRED', '确证停用', { details: { reason: 'account_disabled', userId: t.initial.user.id } })
    const stopped = t.tracking.reportRequestSessionFailure(error, t.association.associatedSessionPermit(t.initial))
    if (order === 'failed') {
      t.disabled.resolve()
      await stopped
    }
    const before = t.state().generation
    const confirmed = await t.check()
    expect.soft(t.activation.draftSessionPermitOf(confirmed)).toBeUndefined()
    expect.soft(t.state()).toMatchObject({ phase: 'suspended', generation: before })
    t.client.setApiSession(confirmed)
    t.disabled.resolve()
    await stopped
    if (order === 'failed')
      await t.check()
    expect(t.state().phase).toBe('clearing')
    await t.finish()
  })

  it.each(['signed-out', 'different-token', 'different-user'] as const)('已明确采用 %s，即使没有新本机许可，也不等待退休来源', async (change) => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.entered.promise
    if (change === 'signed-out') {
      t.client.setCsrfToken(undefined)
    }
    else {
      const adopted = change === 'different-token' ? t.response('other-login') : { ...t.response(), user: { ...t.initial.user, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }
      t.client.setApiSession(adopted)
      t.query.mockResolvedValue(adopted)
    }
    const check = t.check()
    await vi.dynamicImportSettled()
    expect.soft(t.query).toHaveBeenCalledOnce()
    await t.finish()
    await check
  })

  it('反复超时和取消释放各自 timer/abort 监听，原失效只完成一次且后续真实确认可恢复', async () => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    await t.entered.promise
    vi.useFakeTimers()
    for (let round = 0; round < 12; round += 1) {
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const reason = new Error(`离开第 ${round} 轮`)
      const cancelled = expect(t.check(controller.signal)).rejects.toBe(reason)
      await vi.waitFor(() => expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true }))
      controller.abort(reason)
      await cancelled
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
      expect(vi.getTimerCount()).toBe(0)
      expect(t.query).toHaveBeenCalledTimes(round)
      const timedOut = t.check()
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      await vi.advanceTimersByTimeAsync(3_000)
      const confirmed = await timedOut
      expect(t.activation.draftSessionPermitOf(confirmed)).toBeUndefined()
      t.client.setApiSession(confirmed)
      expect(vi.getTimerCount()).toBe(0)
      expect(t.query).toHaveBeenCalledTimes(round + 1)
    }
    expect(t.store.suspendSession).not.toHaveBeenCalled()
    await t.finish()
    expect(t.store.suspendSession).toHaveBeenCalledOnce()
    const fresh = await t.check()
    expect(t.activation.draftSessionPermitOf(fresh)).toEqual({ userId: fresh.user.id, generation: t.state().generation })
    expect(t.query).toHaveBeenCalledTimes(13)
    expect(t.network.requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['different-token', 'different-user'] as const)('同源停用仍等待时，真实 %s 的query仍可按原票据取得自己的许可', async (change) => {
    const t = await sessionCoordinationFixture()
    await expect(t.fail()).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    t.preserved.resolve()
    await vi.waitFor(() => expect(t.state().phase).toBe('suspended'))
    const disabled = new t.client.ApiError(401, 'SESSION_EXPIRED', '确证停用', { details: { reason: 'account_disabled', userId: t.initial.user.id } })
    const stopping = t.tracking.reportRequestSessionFailure(disabled, t.association.associatedSessionPermit(t.initial))
    const next = change === 'different-token' ? t.response('new-login') : { ...t.response(), user: { ...t.initial.user, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }
    t.query.mockResolvedValue(next)
    const confirmed = await t.check()
    const permit = t.activation.draftSessionPermitOf(confirmed)
    expect(permit?.userId).toBe(next.user.id)
    expect(permit?.generation).not.toBe(COORD_GENERATION)
    expect(t.state().phase).toBe('active')
    t.disabled.resolve()
    await stopping
    expect(t.state()).toMatchObject({ phase: 'active', generation: permit?.generation })
    await t.finish()
  })

  it.each([
    undefined,
    { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: 'unknown' },
    { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: '00000000-0000-4000-8000-000000000010' },
  ])('未绑定原许可的来源 %# 不借当前人的端口或身份阻塞查询', async (source) => {
    const t = await sessionCoordinationFixture()
    const pending = t.tracking.reportRequestSessionFailure(new t.client.ApiError(401, 'UNAUTHENTICATED', '旧来源失败'), source)
    const checking = t.check()
    await vi.dynamicImportSettled()
    expect(t.query).toHaveBeenCalledOnce()
    const confirmed = await checking
    expect(t.activation.draftSessionPermitOf(confirmed)?.generation).toBe(COORD_GENERATION)
    await t.finish()
    await pending
    expect(t.state()).toMatchObject({ phase: 'active', generation: COORD_GENERATION })
  })
})

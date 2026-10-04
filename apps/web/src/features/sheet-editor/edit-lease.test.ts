import type { AcquiredEditLease, RenewedEditLease, UserSummary } from '@nerve-office/contracts'
import type { EditLeaseApi, EditLeaseOptions, LeaseLoss } from './edit-lease.ts'
import { EDIT_IDLE_SECONDS_MAX, EDIT_LEASE_IDLE_RECLAIM_SECONDS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError } from '../../shared/api/index.ts'
import { acquireEditLease, leaseLossOf, SAME_USER_RETRIES, SAME_USER_RETRY_DELAY_MS, trackActivity, UNKNOWN_OUTCOME_RETRY_DELAY_MS } from './edit-lease.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TOKEN = 'T'.repeat(43)
/** 续上时申请到的下一代 */
const NEXT_TOKEN = 'N'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 3, revision: 5, source: null, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null }
const NEXT: AcquiredEditLease = { ...ACQUIRED, token: NEXT_TOKEN, writeEpoch: 4 }
const RENEWED: RenewedEditLease = { expiresAt: '2026-10-04T03:01:40.000Z' }
const AMY: UserSummary = { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'amy', displayName: '艾米' }

/** 申请被占用：details 是持有者的详情，serverTime 是响应头 Date 的时刻 */
function heldError(details: unknown, serverTime?: number): ApiError {
  return new ApiError(409, 'EDIT_LEASE_HELD', '别人正在编辑这份文档', { details: details as Record<string, unknown>, serverTime })
}

function lostError(reason?: string): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效，本次操作没有生效', { details: reason === undefined ? {} : { reason } })
}

/** 自己在另一个标签页上持有 */
const SELF_HELD = { holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: true }
/** 别人（艾米）持有 */
const AMY_HELD = { holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false }
/** 服务端回收空闲编辑权的阈值（毫秒）：本页的空闲到了它就算人不在 */
const RECLAIM_MS = EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000
/** 可以自动续上的失效原因 */
const RECOVERABLE = ['none', 'replaced', 'released', 'stale', 'expired', 'idle', 'session'] as const
/** 结果未知的失败：服务端可能已经处理了 */
const UNKNOWN_OUTCOMES = [
  ['网络错误', new NetworkError('断网')],
  ['5xx', new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用')],
  ['回包读不出来', new ResponseFormatError('POST /edit-lease 的响应与契约不一致')],
] as const

/** 由测试决定何时完成的 Promise */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/**
 * 租约的测试环境：假的接口与时钟。申请第一次给出 ACQUIRED，之后（续上）给出 NEXT；
 * 本页保存的基准修订号默认等于申请得到的（期间没人保存过），可以改
 */
function setup(api: Partial<EditLeaseApi> = {}) {
  const time = fakeLeaseClock()
  let lastActivity = time.now()
  let baseRevision = ACQUIRED.revision
  const calls: string[] = []
  const acquire = vi.fn<EditLeaseApi['acquire']>(api.acquire ?? (async () => NEXT))
  if (api.acquire === undefined)
    acquire.mockResolvedValueOnce(ACQUIRED)
  const fakeApi = {
    acquire,
    renew: vi.fn<EditLeaseApi['renew']>(api.renew ?? (async () => RENEWED)),
    release: vi.fn<EditLeaseApi['release']>(api.release ?? (async (_documentId, token) => {
      calls.push(`release ${token.slice(0, 1)}`)
    })),
  }
  const onLost = vi.fn<(loss: LeaseLoss) => void>()
  const onSessionProblem = vi.fn<(error: ApiError) => void>()
  /** 页面认不认得出期间的那一版是自己的保存：默认认不出（别处保存的） */
  const adopt = vi.fn<EditLeaseOptions['adoptOwnRevision']>(() => false)
  const options: EditLeaseOptions = {
    documentId: DOCUMENT_ID,
    clientInstanceId: PAGE_ID,
    api: fakeApi,
    clock: time.clock,
    lastActivity: () => lastActivity,
    baseRevision: () => baseRevision,
    adoptOwnRevision: adopt,
    onLost,
    onSessionProblem,
  }
  return {
    time,
    api: fakeApi,
    onLost,
    onSessionProblem,
    adopt,
    options,
    calls,
    /** 本页有一次键盘、鼠标操作：默认在现在，可以给出更早的时刻 */
    interact: (at = time.now()) => {
      lastActivity = at
    },
    /** 本页保存之后，基准修订号变了 */
    saved: (revision: number) => {
      baseRevision = revision
    },
  }
}

/** 申请并取得：返回租约 */
async function held(context: ReturnType<typeof setup>) {
  const result = await acquireEditLease(context.options)
  if (result.kind !== 'acquired')
    throw new Error('没有取得编辑权')
  return result.lease
}

describe('申请（M3-P1 设计 §3.4.7）', () => {
  it('持有：给出令牌、代次与文档当前的修订号，以本页这次加载的标识申请；10 秒之后第一次续租', async () => {
    const context = setup()
    const result = await acquireEditLease(context.options)
    expect(result).toMatchObject({ kind: 'acquired', revision: 5 })
    if (result.kind === 'acquired')
      expect(result.lease.credentials()).toEqual({ token: TOKEN, writeEpoch: 3 })
    expect(context.api.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID)
    await context.time.advance(9_999)
    expect(context.api.renew).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.api.renew).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, 10)
  })

  it('被占用（别人）：给出持有者、不是自己，以及按服务端的时间算的最后活动几分钟之前（向下取整）；不再试', async () => {
    const serverTime = Date.UTC(2026, 9, 4, 3, 10, 0)
    const context = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: AMY, lastActiveAt: '2026-10-04T03:06:30.000Z', sameUser: false }, serverTime))) })
    expect(await acquireEditLease(context.options)).toEqual({ kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } })
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('最后活动时间晚于服务端回答的时刻（Date 只精确到秒）：算作 0 分钟；服务端没给回答的时刻：不算几分钟之前', async () => {
    const serverTime = Date.UTC(2026, 9, 4, 3, 0, 0)
    const later = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: AMY, lastActiveAt: '2026-10-04T03:00:00.800Z', sameUser: false }, serverTime))) })
    expect(await acquireEditLease(later.options)).toMatchObject({ kind: 'held', holder: { lastActiveMinutes: 0 } })
    const undated = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false }))) })
    expect(await acquireEditLease(undated.options)).toMatchObject({ kind: 'held', holder: { lastActiveMinutes: undefined } })
  })

  it('被占用而且是自己（刷新时旧页面的释放晚到，P1 设计 §7）：隔 500 毫秒再试，旧页面的释放到了就取得', async () => {
    const acquire = vi.fn<EditLeaseApi['acquire']>()
      .mockRejectedValueOnce(heldError(SELF_HELD))
      .mockRejectedValueOnce(heldError(SELF_HELD))
      .mockResolvedValueOnce(ACQUIRED)
    const context = setup({ acquire })
    const acquiring = acquireEditLease(context.options)
    await context.time.advance(SAME_USER_RETRY_DELAY_MS - 1)
    expect(acquire).toHaveBeenCalledTimes(1)
    await context.time.advance(1)
    expect(acquire).toHaveBeenCalledTimes(2)
    await context.time.advance(SAME_USER_RETRY_DELAY_MS)
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(await acquiring).toMatchObject({ kind: 'acquired', revision: 5 })
  })

  it('被占用而且是自己、一直被占用：再试 3 次之后按被占用返回', async () => {
    const acquire = vi.fn(async () => Promise.reject(heldError(SELF_HELD)))
    const context = setup({ acquire })
    const acquiring = acquireEditLease(context.options)
    await context.time.advance(SAME_USER_RETRIES * SAME_USER_RETRY_DELAY_MS)
    expect(await acquiring).toMatchObject({ kind: 'held', holder: { holder: AMY, sameUser: true } })
    expect(acquire).toHaveBeenCalledTimes(SAME_USER_RETRIES + 1)
  })

  it('服务端给的详情认不出：按被占用返回，持有者为 undefined（页头按通用的说法），不再试', async () => {
    const context = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: 'amy' }))) })
    expect(await acquireEditLease(context.options)).toEqual({ kind: 'held', holder: undefined })
    expect(context.api.acquire).toHaveBeenCalledOnce()
  })

  it.each([
    ['403（刚失去编辑权）', new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能编辑')],
    ['404', new ApiError(404, 'NOT_FOUND', '不存在')],
    ['未登录', new ApiError(401, 'SESSION_EXPIRED', '已过期')],
    ['请求不合法（400）', new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法')],
  ])('确定的失败原样抛出（%s），由页面处理，不再试', async (_case, error) => {
    const context = setup({ acquire: vi.fn(async () => Promise.reject(error)) })
    await expect(acquireEditLease(context.options)).rejects.toBe(error)
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it.each(UNKNOWN_OUTCOMES)('结果未知（%s，服务端可能已经批给了本页）：隔 500 毫秒用同一个标识再试一次——同一个页面再申请是重试，取得就照常持有（审查 B7）', async (_case, error) => {
    const acquire = vi.fn<EditLeaseApi['acquire']>().mockRejectedValueOnce(error).mockResolvedValueOnce(ACQUIRED)
    const context = setup({ acquire })
    const acquiring = acquireEditLease(context.options)
    await context.time.advance(UNKNOWN_OUTCOME_RETRY_DELAY_MS - 1)
    expect(acquire).toHaveBeenCalledOnce()
    await context.time.advance(1)
    expect(await acquiring).toMatchObject({ kind: 'acquired', revision: 5 })
    expect(acquire.mock.calls).toEqual([[DOCUMENT_ID, PAGE_ID], [DOCUMENT_ID, PAGE_ID]])
  })

  it.each(UNKNOWN_OUTCOMES)('结果未知（%s）、再试仍然未知：只再试一次，抛出后一次的错误，由页面处理', async (_case, error) => {
    const again = new NetworkError('还是断网')
    const acquire = vi.fn<EditLeaseApi['acquire']>().mockRejectedValueOnce(error).mockRejectedValueOnce(again)
    const context = setup({ acquire })
    const failed = expect(acquireEditLease(context.options)).rejects.toBe(again)
    await context.time.advance(60_000)
    await failed
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(context.time.pending()).toBe(0)
  })
})

describe('心跳续租', () => {
  it('每 10 秒一次，带上距离最后一次键盘、鼠标操作的整秒数（单调的时钟，向下取整）', async () => {
    const context = setup()
    await held(context)
    await context.time.advance(2_500)
    context.interact()
    await context.time.advance(7_500)
    // 第一次：最后一次操作在 7.5 秒之前
    expect(context.api.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 7)
    await context.time.advance(10_000)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
    expect(context.api.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 17)
  })

  it('空闲的秒数不超过契约的上限（EDIT_IDLE_SECONDS_MAX）', async () => {
    const context = setup()
    await held(context)
    // 最后一次操作远在一天多之前（例如页面一直开着）：按上限报
    context.interact(context.time.now() - (EDIT_IDLE_SECONDS_MAX + 100) * 1000)
    await context.time.advance(10_000)
    expect(context.api.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, EDIT_IDLE_SECONDS_MAX)
  })

  it('同时只有一个在途：慢的那一个回来之后按它发出的时刻排下一个；超过了 10 秒就立即续下一个', async () => {
    const replies: ReturnType<typeof deferred<RenewedEditLease>>[] = []
    const renew = vi.fn(async () => {
      const reply = deferred<RenewedEditLease>()
      replies.push(reply)
      return reply.promise
    })
    const context = setup({ renew })
    await held(context)
    await context.time.advance(10_000)
    expect(renew).toHaveBeenCalledTimes(1)
    // 第一次 3 秒之后才回来：下一次仍在发出之后的第 10 秒
    await context.time.advance(3_000)
    replies[0]?.resolve(RENEWED)
    await context.time.advance(6_999)
    expect(renew).toHaveBeenCalledTimes(1)
    await context.time.advance(1)
    expect(renew).toHaveBeenCalledTimes(2)
    // 第二次 12 秒之后才回来：期间不发第三次，回来时立即发
    await context.time.advance(12_000)
    expect(renew).toHaveBeenCalledTimes(2)
    replies[1]?.resolve(RENEWED)
    await context.time.advance(0)
    expect(renew).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['网络错误', new NetworkError('断网')],
    ['5xx', new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙')],
    ['回包读不出来', new ResponseFormatError('不一致')],
  ])('%s：结果未知，下一次照常重试（到期由服务端判断），不算失效', async (_case, error) => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(error).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    await held(context)
    await context.time.advance(20_000)
    expect(renew).toHaveBeenCalledTimes(2)
    expect(context.onLost).not.toHaveBeenCalled()
    expect(context.onSessionProblem).not.toHaveBeenCalled()
  })
})

describe('失效：失去访问或编辑权，或者不认识的原因', () => {
  const denied = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
  const gone = new ApiError(404, 'NOT_FOUND', '请求的资源不存在或无权访问')
  it.each([
    ['EDIT_LEASE_LOST（编辑权被收回）', lostError('revoked'), { kind: 'lease', reason: 'revoked' }],
    ['EDIT_LEASE_LOST（不认识的原因）', lostError('handed-over'), { kind: 'lease', reason: undefined }],
    ['EDIT_LEASE_LOST（没有原因）', lostError(), { kind: 'lease', reason: undefined }],
    ['403（能读不能编辑了）', denied, { kind: 'denied', error: denied }],
    ['404（读不到了）', gone, { kind: 'not-found', error: gone }],
  ])('续租得到%s：不续上，通知页面一次，停止续租', async (_case, error, loss) => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(error)) })
    await held(context)
    await context.time.advance(10_000)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith(loss)
    expect(context.api.acquire).toHaveBeenCalledOnce()
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('保存得知失去访问（404）：与续租同一个处理，结果是失效；只通知一次，之后恢复、释放都不再做事', async () => {
    const context = setup()
    const lease = await held(context)
    const gone = new ApiError(404, 'NOT_FOUND', '不存在')
    expect(await lease.lose({ kind: 'not-found', error: gone }, lease.credentials())).toEqual({ kind: 'lost' })
    expect(await lease.lose({ kind: 'lease', reason: 'revoked' }, lease.credentials())).toEqual({ kind: 'lost' })
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'not-found', error: gone })
    await lease.resume()
    void lease.release()
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    expect(context.api.release).not.toHaveBeenCalled()
  })

  it('续租得到 400（请求不合法）：不算失效，不通知页面，下一次照常续租（审查 B5）', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    await context.time.advance(20_000)
    expect(renew).toHaveBeenCalledTimes(2)
    expect(context.onLost).not.toHaveBeenCalled()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(lease.credentials().token).toBe(TOKEN)
  })

  it('续租在途时得知失效：回来的结果不再排下一次', async () => {
    const reply = deferred<RenewedEditLease>()
    const context = setup({ renew: vi.fn(async () => reply.promise) })
    const lease = await held(context)
    await context.time.advance(10_000)
    await lease.lose({ kind: 'lease', reason: 'revoked' }, lease.credentials())
    reply.resolve(RENEWED)
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('leaseLossOf：只认编辑权失效、404 与 403；别的失败（400 请求不合法、未登录、CSRF 失效的 403、修订号冲突、网络错误）不算（审查 B5）', () => {
    expect(leaseLossOf(lostError('idle'))).toEqual({ kind: 'lease', reason: 'idle' })
    expect(leaseLossOf(new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法'))).toBeUndefined()
    expect(leaseLossOf(new ApiError(401, 'SESSION_EXPIRED', '已过期'))).toBeUndefined()
    expect(leaseLossOf(new ApiError(403, 'CSRF_TOKEN_INVALID', 'x'))).toBeUndefined()
    expect(leaseLossOf(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', 'x'))).toBeUndefined()
    expect(leaseLossOf(new NetworkError('断网'))).toBeUndefined()
  })
})

describe('续上：编辑权中断而不是失去访问或编辑权，自动重新申请一次', () => {
  it.each(['none', 'replaced', 'released', 'stale', 'expired', 'session'])('续租得到 %s：先放掉手里那一代，再申请；修订号就是本页保存的基准 → 换上新的一代接着心跳，不通知页面', async (reason) => {
    const context = setup()
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError(reason)).mockResolvedValue(RENEWED)
    Object.assign(context.api, { renew })
    const lease = await held(context)
    context.api.acquire.mockImplementationOnce(async () => {
      context.calls.push('acquire')
      return NEXT
    })
    await context.time.advance(10_000)
    expect(context.calls).toEqual(['release T', 'acquire'])
    expect(context.api.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, PAGE_ID)
    expect(lease.credentials()).toEqual({ token: NEXT_TOKEN, writeEpoch: 4 })
    expect(context.onLost).not.toHaveBeenCalled()
    // 修订号没变：不用问页面期间的那一版是谁的
    expect(context.adopt).not.toHaveBeenCalled()
    await context.time.advance(10_000)
    expect(renew).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN, expect.any(Number))
  })

  it('修订号变了（期间别处保存过）：不覆盖——放掉刚申请到的，按失效处理（newer）', async () => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('expired'))) })
    const lease = await held(context)
    const source = { clientInstanceId: '0199a2c4-1f2e-4a3b-8c4d-00000000bbbb', localSeq: 3 }
    context.api.acquire.mockResolvedValueOnce({ ...NEXT, revision: 6, source })
    await context.time.advance(10_000)
    expect(context.adopt).toHaveBeenCalledExactlyOnceWith(6, source)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'newer' })
    expect(context.api.release).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN)
    expect(lease.credentials().token).toBe(TOKEN)
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('修订号变了、期间的那一版是本页自己一次结果未知的保存（页面认出、按它确认）：以它为基准接着编辑——换上新的一代，不通知页面（审查 B1）', async () => {
    const context = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED) })
    const lease = await held(context)
    const source = { clientInstanceId: PAGE_ID, localSeq: 2 }
    context.api.acquire.mockResolvedValueOnce({ ...NEXT, revision: 6, source })
    context.adopt.mockReturnValueOnce(true)
    await context.time.advance(10_000)
    expect(context.adopt).toHaveBeenCalledExactlyOnceWith(6, source)
    expect(lease.credentials()).toEqual({ token: NEXT_TOKEN, writeEpoch: 4 })
    expect(context.onLost).not.toHaveBeenCalled()
    expect(context.api.release).not.toHaveBeenCalledWith(DOCUMENT_ID, NEXT_TOKEN)
    await context.time.advance(10_000)
    expect(context.api.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN, expect.any(Number))
  })

  it('本页保存过、基准跟着往前走：申请得到的修订号等于新的基准就续上', async () => {
    const context = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED) })
    const lease = await held(context)
    context.saved(6)
    context.api.acquire.mockResolvedValueOnce({ ...NEXT, revision: 6 })
    await context.time.advance(10_000)
    expect(context.onLost).not.toHaveBeenCalled()
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
  })

  it.each([
    ['别人', AMY_HELD, { holder: AMY, sameUser: false }],
    ['自己在别处', SELF_HELD, { holder: AMY, sameUser: true }],
  ])('续上时被占用（%s）：按失效处理，说明谁在编辑；不再试', async (_case, details, holder) => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('replaced'))) })
    await held(context)
    context.api.acquire.mockRejectedValue(heldError(details))
    await context.time.advance(10_000)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'held', holder: expect.objectContaining(holder) as unknown })
    await context.time.advance(60_000)
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['403', new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能编辑'), 'denied'],
    ['404', new ApiError(404, 'NOT_FOUND', '不存在'), 'not-found'],
  ])('续上时 %s：按失去编辑权、失去访问处理', async (_case, error, kind) => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('stale'))) })
    await held(context)
    context.api.acquire.mockRejectedValueOnce(error)
    await context.time.advance(10_000)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind, error })
  })

  it('续上时网络错误：保持现状（仍按手里那一代），下一次心跳再判断，那时续上', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>(async () => Promise.reject(lostError('expired')))
    const context = setup({ renew })
    const lease = await held(context)
    context.api.acquire.mockRejectedValueOnce(new NetworkError('断网'))
    await context.time.advance(10_000)
    expect(context.onLost).not.toHaveBeenCalled()
    expect(lease.credentials().token).toBe(TOKEN)
    renew.mockResolvedValue(RENEWED)
    renew.mockRejectedValueOnce(lostError('released'))
    await context.time.advance(10_000)
    expect(context.api.acquire).toHaveBeenCalledTimes(3)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it('续上时未登录：交给页面确认会话，暂停；确认是本人之后恢复，再次得知失效时续上', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>(async () => Promise.reject(lostError('session')))
    const context = setup({ renew })
    const lease = await held(context)
    const unauthenticated = new ApiError(401, 'SESSION_EXPIRED', '已过期')
    context.api.acquire.mockRejectedValueOnce(unauthenticated)
    await context.time.advance(10_000)
    expect(context.onSessionProblem).toHaveBeenCalledExactlyOnceWith(unauthenticated)
    await context.time.advance(60_000)
    expect(renew).toHaveBeenCalledOnce()
    renew.mockRejectedValueOnce(lostError('session'))
    await lease.resume()
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it('每一代只续上一次：续上之后，带着上一代令牌的在途请求回来得知失效，不再申请，那个请求可以用新的一代重发', async () => {
    const context = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED) })
    const lease = await held(context)
    const old = lease.credentials()
    await context.time.advance(10_000)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    expect(await lease.lose({ kind: 'lease', reason: 'replaced' }, old)).toEqual({ kind: 'held' })
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it('续上得到的一代再失效：那是新的一次失效，照样续上一次', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('stale')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    await context.time.advance(10_000)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    context.api.acquire.mockResolvedValueOnce({ ...NEXT, token: 'Z'.repeat(43), writeEpoch: 5 })
    renew.mockRejectedValueOnce(lostError('stale'))
    await context.time.advance(10_000)
    expect(lease.credentials()).toEqual({ token: 'Z'.repeat(43), writeEpoch: 5 })
    expect(context.api.acquire).toHaveBeenCalledTimes(3)
  })

  it('保存得知可以续上的失效：续上之后结果是仍持有，用新的一代重发；续租与保存同时得知时只申请一次', async () => {
    const renewReply = deferred<RenewedEditLease>()
    const context = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockReturnValueOnce(renewReply.promise).mockResolvedValue(RENEWED) })
    const lease = await held(context)
    await context.time.advance(10_000)
    const old = lease.credentials()
    const saving = lease.lose({ kind: 'lease', reason: 'session' }, old)
    renewReply.reject(lostError('session'))
    expect(await saving).toEqual({ kind: 'held' })
    await settle()
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
  })

  it('保存得知可以续上的失效、续上时网络错误：结果是说不准，带着那次的错误（保存按它说明）', async () => {
    const context = setup()
    const lease = await held(context)
    const offline = new NetworkError('断网')
    context.api.acquire.mockRejectedValueOnce(offline)
    expect(await lease.lose({ kind: 'lease', reason: 'expired' }, lease.credentials())).toEqual({ kind: 'unknown', error: offline })
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it.each(RECOVERABLE)('得到 %s、人不在（本页的空闲已经到了服务端回收空闲编辑权的阈值）：不续上，也不再续租；本页再有操作时续上（审查 B8）', async (reason) => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError(reason)).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    // 最后一次操作在 12 分钟之前（人走开之后断网、休眠回来，服务端给的原因可能是到期而不是空闲）
    context.interact(context.time.now() - RECLAIM_MS)
    await context.time.advance(10_000)
    await context.time.advance(600_000)
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(renew).toHaveBeenCalledOnce()
    expect(context.onLost).not.toHaveBeenCalled()
    context.interact()
    lease.noteActivity()
    await settle()
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    await context.time.advance(10_000)
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it('人在不在以服务端的回收阈值为界：空闲差 1 毫秒到阈值时立即续上，到了阈值就等本页再有操作', async () => {
    const present = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED) })
    const recovered = await held(present)
    present.interact(present.time.now() + 10_000 - RECLAIM_MS + 1)
    await present.time.advance(10_000)
    expect(recovered.credentials().token).toBe(NEXT_TOKEN)

    const absent = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED) })
    const dormant = await held(absent)
    absent.interact(absent.time.now() + 10_000 - RECLAIM_MS)
    await absent.time.advance(10_000)
    expect(dormant.credentials().token).toBe(TOKEN)
    expect(absent.api.acquire).toHaveBeenCalledOnce()
  })

  it('人不在时保存得知可以续上的失效（例如断网很久之后重试的保存）：结果是说不准、不带错误（保存按原来的失败说明），等本页再有操作', async () => {
    const context = setup()
    const lease = await held(context)
    context.interact(context.time.now() - RECLAIM_MS)
    expect(await lease.lose({ kind: 'lease', reason: 'expired' }, lease.credentials())).toEqual({ kind: 'unknown', error: undefined })
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.api.release).not.toHaveBeenCalled()
    expect(context.time.pending()).toBe(0)
  })

  it('人不在、等着本页再有操作时会话不是本人了：暂停，之后的操作不续上；回到本人、恢复续租得知失效时续上（审查 B6）', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('idle')).mockRejectedValueOnce(lostError('session')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    context.interact(context.time.now() - RECLAIM_MS)
    await context.time.advance(10_000)
    lease.pause()
    context.interact()
    lease.noteActivity()
    await settle()
    expect(context.api.release).not.toHaveBeenCalled()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    await lease.resume()
    expect(renew).toHaveBeenCalledTimes(2)
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
  })

  it('因为空闲被回收、而人刚有过操作（例如按下保存）：立即续上', async () => {
    const context = setup()
    const lease = await held(context)
    context.interact()
    expect(await lease.lose({ kind: 'lease', reason: 'idle' }, lease.credentials())).toEqual({ kind: 'held' })
  })

  it('会话不是本人时不续：暂停期间得知的失效不申请；回到本人、恢复续租再次得知失效时续上', async () => {
    const reply = deferred<RenewedEditLease>()
    const renew = vi.fn<EditLeaseApi['renew']>().mockReturnValueOnce(reply.promise).mockRejectedValueOnce(lostError('session')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    await context.time.advance(10_000)
    lease.pause()
    reply.reject(lostError('session'))
    await settle()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.onLost).not.toHaveBeenCalled()
    await lease.resume()
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
  })

  it.each([
    ['网络错误', new NetworkError('断网')],
    ['5xx', new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用')],
  ])('续上时放掉手里那一代的结果未知（%s）：不申请（手里那一代可能还占着，申请会被自己占住），保持现状，下一次心跳再试（审查 B9）', async (_case, error) => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('session')).mockRejectedValueOnce(lostError('session')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    context.api.release.mockRejectedValueOnce(error)
    await context.time.advance(10_000)
    expect(context.api.release).toHaveBeenCalledOnce()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(lease.credentials().token).toBe(TOKEN)
    expect(context.onLost).not.toHaveBeenCalled()
    // 下一次心跳：仍带着手里那一代，得知失效，再续上——这一次放掉了，随即申请
    await context.time.advance(10_000)
    expect(renew).toHaveBeenNthCalledWith(2, DOCUMENT_ID, TOKEN, expect.any(Number))
    expect(context.calls).toEqual(['release T'])
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it('保存得知可以续上的失效、放掉手里那一代的结果未知：结果是说不准，带着那次的错误（保存按它说明），不申请', async () => {
    const context = setup()
    const lease = await held(context)
    const offline = new NetworkError('断网')
    context.api.release.mockRejectedValueOnce(offline)
    expect(await lease.lose({ kind: 'lease', reason: 'session' }, lease.credentials())).toEqual({ kind: 'unknown', error: offline })
    expect(context.api.acquire).toHaveBeenCalledOnce()
  })

  it('续上时放掉手里那一代被拒（确定的回答，例如读不到了）：照常申请，由申请给出结果', async () => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('stale'))) })
    await held(context)
    const gone = new ApiError(404, 'NOT_FOUND', '不存在')
    context.api.release.mockRejectedValueOnce(gone)
    context.api.acquire.mockRejectedValueOnce(gone)
    await context.time.advance(10_000)
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'not-found', error: gone })
  })

  it('放掉手里那一代期间页面释放了（关闭）：不再申请（审查 B7）', async () => {
    const releasing = deferred<void>()
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('expired'))) })
    const lease = await held(context)
    context.api.release.mockReturnValueOnce(releasing.promise)
    await context.time.advance(10_000)
    expect(context.api.release).toHaveBeenCalledOnce()
    void lease.release()
    releasing.resolve()
    await settle()
    expect(context.api.acquire).toHaveBeenCalledOnce()
  })

  it('放掉手里那一代期间得知失去访问（保存得到 404）：失效，不再申请', async () => {
    const releasing = deferred<void>()
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('expired'))) })
    const lease = await held(context)
    context.api.release.mockReturnValueOnce(releasing.promise)
    await context.time.advance(10_000)
    const gone = new ApiError(404, 'NOT_FOUND', '不存在')
    expect(await lease.lose({ kind: 'not-found', error: gone }, lease.credentials())).toEqual({ kind: 'lost' })
    releasing.resolve()
    await settle()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'not-found', error: gone })
  })

  it('续上时页面释放了（关闭）：刚申请到的随即放掉', async () => {
    const acquiring = deferred<AcquiredEditLease>()
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('expired'))) })
    const lease = await held(context)
    context.api.acquire.mockReturnValueOnce(acquiring.promise)
    await context.time.advance(10_000)
    void lease.release()
    acquiring.resolve(NEXT)
    await settle()
    expect(context.api.release).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN)
  })
})

describe('会话：暂停与恢复', () => {
  it.each([
    ['未登录', new ApiError(401, 'SESSION_EXPIRED', '已过期')],
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')],
  ])('续租得到%s：交给页面确认会话，确认之前不再续租', async (_case, error) => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(error)) })
    await held(context)
    await context.time.advance(10_000)
    expect(context.onSessionProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(context.onLost).not.toHaveBeenCalled()
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('暂停时不续租；恢复时立即续租一次（登录可能换过），之后照常每 10 秒', async () => {
    const context = setup()
    const lease = await held(context)
    lease.pause()
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    await lease.resume()
    expect(context.api.renew).toHaveBeenCalledOnce()
    await context.time.advance(10_000)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
  })

  it('恢复时得知租约随登录失效（session）：resume 在续上有了结果之后兑现，不通知页面', async () => {
    const context = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('session')).mockResolvedValue(RENEWED) })
    const lease = await held(context)
    lease.pause()
    await lease.resume()
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it('恢复时已有一个续租在途：它回来之后再续一次，resume 在那一次有了结果之后兑现；之前那个回来的"未登录"已经过时，不再暂停', async () => {
    const first = deferred<RenewedEditLease>()
    const renew = vi.fn<EditLeaseApi['renew']>().mockReturnValueOnce(first.promise).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    await context.time.advance(10_000)
    expect(renew).toHaveBeenCalledOnce()
    let resumed = false
    const resuming = lease.resume().then(() => {
      resumed = true
    })
    await settle()
    expect(resumed).toBe(false)
    first.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期'))
    await resuming
    expect(renew).toHaveBeenCalledTimes(2)
    expect(context.onSessionProblem).not.toHaveBeenCalled()
    await context.time.advance(10_000)
    expect(renew).toHaveBeenCalledTimes(3)
  })

  it('暂停之前发出的续租回来得知编辑权被收回：照样通知页面（服务端的回答说的是本页的租约）', async () => {
    const reply = deferred<RenewedEditLease>()
    const context = setup({ renew: vi.fn(async () => reply.promise) })
    const lease = await held(context)
    await context.time.advance(10_000)
    lease.pause()
    reply.reject(lostError('revoked'))
    await settle()
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'lease', reason: 'revoked' })
  })
})

describe('释放', () => {
  it('经接口尽力释放（keepalive 在 editor-api.ts）一次，停止续租；再释放不再发', async () => {
    const context = setup()
    const lease = await held(context)
    void lease.release()
    void lease.release()
    expect(context.api.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    await lease.resume()
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('页面关闭时的释放没送到（断网）：不看结果，失败由租约自己接住（没人接时测试进程报 Unhandled Rejection）', async () => {
    const context = setup()
    const lease = await held(context)
    // 不经 vi.fn：vi.fn 记录结果时会接住它返回的 Promise，测不出没人接
    let releases = 0
    Object.assign(context.api, {
      release: async (): Promise<void> => {
        releases += 1
        return Promise.reject(new NetworkError('断网'))
      },
    })
    void lease.release()
    await settle()
    await settle()
    expect(releases).toBe(1)
  })

  it('退出编辑时等释放有了结果（M3-P2 设计 §3.4）：请求回来之前不兑现；成功兑现为服务端确认了（true），失败（结果未知）兑现为没确认（false），从不失败；再释放交回同一个结果（审查 A13）', async () => {
    const context = setup()
    const lease = await held(context)
    let answer: (() => void) | undefined
    context.api.release.mockImplementationOnce(async () => new Promise<void>((resolve) => {
      answer = resolve
    }))
    let confirmed: boolean | undefined
    const releasing = lease.release().then((result) => {
      confirmed = result
    })
    await settle()
    expect(confirmed).toBeUndefined()
    answer?.()
    await releasing
    expect(confirmed).toBe(true)
    await expect(lease.release()).resolves.toBe(true)

    const failing = setup()
    const other = await held(failing)
    failing.api.release.mockRejectedValueOnce(new NetworkError('断网'))
    await expect(other.release()).resolves.toBe(false)
    await expect(other.release()).resolves.toBe(false)
    expect(failing.api.release).toHaveBeenCalledOnce()
  })

  it('暂停时（会话不是本人）不发：带的会是别人的或已经失效的登录；那一代还在，兑现为没确认', async () => {
    const context = setup()
    const lease = await held(context)
    lease.pause()
    await expect(lease.release()).resolves.toBe(false)
    expect(context.api.release).not.toHaveBeenCalled()
  })

  it('已经失效：什么也不发，兑现为确认了（本页没有还在的那一代）', async () => {
    const context = setup()
    const lease = await held(context)
    context.api.renew.mockRejectedValueOnce(lostError('revoked'))
    await context.time.advance(10_000)
    expect(context.onLost).toHaveBeenCalledOnce()
    await expect(lease.release()).resolves.toBe(true)
    expect(context.api.release).not.toHaveBeenCalled()
  })
})

describe('trackActivity：在捕获阶段记下键盘、鼠标操作', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('键盘、指针（含移动）与滚轮都记下；后挂的监听阻止传递也照样记下；撤销之后不再记', () => {
    const onActivity = vi.fn()
    const stop = trackActivity(window, onActivity)
    // 交互屏障一类后挂在窗口捕获阶段、阻止传递的监听
    const block = (event: Event): void => event.stopImmediatePropagation()
    window.addEventListener('keydown', block, { capture: true })
    const inner = document.createElement('div')
    document.body.append(inner)
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel'])
      inner.dispatchEvent(new Event(type, { bubbles: true }))
    expect(onActivity).toHaveBeenCalledTimes(4)
    inner.dispatchEvent(new Event('focus'))
    expect(onActivity).toHaveBeenCalledTimes(4)
    stop()
    inner.dispatchEvent(new Event('keydown', { bubbles: true }))
    expect(onActivity).toHaveBeenCalledTimes(4)
    window.removeEventListener('keydown', block, { capture: true })
  })
})

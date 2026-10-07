import type { AcquiredEditLease, RenewedEditLease, UserSummary } from '@nerve-office/contracts'
import type { Incompatibility } from './client-format.ts'
import type { EditLeaseApi, EditLeaseOptions, LeaseLoss } from './edit-lease.ts'
import { EDIT_IDLE_SECONDS_MAX, EDIT_LEASE_IDLE_RECLAIM_SECONDS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError } from '../../shared/api/index.ts'
import { acquireEditLease, browserLeaseClock, leaseLossOf, SAME_USER_RETRIES, SAME_USER_RETRY_DELAY_MS, trackActivity, UNKNOWN_OUTCOME_RETRY_DELAY_MS } from './edit-lease.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TOKEN = 'T'.repeat(43)
/** 续上时申请到的下一代 */
const NEXT_TOKEN = 'N'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 3, revision: 5, source: null, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null, formulasPending: false }
const NEXT: AcquiredEditLease = { ...ACQUIRED, token: NEXT_TOKEN, writeEpoch: 4 }
const RENEWED: RenewedEditLease = { expiresAt: '2026-10-04T03:01:40.000Z', request: null }
const AMY: UserSummary = { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'amy', displayName: '艾米' }

/** 申请被占用：details 是持有者的详情，serverTime 是响应头 Date 的时刻 */
function heldError(details: unknown, serverTime?: number): ApiError {
  return new ApiError(409, 'EDIT_LEASE_HELD', '别人正在编辑这份文档', { details: details as Record<string, unknown>, serverTime })
}

function lostError(reason?: string): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效，本次操作没有生效', { details: reason === undefined ? {} : { reason } })
}

/** 被接管（taken_over，M3-P5）：forced 区分本人在别处接手与强制接管；传入别的值时模拟认不出 */
function takenOverError(forced: unknown): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效，本次操作没有生效', { details: { reason: 'taken_over', forced } })
}

/** 自己在另一个标签页上持有 */
const SELF_HELD = { holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: true, sameSession: false, canTakeOver: false, request: null }
/** 别人（艾米）持有 */
const AMY_HELD = { holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false, sameSession: false, canTakeOver: false, request: null }
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
    handOver: vi.fn<EditLeaseApi['handOver']>(api.handOver ?? (async () => ({ reservedFor: AMY, reservedUntil: '2026-10-04T03:03:00.000Z' }))),
    decline: vi.fn<EditLeaseApi['decline']>(api.decline ?? (async () => {})),
  }
  const onLost = vi.fn<(loss: LeaseLoss) => void>()
  const onSessionProblem = vi.fn<(error: ApiError) => void>()
  const onIncompatible = vi.fn<(kind: Incompatibility) => void>()
  const onRequest = vi.fn<NonNullable<EditLeaseOptions['onRequest']>>()
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
    onIncompatible,
    onRequest,
  }
  return {
    time,
    api: fakeApi,
    onLost,
    onSessionProblem,
    onIncompatible,
    onRequest,
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
  it('文档带着"公式待更新"（M3-P4 设计 §3.5）：申请的结果交回它（进入编辑时强制重算、收齐之后补存）', async () => {
    const context = setup({ acquire: async () => ({ ...ACQUIRED, formulasPending: true }) })
    expect(await acquireEditLease(context.options)).toMatchObject({ kind: 'acquired', revision: 5, formulasPending: true })
  })

  it('持有：给出令牌、代次、文档当前的修订号与"公式待更新"（M3-P4），以本页这次加载的标识申请；10 秒之后第一次续租', async () => {
    const context = setup()
    const result = await acquireEditLease(context.options)
    expect(result).toMatchObject({ kind: 'acquired', revision: 5, formulasPending: false })
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
    const context = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: AMY, lastActiveAt: '2026-10-04T03:06:30.000Z', sameUser: false, sameSession: false, canTakeOver: false, request: null }, serverTime))) })
    expect(await acquireEditLease(context.options)).toEqual({ kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } })
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('最后活动时间晚于服务端回答的时刻（Date 只精确到秒）：算作 0 分钟；服务端没给回答的时刻：不算几分钟之前', async () => {
    const serverTime = Date.UTC(2026, 9, 4, 3, 0, 0)
    const later = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: AMY, lastActiveAt: '2026-10-04T03:00:00.800Z', sameUser: false, sameSession: false, canTakeOver: false, request: null }, serverTime))) })
    expect(await acquireEditLease(later.options)).toMatchObject({ kind: 'held', holder: { lastActiveMinutes: 0 } })
    const undated = setup({ acquire: vi.fn(async () => Promise.reject(heldError({ holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false, sameSession: false, canTakeOver: false, request: null }))) })
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

  it('本人接管（"在此编辑"，M3-P5 设计 §3.7）：申请带 takeover: self；结果未知时用同一个标识、同样的方式再试', async () => {
    const acquire = vi.fn<EditLeaseApi['acquire']>().mockRejectedValueOnce(new NetworkError('断网')).mockResolvedValueOnce(ACQUIRED)
    const context = setup({ acquire })
    const acquiring = acquireEditLease(context.options, { takeover: 'self' })
    await context.time.advance(UNKNOWN_OUTCOME_RETRY_DELAY_MS)
    expect(await acquiring).toMatchObject({ kind: 'acquired', revision: 5 })
    expect(acquire.mock.calls).toEqual([[DOCUMENT_ID, PAGE_ID, { takeover: 'self' }], [DOCUMENT_ID, PAGE_ID, { takeover: 'self' }]])
  })

  it('被自己占着、页面说不必再试（本浏览器里有标签页持有本机锁，M3-P5）：立即按被占用返回，只申请一次', async () => {
    const acquire = vi.fn(async () => Promise.reject(heldError(SELF_HELD)))
    const retrySameUser = vi.fn(async () => false)
    const context = setup({ acquire })
    expect(await acquireEditLease(context.options, { retrySameUser })).toMatchObject({ kind: 'held', holder: { sameUser: true } })
    expect(acquire).toHaveBeenCalledOnce()
    expect(retrySameUser).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('被自己占着、页面说要再试（锁空着：刷新时晚到的释放）：照旧隔 500 毫秒再试，每次再试之前都问——中途说不必了就停', async () => {
    const acquire = vi.fn(async () => Promise.reject(heldError(SELF_HELD)))
    const answers = [true, false]
    const retrySameUser = vi.fn(async () => answers.shift() ?? false)
    const context = setup({ acquire })
    const acquiring = acquireEditLease(context.options, { retrySameUser })
    await context.time.advance(SAME_USER_RETRY_DELAY_MS * SAME_USER_RETRIES)
    expect(await acquiring).toMatchObject({ kind: 'held', holder: { sameUser: true } })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(retrySameUser).toHaveBeenCalledTimes(2)
  })

  it('被别人占着：不问要不要再试（只有自己时才再试）', async () => {
    const retrySameUser = vi.fn(async () => true)
    const context = setup({ acquire: vi.fn(async () => Promise.reject(heldError(AMY_HELD))) })
    expect(await acquireEditLease(context.options, { retrySameUser })).toMatchObject({ kind: 'held', holder: { sameUser: false } })
    expect(retrySameUser).not.toHaveBeenCalled()
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
    ['EDIT_LEASE_LOST（本人在另一台设备或浏览器上接手：taken_over、forced 为假，M3-P5）', takenOverError(false), { kind: 'taken-over', where: 'elsewhere' }],
    ['EDIT_LEASE_LOST（空间管理员强制接管：taken_over、forced 为真）', takenOverError(true), { kind: 'forced' }],
    ['EDIT_LEASE_LOST（taken_over、forced 认不出：不猜，只说编辑权已失效）', takenOverError('yes'), { kind: 'lease', reason: 'taken_over' }],
    ['EDIT_LEASE_LOST（已经交给了请求编辑的人：handed_over）', lostError('handed_over'), { kind: 'lease', reason: 'handed_over' }],
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

  it('保存得知被接管（taken_over）：与续租同一个处理——不续上（不再申请），结果是失效，说明本人在别处接手', async () => {
    const context = setup()
    const lease = await held(context)
    const loss = leaseLossOf(takenOverError(false))
    expect(loss).toEqual({ kind: 'taken-over', where: 'elsewhere' })
    expect(await lease.lose(loss ?? { kind: 'newer' }, lease.credentials())).toEqual({ kind: 'lost' })
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'taken-over', where: 'elsewhere' })
    await context.time.advance(60_000)
    expect(context.api.acquire).toHaveBeenCalledOnce()
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
    expect(leaseLossOf(takenOverError(false))).toEqual({ kind: 'taken-over', where: 'elsewhere' })
    expect(leaseLossOf(takenOverError(true))).toEqual({ kind: 'forced' })
    expect(leaseLossOf(takenOverError(undefined))).toEqual({ kind: 'lease', reason: 'taken_over' })
    // forced 只跟着 taken_over 起作用
    expect(leaseLossOf(new ApiError(409, 'EDIT_LEASE_LOST', 'x', { details: { reason: 'replaced', forced: true } }))).toEqual({ kind: 'lease', reason: 'replaced' })
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
    // 续上的申请带本页的空闲秒数（M3-P5 设计 §3.5：服务端把新的一代的最后活动按它往前推）
    expect(context.api.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, PAGE_ID, { idleSeconds: 10 })
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

  /** 页面的样子：每次得知会话问题都向服务端确认（一个来回，50 毫秒），确认是本人之后恢复续租 */
  function resumeAfterConfirm(context: ReturnType<typeof setup>, lease: Awaited<ReturnType<typeof held>>): void {
    context.onSessionProblem.mockImplementation(() => {
      context.time.clock.schedule(() => void lease.resume(), 50)
    })
  }

  it('续租一直得到令牌失效（例如网关剥掉了 CSRF 的请求头）、页面每次确认都是本人（复验 C1）：只有连着的第一次之后立即续租，之后按心跳的节奏——不按网络往返的速度连着发', async () => {
    const renewedAt: number[] = []
    const context = setup({ renew: vi.fn(async () => {
      renewedAt.push(context.time.now())
      throw new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    }) })
    const lease = await held(context)
    resumeAfterConfirm(context, lease)
    const start = context.time.now()
    await context.time.advance(40_000)
    // 10 秒的心跳被拒、确认之后立即再续一次（10.05 秒）仍被拒；之后每次确认之后按心跳的节奏：20.1、30.15 秒
    expect(renewedAt.map(at => at - start)).toEqual([10_000, 10_050, 20_100, 30_150])
    expect(context.onSessionProblem).toHaveBeenCalledTimes(4)
    expect(context.onLost).not.toHaveBeenCalled()
  })

  it('连着的会话类失败在续租成功之后清零：之后再遇到，确认之后照样立即续租', async () => {
    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const renewedAt: number[] = []
    const outcomes: (RenewedEditLease | ApiError)[] = [csrf, csrf, RENEWED, csrf, RENEWED]
    const context = setup({ renew: vi.fn(async () => {
      renewedAt.push(context.time.now())
      const outcome = outcomes[renewedAt.length - 1] ?? RENEWED
      if (outcome instanceof ApiError)
        throw outcome
      return outcome
    }) })
    const lease = await held(context)
    resumeAfterConfirm(context, lease)
    const start = context.time.now()
    await context.time.advance(31_000)
    // 第 2 次（10.05 秒）是连着的第二次，之后按心跳（20.1 秒成功，清零）；30.1 秒被拒是新的第一次，确认之后立即续租（30.15 秒）
    expect(renewedAt.map(at => at - start)).toEqual([10_000, 10_050, 20_100, 30_100, 30_150])
  })

  it('续上的申请成功了同样清零：连着两次被拒之后编辑权到期、续上成功，之后再遇到会话类失败，确认之后照样立即续租', async () => {
    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const renewedAt: number[] = []
    const outcomes: (RenewedEditLease | ApiError)[] = [csrf, csrf, lostError('expired'), csrf, RENEWED]
    const context = setup({ renew: vi.fn(async () => {
      renewedAt.push(context.time.now())
      const outcome = outcomes[renewedAt.length - 1] ?? RENEWED
      if (outcome instanceof ApiError)
        throw outcome
      return outcome
    }) })
    const lease = await held(context)
    resumeAfterConfirm(context, lease)
    const start = context.time.now()
    await context.time.advance(31_000)
    // 20.1 秒得知到期、续上成功（换成下一代、清零）；30.1 秒被拒是新的第一次，确认之后立即续租（30.15 秒）
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
    expect(renewedAt.map(at => at - start)).toEqual([10_000, 10_050, 20_100, 30_100, 30_150])
  })

  it('连着两次会话类失败之后页面确认不是本人（暂停：真的登出了）：清零——回到本人时立即续租、核对编辑权（复核 D1）', async () => {
    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const renewedAt: number[] = []
    const outcomes: (RenewedEditLease | ApiError)[] = [csrf, csrf]
    const context = setup({ renew: vi.fn(async () => {
      renewedAt.push(context.time.now())
      const outcome = outcomes[renewedAt.length - 1] ?? RENEWED
      if (outcome instanceof ApiError)
        throw outcome
      return outcome
    }) })
    const lease = await held(context)
    const start = context.time.now()
    // 10 秒的心跳被拒；页面确认是本人、恢复：立即续租又被拒（连着的第二次）
    await context.time.advance(10_000)
    await lease.resume()
    // 页面再确认：没有人登录了（暂停）；一分钟之后本人登录回来
    lease.pause()
    await context.time.advance(60_000)
    await lease.resume()
    expect(renewedAt.map(at => at - start)).toEqual([10_000, 10_000, 70_000])
  })

  it('续上的申请得到令牌失效也算连着的会话类失败（复验 C1）：失效 → 续上被拒 → 恢复 → 续租又失效 → 续上又被拒，第二轮起按心跳的节奏', async () => {
    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const renewedAt: number[] = []
    const context = setup({
      renew: vi.fn(async () => {
        renewedAt.push(context.time.now())
        throw lostError('session')
      }),
      acquire: vi.fn<EditLeaseApi['acquire']>().mockResolvedValueOnce(ACQUIRED).mockRejectedValue(csrf),
    })
    const lease = await held(context)
    resumeAfterConfirm(context, lease)
    const start = context.time.now()
    await context.time.advance(25_000)
    expect(renewedAt.map(at => at - start)).toEqual([10_000, 10_050, 20_100])
    // 申请：取得那一次之外，每次续上一次
    expect(context.api.acquire).toHaveBeenCalledTimes(4)
    expect(context.onLost).not.toHaveBeenCalled()
  })
})

describe('浏览器的计时器（browserLeaseClock）', () => {
  it('延迟超过浏览器计时器的上限（约 24.8 天）时按上限：否则溢出成立即触发，按它排的调度在原地空转（复验 C2）', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    try {
      browserLeaseClock.schedule(() => {}, 30 * 24 * 3600 * 1000)()
      expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 2 ** 31 - 1)
      browserLeaseClock.schedule(() => {}, 1500)()
      expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 1500)
    }
    finally {
      timeout.mockRestore()
    }
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

  /** 交给监听的事件：类型、可信与否、指针与坐标（jsdom 派发的事件 isTrusted 一律为假，可信的输入只能这样交给监听） */
  interface FakeInput {
    readonly type: string
    readonly isTrusted?: boolean
    readonly pointerId?: number
    readonly clientX?: number
    readonly clientY?: number
  }

  /** 记下挂上的监听的假窗口：fire 把事件直接交给某一类的监听 */
  function fakeWindow() {
    const listeners = new Map<string, (event: Event) => void>()
    const added: [string, unknown][] = []
    const removed: [string, unknown][] = []
    const target = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        added.push([type, options])
        listeners.set(type, listener as (event: Event) => void)
      },
      removeEventListener: (type: string, _listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        removed.push([type, options])
        listeners.delete(type)
      },
    }
    return {
      target,
      added,
      removed,
      fire: (input: FakeInput) => listeners.get(input.type)?.({ isTrusted: true, ...input } as unknown as Event),
    }
  }

  it('键盘、指针（含移动）与滚轮都在窗口的捕获阶段挂上（passive，交互屏障挂在它之后、拦不住它）；撤销时按捕获阶段去掉', () => {
    const page = fakeWindow()
    const stop = trackActivity(page.target, vi.fn())
    expect(page.added).toEqual(['keydown', 'pointerdown', 'pointermove', 'wheel'].map(type => [type, { capture: true, passive: true }]))
    stop()
    expect(page.removed).toEqual(['keydown', 'pointerdown', 'pointermove', 'wheel'].map(type => [type, { capture: true }]))
  })

  it('可信的键盘、指针按下、滚轮与挪动了的指针移动都算有操作', () => {
    const page = fakeWindow()
    const onActivity = vi.fn()
    trackActivity(page.target, onActivity)
    page.fire({ type: 'keydown' })
    page.fire({ type: 'pointerdown', pointerId: 1, clientX: 10, clientY: 10 })
    page.fire({ type: 'wheel' })
    page.fire({ type: 'pointermove', pointerId: 1, clientX: 11, clientY: 10 })
    page.fire({ type: 'pointermove', pointerId: 1, clientX: 11, clientY: 12 })
    expect(onActivity).toHaveBeenCalledTimes(5)
  })

  it('只认可信事件（M3-P5 设计 §3.9）：页面、SDK 自己派发的合成事件不是人在操作', () => {
    const page = fakeWindow()
    const onActivity = vi.fn()
    trackActivity(page.target, onActivity)
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel'])
      page.fire({ type, isTrusted: false, pointerId: 1, clientX: 5, clientY: 5 })
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('零位移的 pointermove 不算（WebKit 在鼠标停着、页面被程序滚动时派发它，探索 §3.2）：与上一次指针事件是同一个指针、坐标相同', () => {
    const page = fakeWindow()
    const onActivity = vi.fn()
    trackActivity(page.target, onActivity)
    // 第一次移动没有可比的：算
    page.fire({ type: 'pointermove', pointerId: 1, clientX: 200, clientY: 200 })
    expect(onActivity).toHaveBeenCalledTimes(1)
    // 鼠标停着、页面被程序滚动了五次
    for (let index = 0; index < 5; index += 1)
      page.fire({ type: 'pointermove', pointerId: 1, clientX: 200, clientY: 200 })
    expect(onActivity).toHaveBeenCalledTimes(1)
    // 按下（不论坐标）照样算，之后在原地的移动不算
    page.fire({ type: 'pointerdown', pointerId: 1, clientX: 200, clientY: 200 })
    page.fire({ type: 'pointermove', pointerId: 1, clientX: 200, clientY: 200 })
    expect(onActivity).toHaveBeenCalledTimes(2)
    // 另一个指针（触摸、笔）在同样的坐标：不是同一个指针，算
    page.fire({ type: 'pointermove', pointerId: 2, clientX: 200, clientY: 200 })
    expect(onActivity).toHaveBeenCalledTimes(3)
    // 挪动了：算
    page.fire({ type: 'pointermove', pointerId: 2, clientX: 201, clientY: 200 })
    expect(onActivity).toHaveBeenCalledTimes(4)
  })

  it('真实的窗口：页面里派发的事件（不可信）一律不算；撤销之后不再记', () => {
    const onActivity = vi.fn()
    const stop = trackActivity(window, onActivity)
    const inner = document.createElement('div')
    document.body.append(inner)
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel'])
      inner.dispatchEvent(new Event(type, { bubbles: true }))
    expect(onActivity).not.toHaveBeenCalled()
    stop()
  })
})

describe('与服务端不兼容（M3-P3 设计 §3.5）：本页过旧、文档比服务端新', () => {
  it.each([
    ['CLIENT_OUTDATED', 'client-outdated'],
    ['DOCUMENT_TOO_NEW', 'document-too-new'],
  ] as const)('续租得到 %s：停止续租、尽力放掉手里那一代，通知页面一次（%s），不当作失效、不续上', async (code, kind) => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(new ApiError(409, code, '不兼容'))) })
    const lease = await held(context)
    await context.time.advance(10_000)
    expect(context.onIncompatible).toHaveBeenCalledExactlyOnceWith(kind)
    expect(context.onLost).not.toHaveBeenCalled()
    expect(context.calls).toEqual(['release T'])
    expect(context.api.acquire).toHaveBeenCalledOnce()
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
    // 终态：之后再释放不再发（交回停住时那一次释放的结果：服务端确认了），保存得知的失效也不再续上
    expect(await lease.release()).toBe(true)
    expect(await lease.lose({ kind: 'lease', reason: 'expired' }, lease.credentials())).toEqual({ kind: 'lost' })
    expect(context.calls).toEqual(['release T'])
  })

  it('停住时那一次释放没送到（断网）：之后的 release()（退出编辑时等它）交回没确认（false），不再发、不说成已确认（审查 B8）；还在路上时等它', async () => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧'))) })
    const lease = await held(context)
    let fail: ((error: unknown) => void) | undefined
    context.api.release.mockImplementationOnce(async () => new Promise<void>((_resolve, reject) => {
      fail = reject
    }))
    await context.time.advance(10_000)
    expect(context.onIncompatible).toHaveBeenCalledOnce()
    expect(context.api.release).toHaveBeenCalledOnce()
    let confirmed: boolean | undefined
    const releasing = lease.release().then((result) => {
      confirmed = result
    })
    await settle()
    expect(confirmed).toBeUndefined()
    fail?.(new NetworkError('断网'))
    await releasing
    expect(confirmed).toBe(false)
    await expect(lease.release()).resolves.toBe(false)
    expect(context.api.release).toHaveBeenCalledOnce()
  })

  it('续上的申请得到 CLIENT_OUTDATED（编辑权中断期间服务端升级了）：通知页面需要刷新，不当作失效', async () => {
    const context = setup()
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired'))
    Object.assign(context.api, { renew })
    await held(context)
    context.api.acquire.mockRejectedValueOnce(new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧', { details: { reason: 'format' } }))
    await context.time.advance(10_000)
    expect(context.onIncompatible).toHaveBeenCalledExactlyOnceWith('client-outdated')
    expect(context.onLost).not.toHaveBeenCalled()
    await context.time.advance(60_000)
    expect(renew).toHaveBeenCalledOnce()
  })

  it('第一次申请得到 CLIENT_OUTDATED、DOCUMENT_TOO_NEW：原样抛出，由页面留在阅读并说明，不再试', async () => {
    for (const code of ['CLIENT_OUTDATED', 'DOCUMENT_TOO_NEW']) {
      const error = new ApiError(409, code, '不兼容')
      const context = setup({ acquire: vi.fn(async () => Promise.reject(error)) })
      await expect(acquireEditLease(context.options)).rejects.toBe(error)
      expect(context.api.acquire).toHaveBeenCalledOnce()
    }
  })
})

describe('续上的申请带本页的空闲秒数（M3-P5 设计 §3.5）', () => {
  it('续上时带的是这一刻本页距离最后一次操作的整秒数；第一次（用户发起的）申请不带', async () => {
    const context = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED) })
    await held(context)
    expect(context.api.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, PAGE_ID)
    context.interact(context.time.now() + 2_500)
    await context.time.advance(10_000)
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(context.api.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, PAGE_ID, { idleSeconds: 7 })
  })
})

describe('停止续上（M3-P5 设计 §3.9：空闲释放开始的那一刻起，没释放成时恢复）', () => {
  it('停止期间续租得知可以续上的失效：不放、不申请，交回说不准；心跳照常排下一次；恢复之后下一次得知时续上', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('expired')).mockRejectedValueOnce(lostError('expired')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    lease.holdRecovery()
    await context.time.advance(10_000)
    expect(renew).toHaveBeenCalledOnce()
    expect(context.api.release).not.toHaveBeenCalled()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.onLost).not.toHaveBeenCalled()
    expect(lease.credentials().token).toBe(TOKEN)
    lease.allowRecovery()
    await settle()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    context.interact()
    await context.time.advance(10_000)
    expect(renew).toHaveBeenCalledTimes(2)
    expect(context.calls).toEqual(['release T'])
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)
  })

  it('停止期间保存得知可以续上的失效：交回说不准、不带错误（保存按原来的失败说明），不申请', async () => {
    const context = setup()
    const lease = await held(context)
    lease.holdRecovery()
    expect(await lease.lose({ kind: 'lease', reason: 'expired' }, lease.credentials())).toEqual({ kind: 'unknown', error: undefined })
    expect(context.api.acquire).toHaveBeenCalledOnce()
    expect(context.api.release).not.toHaveBeenCalled()
  })

  it('停止续上不挡失去访问、编辑权（不可续上的照样失效、通知页面）', async () => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('revoked'))) })
    const lease = await held(context)
    lease.holdRecovery()
    await context.time.advance(10_000)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'lease', reason: 'revoked' })
  })

  it('人不在（dormant）时停止续上：之后的操作不把它叫醒；恢复时人已经回来了就随即续上，人还不在就照旧等操作', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('idle')).mockResolvedValue(RENEWED)
    const context = setup({ renew })
    const lease = await held(context)
    context.interact(context.time.now() - RECLAIM_MS)
    await context.time.advance(10_000)
    expect(context.time.pending()).toBe(0)
    lease.holdRecovery()
    context.interact()
    lease.noteActivity()
    await settle()
    expect(context.api.release).not.toHaveBeenCalled()
    expect(context.api.acquire).toHaveBeenCalledOnce()
    // 恢复时人在（刚有过操作）：随即续上
    lease.allowRecovery()
    await settle()
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    expect(lease.credentials().token).toBe(NEXT_TOKEN)

    const away = setup({ renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(lostError('idle')).mockResolvedValue(RENEWED) })
    const dormant = await held(away)
    away.interact(away.time.now() - RECLAIM_MS)
    await away.time.advance(10_000)
    dormant.holdRecovery()
    dormant.allowRecovery()
    await settle()
    expect(away.api.acquire).toHaveBeenCalledOnce()
    // 之后有操作时照常续上
    away.interact()
    dormant.noteActivity()
    await settle()
    expect(away.api.acquire).toHaveBeenCalledTimes(2)
  })
})

describe('放弃这一代（M3-P5 设计 §3.1：本机锁被本浏览器的另一个标签页抢走）', () => {
  it('停止续租、不发释放、不通知页面；之后得知的失效一律交回已失效，不续上', async () => {
    const context = setup()
    const lease = await held(context)
    lease.abandon()
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    expect(context.api.release).not.toHaveBeenCalled()
    expect(context.onLost).not.toHaveBeenCalled()
    expect(await lease.lose({ kind: 'lease', reason: 'replaced' }, lease.credentials())).toEqual({ kind: 'lost' })
    expect(context.api.acquire).toHaveBeenCalledOnce()
    // 已经失效：释放什么也不发，交回"本页没有还在的那一代"
    await expect(lease.release()).resolves.toBe(true)
    expect(context.api.release).not.toHaveBeenCalled()
  })

  it('续上进行中被放弃：申请回来时新的一代随即放掉，不通知页面', async () => {
    const reply = deferred<AcquiredEditLease>()
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('expired'))) })
    const lease = await held(context)
    context.api.acquire.mockReturnValueOnce(reply.promise)
    await context.time.advance(10_000)
    expect(context.api.acquire).toHaveBeenCalledTimes(2)
    lease.abandon()
    reply.resolve(NEXT)
    await settle()
    expect(context.calls).toEqual(['release T', 'release N'])
    expect(context.onLost).not.toHaveBeenCalled()
    expect(lease.credentials().token).toBe(TOKEN)
  })

  it('已经失效、释放过之后再放弃：什么也不做', async () => {
    const context = setup()
    const lease = await held(context)
    await lease.release()
    lease.abandon()
    expect(context.api.release).toHaveBeenCalledOnce()
    await expect(lease.release()).resolves.toBe(true)
  })
})

describe('心跳带来的请求编辑（M3-P5 设计 §3.6）', () => {
  const REQUEST = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f1', requester: AMY, requestedAt: '2026-10-04T03:00:30.000Z' }

  it('每次续租成功都把响应里的请求交给页面：有待回应的请求时是它，没有（取消、过期、被谢绝）时是 null', async () => {
    const context = setup()
    context.api.renew.mockResolvedValueOnce({ ...RENEWED, request: REQUEST })
    await held(context)
    await context.time.advance(10_000)
    expect(context.onRequest).toHaveBeenLastCalledWith(REQUEST)
    await context.time.advance(10_000)
    expect(context.onRequest).toHaveBeenLastCalledWith(null)
    expect(context.onRequest).toHaveBeenCalledTimes(2)
  })

  it('续租失败时不交（网络、失效）', async () => {
    const context = setup()
    context.api.renew.mockRejectedValueOnce(new NetworkError('断网'))
    await held(context)
    await context.time.advance(10_000)
    expect(context.onRequest).not.toHaveBeenCalled()
  })

  it('续租在途时这一代已经不用了（释放、放弃）：回来时不再交', async () => {
    for (const end of ['release', 'abandon'] as const) {
      const answer = deferred<RenewedEditLease>()
      const context = setup()
      context.api.renew.mockReturnValueOnce(answer.promise)
      const lease = await held(context)
      await context.time.advance(10_000)
      if (end === 'release')
        await lease.release()
      else
        lease.abandon()
      answer.resolve({ ...RENEWED, request: REQUEST })
      await settle()
      expect(context.onRequest).not.toHaveBeenCalled()
    }
  })

  it('放弃之后（交出了）：不再续租，也不发释放', async () => {
    const context = setup()
    const lease = await held(context)
    lease.abandon()
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    await lease.release()
    expect(context.api.release).not.toHaveBeenCalled()
  })
})

import type { AcquiredEditLease, RenewedEditLease, UserSummary } from '@nerve-office/contracts'
import type { EditLeaseApi, EditLeaseOptions, LeaseLoss } from './edit-lease.ts'
import { EDIT_IDLE_SECONDS_MAX } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError } from '../../shared/api/index.ts'
import { acquireEditLease, leaseLossOf, SAME_USER_RETRIES, SAME_USER_RETRY_DELAY_MS, trackActivity } from './edit-lease.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TOKEN = 'T'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 3, revision: 5, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null }
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

function setup(api: Partial<EditLeaseApi> = {}) {
  const time = fakeLeaseClock()
  let lastActivity = time.now()
  const fakeApi = {
    acquire: vi.fn(async (): Promise<AcquiredEditLease> => ACQUIRED),
    renew: vi.fn(async (): Promise<RenewedEditLease> => RENEWED),
    release: vi.fn(),
    ...api,
  }
  const onLost = vi.fn<(loss: LeaseLoss) => void>()
  const onSessionProblem = vi.fn<(error: ApiError) => void>()
  const options: EditLeaseOptions = {
    documentId: DOCUMENT_ID,
    clientInstanceId: PAGE_ID,
    api: fakeApi,
    clock: time.clock,
    lastActivity: () => lastActivity,
    onLost,
    onSessionProblem,
  }
  return {
    time,
    api: fakeApi,
    onLost,
    onSessionProblem,
    options,
    /** 本页有一次键盘、鼠标操作：默认在现在，可以给出更早的时刻 */
    interact: (at = time.now()) => {
      lastActivity = at
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
    expect(result).toMatchObject({ kind: 'acquired', revision: 5, lease: { credentials: { token: TOKEN, writeEpoch: 3 } } })
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
    ['403（刚失去编辑权）', new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能保存')],
    ['404', new ApiError(404, 'NOT_FOUND', '不存在')],
    ['未登录', new ApiError(401, 'SESSION_EXPIRED', '已过期')],
    ['网络错误', new NetworkError('断网')],
  ])('别的失败原样抛出（%s），由页面处理', async (_case, error) => {
    const context = setup({ acquire: vi.fn(async () => Promise.reject(error)) })
    await expect(acquireEditLease(context.options)).rejects.toBe(error)
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

describe('失效', () => {
  const denied = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
  const gone = new ApiError(404, 'NOT_FOUND', '请求的资源不存在或无权访问')
  it.each([
    ['EDIT_LEASE_LOST（到期）', lostError('expired'), { kind: 'lease', reason: 'expired' }],
    ['EDIT_LEASE_LOST（被接手）', lostError('replaced'), { kind: 'lease', reason: 'replaced' }],
    ['EDIT_LEASE_LOST（不认识的原因）', lostError('handed-over'), { kind: 'lease', reason: undefined }],
    ['EDIT_LEASE_LOST（没有原因）', lostError(), { kind: 'lease', reason: undefined }],
    ['403（能读不能编辑了）', denied, { kind: 'denied', error: denied }],
    ['404（读不到了）', gone, { kind: 'not-found', error: gone }],
  ])('续租得到%s：通知页面一次，停止续租', async (_case, error, loss) => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(error)) })
    await held(context)
    await context.time.advance(10_000)
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith(loss)
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('别的请求（保存）得知失效：与续租失效同一个处理，只通知一次；之后恢复、释放都不再做事', async () => {
    const context = setup()
    const lease = await held(context)
    lease.lose({ kind: 'lease', reason: 'replaced' })
    lease.lose({ kind: 'lease', reason: 'expired' })
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'lease', reason: 'replaced' })
    await lease.resume()
    lease.release()
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    expect(context.api.release).not.toHaveBeenCalled()
  })

  it('续租在途时得知失效：回来的结果不再排下一次', async () => {
    const reply = deferred<RenewedEditLease>()
    const context = setup({ renew: vi.fn(async () => reply.promise) })
    const lease = await held(context)
    await context.time.advance(10_000)
    lease.lose({ kind: 'lease', reason: 'replaced' })
    reply.resolve(RENEWED)
    await context.time.advance(60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('leaseLossOf：只认编辑权失效、404 与 403；别的失败（含 CSRF 失效的 403）不算', () => {
    expect(leaseLossOf(lostError('idle'))).toEqual({ kind: 'lease', reason: 'idle' })
    expect(leaseLossOf(new ApiError(403, 'CSRF_TOKEN_INVALID', 'x'))).toBeUndefined()
    expect(leaseLossOf(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', 'x'))).toBeUndefined()
    expect(leaseLossOf(new NetworkError('断网'))).toBeUndefined()
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

  it('恢复时得知租约已经失效（登录换过，session）：resume 在通知页面之后兑现', async () => {
    const context = setup({ renew: vi.fn(async () => Promise.reject(lostError('session'))) })
    const lease = await held(context)
    lease.pause()
    await lease.resume()
    expect(context.onLost).toHaveBeenCalledExactlyOnceWith({ kind: 'lease', reason: 'session' })
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

  it('暂停之前发出的续租回来得知失效：照样通知页面（服务端的回答说的是本页的租约）', async () => {
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
    lease.release()
    lease.release()
    expect(context.api.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    await context.time.advance(60_000)
    expect(context.api.renew).not.toHaveBeenCalled()
    await lease.resume()
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('暂停时（会话不是本人）不发：带的会是别人的或已经失效的登录', async () => {
    const context = setup()
    const lease = await held(context)
    lease.pause()
    lease.release()
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

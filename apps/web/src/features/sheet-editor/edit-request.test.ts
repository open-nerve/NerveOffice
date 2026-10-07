import type { DocumentEditor, EditRequestOutcome, UserSummary } from '@nerve-office/contracts'
import type { EditRequestApi, EditRequestEnd, EditRequestProgress, EditRequestsOptions } from './edit-request.ts'
import type { HandoverTraceEvent } from './handover-trace.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { createEditRequests, REQUEST_IDLE_MS, REQUEST_RENEW_MS } from './edit-request.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const REQUEST_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000f1'
const AMY: UserSummary = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e1', username: 'amy', displayName: '艾米' }
const BEN: UserSummary = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e2', username: 'ben', displayName: '本' }
/** 艾米在编辑 */
const AMY_EDITING: DocumentEditor = { holder: AMY, lastActiveAt: '2026-10-07T03:00:00.000Z', sameUser: false, sameSession: false }

const PENDING: EditRequestOutcome = { kind: 'pending', id: REQUEST_ID, requestedAt: '2026-10-07T03:01:00.000Z', expiresAt: '2026-10-07T03:11:00.000Z', holder: AMY_EDITING }
const RESERVED: EditRequestOutcome = { kind: 'reserved', reservedUntil: '2026-10-07T03:03:00.000Z' }
const FREE: EditRequestOutcome = { kind: 'free' }
const DECLINED: EditRequestOutcome = { kind: 'declined', id: REQUEST_ID, holder: AMY_EDITING }
const GONE: EditRequestOutcome = { kind: 'gone', holder: null }

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

function fakeVisibility() {
  let hidden = false
  const listeners = new Set<() => void>()
  return {
    visibility: {
      hidden: () => hidden,
      onChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set: (next: boolean) => {
      hidden = next
      listeners.forEach(listener => listener())
    },
    listeners,
  }
}

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
})

interface Setup {
  readonly send?: EditRequestApi['send']
  readonly renew?: EditRequestApi['renew']
  readonly cancel?: EditRequestApi['cancel']
  /** 状态机能不能进入编辑（默认能） */
  readonly enter?: () => boolean
  /** 测试构建的观察钩子（M3-P5 S8）：默认不给 */
  readonly trace?: EditRequestsOptions['trace']
}

/** 请求方的环境：假的接口、时钟与可见性；最后一次操作停在开始的那一刻，act 记下一次操作；进展与结束按先后记下 */
function setup(options: Setup = {}) {
  const time = fakeLeaseClock()
  const page = fakeVisibility()
  let lastActive = time.now()
  const api = {
    send: vi.fn<EditRequestApi['send']>(options.send ?? (async () => PENDING)),
    renew: vi.fn<EditRequestApi['renew']>(options.renew ?? (async () => PENDING)),
    cancel: vi.fn<EditRequestApi['cancel']>(options.cancel ?? (async () => {})),
  }
  const progress: (EditRequestProgress | undefined)[] = []
  const ends: EditRequestEnd[] = []
  const enter = vi.fn(options.enter ?? (() => true))
  const onSessionProblem = vi.fn<EditRequestsOptions['onSessionProblem']>()
  const requests = createEditRequests({
    documentId: DOCUMENT_ID,
    api,
    clock: time.clock,
    visibility: page.visibility,
    lastActivity: () => lastActive,
    onSessionProblem,
    onProgress: next => progress.push(next),
    enter,
    onEnd: end => ends.push(end),
    trace: options.trace,
  })
  disposers.push(requests.dispose)
  return {
    requests,
    api,
    time,
    page,
    progress,
    ends,
    enter,
    onSessionProblem,
    act: () => {
      lastActive = time.now()
    },
  }
}

/** 发出、进入等待 */
async function waiting(context: ReturnType<typeof setup>): Promise<void> {
  await context.requests.send()
  expect(context.requests.progress()).toEqual({ kind: 'waiting', holder: AMY, cancelFailure: undefined })
}

describe('发出（"请求编辑"）', () => {
  it('在等待：进展先是 sending、再是 waiting（等谁），POST 一次；之后每 5 秒续期一次（不再发出）', async () => {
    const context = setup()
    const sending = context.requests.send()
    expect(context.requests.progress()).toEqual({ kind: 'sending' })
    await sending
    expect(context.progress).toEqual([{ kind: 'sending' }, { kind: 'waiting', holder: AMY, cancelFailure: undefined }])
    expect(context.api.send).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    await context.time.advance(REQUEST_RENEW_MS - 1)
    expect(context.api.renew).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.api.renew).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
    expect(context.api.send).toHaveBeenCalledOnce()
    expect(context.ends).toEqual([])
  })

  it('已经有请求时再按什么也不做', async () => {
    const context = setup()
    await waiting(context)
    await context.requests.send()
    expect(context.api.send).toHaveBeenCalledOnce()
  })

  it.each([
    ['交给了本页（reserved）', RESERVED],
    ['没人在编辑（free）', FREE],
  ] as const)('%s、页面看得见：立即进入编辑（交给状态机），请求随之完成，不续期', async (_case, outcome) => {
    const context = setup({ send: async () => outcome })
    await context.requests.send()
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.requests.progress()).toBeUndefined()
    expect(context.ends).toEqual([])
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('正在编辑的是自己（self）：结束，改走"在此编辑"', async () => {
    const context = setup({ send: async () => ({ kind: 'self', holder: { ...AMY_EDITING, sameUser: true } }) })
    await context.requests.send()
    expect(context.ends).toEqual([{ kind: 'self' }])
    expect(context.requests.progress()).toBeUndefined()
  })

  it('别人先请求了（occupied）：结束，说明是谁；编辑权刚交给了别人（reservedForOther）：结束，说明交给了谁、留到何时——请求没有写下，不撤回', async () => {
    const occupied = setup({ send: async () => ({ kind: 'occupied', requester: BEN, requestedAt: '2026-10-07T03:00:30.000Z' }) })
    await occupied.requests.send()
    expect(occupied.ends).toEqual([{ kind: 'occupied', requester: BEN }])
    const reserved = setup({ send: async () => ({ kind: 'reservedForOther', reservedFor: BEN, reservedUntil: '2026-10-07T03:03:00.000Z' }) })
    await reserved.requests.send()
    expect(reserved.ends).toEqual([{ kind: 'reserved-for-other', reservedFor: BEN, reservedUntil: '2026-10-07T03:03:00.000Z' }])
    expect(reserved.api.cancel).not.toHaveBeenCalled()
    await reserved.time.advance(REQUEST_RENEW_MS * 2)
    expect(reserved.api.renew).not.toHaveBeenCalled()
  })

  it('发出失败（网络、403、版本过旧……）：结束，原因交给状态机；不另交给页面确认会话（状态机按原因处理）', async () => {
    const error = new NetworkError('断网')
    const context = setup({ send: async () => Promise.reject(error) })
    await context.requests.send()
    expect(context.ends).toEqual([{ kind: 'failed', error }])
    expect(context.requests.progress()).toBeUndefined()
    const unauthenticated = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    const session = setup({ send: async () => Promise.reject(unauthenticated) })
    await session.requests.send()
    expect(session.ends).toEqual([{ kind: 'failed', error: unauthenticated }])
    expect(session.onSessionProblem).not.toHaveBeenCalled()
  })
})

describe('等待：续期', () => {
  it('同时只有一个续期在途：回来之后按发出的时刻排下一次（回来得慢时不多等）', async () => {
    const answer = deferred<EditRequestOutcome>()
    const context = setup()
    await waiting(context)
    context.api.renew.mockReturnValueOnce(answer.promise)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledOnce()
    // 在途时回到前台：不另发一次
    context.page.set(true)
    context.page.set(false)
    await settle()
    expect(context.api.renew).toHaveBeenCalledOnce()
    await context.time.advance(3_000)
    answer.resolve(PENDING)
    await settle()
    await context.time.advance(REQUEST_RENEW_MS - 3_000 - 1)
    expect(context.api.renew).toHaveBeenCalledOnce()
    await context.time.advance(1)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
  })

  it('持有者换了（续期的回答里正在编辑的人变了）：等待里的人随之更新；没变时不另报进展', async () => {
    const context = setup()
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.progress).toHaveLength(2)
    context.api.renew.mockResolvedValue({ ...PENDING, holder: { ...AMY_EDITING, holder: BEN } })
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'waiting', holder: BEN, cancelFailure: undefined })
  })

  it('页面隐藏时照常续期（浏览器自己降频）；回到前台立即续期一次，之后照常每 5 秒', async () => {
    const context = setup()
    await waiting(context)
    context.page.set(true)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledOnce()
    await context.time.advance(2_000)
    context.page.set(false)
    await settle()
    expect(context.api.renew).toHaveBeenCalledTimes(2)
    await context.time.advance(REQUEST_RENEW_MS - 1)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
    await context.time.advance(1)
    expect(context.api.renew).toHaveBeenCalledTimes(3)
  })

  it('持有者谢绝（declined）：结束，说明谁谢绝了；不再续期', async () => {
    const context = setup({ renew: async () => DECLINED })
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.ends).toEqual([{ kind: 'declined', holder: AMY }])
    expect(context.requests.progress()).toBeUndefined()
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('请求不在了（gone）：结束、说明；不再续期', async () => {
    const context = setup({ renew: async () => GONE })
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.ends).toEqual([{ kind: 'gone' }])
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('续期时编辑权刚交给了别人（reservedForOther：本人的请求还在槽里）：撤回它（DELETE），结束并说明', async () => {
    const context = setup({ renew: async () => ({ kind: 'reservedForOther', reservedFor: BEN, reservedUntil: '2026-10-07T03:03:00.000Z' }) })
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    expect(context.ends).toEqual([{ kind: 'reserved-for-other', reservedFor: BEN, reservedUntil: '2026-10-07T03:03:00.000Z' }])
  })

  it('交给了本页（reserved）、页面看得见：进入编辑；之后不再续期', async () => {
    const context = setup()
    await waiting(context)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.requests.progress()).toBeUndefined()
    expect(context.ends).toEqual([])
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('交给了本页、页面看不见（后台）：不进入编辑（granted），不再续期；回到前台时进入——保留期早已过了也照样进入（请求的意图还在）', async () => {
    const context = setup()
    await waiting(context)
    context.page.set(true)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'granted' })
    expect(context.enter).not.toHaveBeenCalled()
    // 保留只有 2 分钟：之后不再续期（没有续期会把 granted 改回去）
    context.act()
    await context.time.advance(5 * 60_000)
    expect(context.api.renew).toHaveBeenCalledOnce()
    context.act()
    context.page.set(false)
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.requests.progress()).toBeUndefined()
  })

  it('没人在编辑（free）、页面看不见：同样等回到前台再进入', async () => {
    const context = setup()
    await waiting(context)
    context.page.set(true)
    context.api.renew.mockResolvedValue(FREE)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'granted' })
    context.page.set(false)
    expect(context.enter).toHaveBeenCalledOnce()
  })

  it('状态机这一刻进入不了（例如正在按新的版本重建）：留在 granted，retry 时进入', async () => {
    let ready = false
    const context = setup({ enter: () => ready })
    await waiting(context)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.requests.progress()).toEqual({ kind: 'granted' })
    ready = true
    context.requests.retry()
    expect(context.enter).toHaveBeenCalledTimes(2)
    expect(context.requests.progress()).toBeUndefined()
    // 进入了之后 retry 什么也不做
    context.requests.retry()
    expect(context.enter).toHaveBeenCalledTimes(2)
  })

  it('续期遇到网络、服务端出错：照常等，下一次按节奏再试', async () => {
    const context = setup()
    await waiting(context)
    context.api.renew.mockRejectedValueOnce(new NetworkError('断网')).mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙'))
    await context.time.advance(REQUEST_RENEW_MS * 2)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
    expect(context.requests.progress()?.kind).toBe('waiting')
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledTimes(3)
    expect(context.ends).toEqual([])
  })

  it.each([
    ['未登录', new ApiError(401, 'SESSION_EXPIRED', '登录已过期')],
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')],
  ])('续期得到%s：交给页面确认会话，照常等', async (_case, error) => {
    const context = setup()
    await waiting(context)
    context.api.renew.mockRejectedValueOnce(error)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.onSessionProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(context.requests.progress()?.kind).toBe('waiting')
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['不能编辑了（403）', new ApiError(403, 'PERMISSION_DENIED', '只能查看')],
    ['读不到了（404）', new ApiError(404, 'NOT_FOUND', '不存在')],
  ])('续期得到%s：结束，原因交给状态机；不再续期', async (_case, error) => {
    const context = setup({ renew: async () => Promise.reject(error) })
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.ends).toEqual([{ kind: 'failed', error }])
    await context.time.advance(REQUEST_RENEW_MS * 2)
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('会话不是本人：不续期；回到本人时立即续期一次', async () => {
    const context = setup()
    await waiting(context)
    context.requests.setActive(false)
    await context.time.advance(REQUEST_RENEW_MS * 4)
    expect(context.api.renew).not.toHaveBeenCalled()
    context.requests.setActive(true)
    await settle()
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('granted、会话不是本人：不进入；回到本人时进入', async () => {
    const context = setup()
    await waiting(context)
    context.requests.setActive(false)
    context.page.set(true)
    context.requests.setActive(true)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'granted' })
    context.requests.setActive(false)
    context.page.set(false)
    expect(context.enter).not.toHaveBeenCalled()
    context.requests.setActive(true)
    expect(context.enter).toHaveBeenCalledOnce()
  })
})

describe('空闲：等待中的页面空闲满 10 分钟就取消请求', () => {
  it('每次续期之前看空闲：满 10 分钟（起点是开始等待的那一刻）就取消（DELETE），结束并说明；不再续期', async () => {
    const context = setup()
    await waiting(context)
    await context.time.advance(REQUEST_IDLE_MS - REQUEST_RENEW_MS)
    expect(context.api.cancel).not.toHaveBeenCalled()
    const renewals = context.api.renew.mock.calls.length
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    expect(context.ends).toEqual([{ kind: 'idle' }])
    expect(context.api.renew).toHaveBeenCalledTimes(renewals)
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).toHaveBeenCalledTimes(renewals)
  })

  it('其间有操作：从最后一次操作重新算', async () => {
    const context = setup()
    await waiting(context)
    await context.time.advance(4 * 60_000)
    context.act()
    await context.time.advance(REQUEST_IDLE_MS - REQUEST_RENEW_MS)
    expect(context.ends).toEqual([])
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.ends).toEqual([{ kind: 'idle' }])
  })

  it('起点不早于开始等待：打开很久没有操作之后才请求，从请求的那一刻起算', async () => {
    const context = setup()
    await context.time.advance(REQUEST_IDLE_MS * 2)
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.ends).toEqual([])
    expect(context.api.renew).toHaveBeenCalledOnce()
  })

  it('回到前台时（Safari 隐藏之后计时器停了）按隐藏之前的操作算：满 10 分钟就在可见性的通知里取消，不续期', async () => {
    const context = setup()
    await waiting(context)
    context.page.set(true)
    // 计时器停着（时间过去、到点的不执行）
    context.time.elapse(REQUEST_IDLE_MS)
    context.page.set(false)
    expect(context.api.cancel).toHaveBeenCalledOnce()
    expect(context.ends).toEqual([{ kind: 'idle' }])
    await settle()
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('granted（交给了本页、页面在后台）时同样：回到前台已空闲满 10 分钟就取消（清掉留给本页的保留），不进入编辑', async () => {
    const context = setup()
    await waiting(context)
    context.page.set(true)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'granted' })
    context.time.elapse(REQUEST_IDLE_MS)
    context.page.set(false)
    expect(context.enter).not.toHaveBeenCalled()
    expect(context.api.cancel).toHaveBeenCalledOnce()
    expect(context.ends).toEqual([{ kind: 'idle' }])
  })
})

describe('取消（"取消请求"）', () => {
  it('取消中（cancelling，仍记着等谁）→ DELETE 成功：结束（cancelled），不再续期', async () => {
    const answer = deferred<void>()
    const context = setup({ cancel: async () => answer.promise })
    await waiting(context)
    const cancelling = context.requests.cancel()
    expect(context.requests.progress()).toEqual({ kind: 'cancelling', holder: AMY })
    answer.resolve()
    await cancelling
    expect(context.ends).toEqual([{ kind: 'cancelled' }])
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('取消期间回来的续期作废：不再按它改进展', async () => {
    const renewal = deferred<EditRequestOutcome>()
    const cancelled = deferred<void>()
    const context = setup({ cancel: async () => cancelled.promise })
    await waiting(context)
    context.api.renew.mockReturnValueOnce(renewal.promise)
    await context.time.advance(REQUEST_RENEW_MS)
    const cancelling = context.requests.cancel()
    renewal.resolve(RESERVED)
    await settle()
    expect(context.enter).not.toHaveBeenCalled()
    expect(context.requests.progress()?.kind).toBe('cancelling')
    cancelled.resolve()
    await cancelling
    expect(context.ends).toEqual([{ kind: 'cancelled' }])
  })

  it('没取消成（网络）：回到等待、记下原因（可以再按），照常续期；再按成功就结束', async () => {
    const error = new NetworkError('断网')
    const context = setup()
    await waiting(context)
    context.api.cancel.mockRejectedValueOnce(error)
    await context.requests.cancel()
    expect(context.requests.progress()).toEqual({ kind: 'waiting', holder: AMY, cancelFailure: error })
    await settle()
    expect(context.api.renew).toHaveBeenCalledOnce()
    // 续期的回答（同一个人）不抹掉没取消成的原因
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'waiting', holder: AMY, cancelFailure: error })
    await context.requests.cancel()
    expect(context.ends).toEqual([{ kind: 'cancelled' }])
  })

  it('没取消成（令牌失效）：交给页面确认会话', async () => {
    const error = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const context = setup({ cancel: async () => Promise.reject(error) })
    await waiting(context)
    await context.requests.cancel()
    expect(context.onSessionProblem).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('取消失败之后续期还在途（取消之前发出的那一次）：它回来时作废，新的一轮照样续期，不会停住', async () => {
    const stale = deferred<EditRequestOutcome>()
    const context = setup()
    await waiting(context)
    context.api.renew.mockReturnValueOnce(stale.promise)
    await context.time.advance(REQUEST_RENEW_MS)
    context.api.cancel.mockRejectedValueOnce(new NetworkError('断网'))
    await context.requests.cancel()
    await settle()
    expect(context.api.renew).toHaveBeenCalledTimes(2)
    stale.resolve(GONE)
    await settle()
    expect(context.ends).toEqual([])
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledTimes(3)
  })

  it('没有请求、正在发出时：什么也不做', async () => {
    const context = setup()
    await context.requests.cancel()
    const answer = deferred<EditRequestOutcome>()
    context.api.send.mockReturnValueOnce(answer.promise)
    const sending = context.requests.send()
    await context.requests.cancel()
    expect(context.api.cancel).not.toHaveBeenCalled()
    answer.resolve(PENDING)
    await sending
  })
})

describe('恢复、撤回与停下', () => {
  it('恢复（编辑状态里有本人的请求）：不发出，直接等待、立即续期一次；之后照常每 5 秒', async () => {
    const context = setup()
    context.requests.resume(AMY)
    expect(context.requests.progress()).toEqual({ kind: 'waiting', holder: AMY, cancelFailure: undefined })
    await settle()
    expect(context.api.send).not.toHaveBeenCalled()
    expect(context.api.renew).toHaveBeenCalledOnce()
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.api.renew).toHaveBeenCalledTimes(2)
  })

  it('恢复的第一次续期就说交给了本页：照常进入编辑', async () => {
    const context = setup({ renew: async () => RESERVED })
    context.requests.resume(undefined)
    await settle()
    expect(context.enter).toHaveBeenCalledOnce()
  })

  it('撤回（页面关闭）：有请求就尽力取消（不等结果），停下，不说明；没有请求时不发', async () => {
    const context = setup()
    context.requests.withdraw()
    expect(context.api.cancel).not.toHaveBeenCalled()
    await waiting(context)
    context.requests.withdraw()
    expect(context.api.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    expect(context.requests.progress()).toBeUndefined()
    expect(context.progress.at(-1)).toBeUndefined()
    expect(context.ends).toEqual([])
    await context.time.advance(REQUEST_RENEW_MS * 3)
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('撤回时取消失败也不抛出（不留下没处理的拒绝）', async () => {
    const context = setup({ cancel: async () => Promise.reject(new NetworkError('断网')) })
    await waiting(context)
    context.requests.withdraw()
    await settle()
    expect(context.requests.progress()).toBeUndefined()
  })

  it('停下（卸载）：在途的回答不再回调，计时器取消，可见性不再订阅', async () => {
    const answer = deferred<EditRequestOutcome>()
    const context = setup({ send: async () => answer.promise })
    const sending = context.requests.send()
    context.requests.dispose()
    answer.resolve(PENDING)
    await sending
    expect(context.progress).toEqual([{ kind: 'sending' }])
    expect(context.page.listeners.size).toBe(0)
    await context.time.advance(REQUEST_RENEW_MS * 2)
    expect(context.api.renew).not.toHaveBeenCalled()
  })

  it('进展每变一次 version 加一（阅读时的检查据此丢掉过时的"有本人的请求"）', async () => {
    const context = setup()
    const start = context.requests.version()
    await waiting(context)
    expect(context.requests.version()).toBe(start + 2)
    await context.requests.cancel()
    expect(context.requests.version()).toBe(start + 4)
  })
})

describe('测试构建的观察钩子（M3-P5 设计 §3.13）：请求方的发出、续期、交给了本页与开始进入', () => {
  it('发出与每次续期的结果（结果的 kind）；交给了本页时页面看不看得见；看得见、进得去时开始进入，时刻按注入的时钟', async () => {
    const events: HandoverTraceEvent[] = []
    const context = setup({ trace: event => events.push(event) })
    await waiting(context)
    context.api.renew.mockResolvedValueOnce(PENDING).mockResolvedValueOnce(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    // 回到前台之前编辑权交给了本页：先记下看不见，回到前台才开始进入
    context.page.set(true)
    await context.time.advance(REQUEST_RENEW_MS)
    context.page.set(false)
    await settle()
    expect(events).toEqual([
      { kind: 'request-sent', at: 1_000, outcome: 'pending' },
      { kind: 'request-renewed', at: 1_000 + REQUEST_RENEW_MS, outcome: 'pending' },
      { kind: 'request-renewed', at: 1_000 + REQUEST_RENEW_MS * 2, outcome: 'reserved' },
      { kind: 'request-granted', at: 1_000 + REQUEST_RENEW_MS * 2, visible: false },
      { kind: 'request-enter', at: 1_000 + REQUEST_RENEW_MS * 2 },
    ])
  })

  it('发出、续期失败：带错误码（网络等没有错误码时只写 error）', async () => {
    const events: HandoverTraceEvent[] = []
    const failed = setup({ trace: event => events.push(event), send: async () => Promise.reject(new ApiError(409, 'CLIENT_OUTDATED', '页面过旧')) })
    await failed.requests.send()
    const context = setup({ trace: event => events.push(event) })
    await waiting(context)
    context.api.renew.mockRejectedValueOnce(new NetworkError('断网'))
    await context.time.advance(REQUEST_RENEW_MS)
    expect(events.map(event => event.kind === 'request-sent' || event.kind === 'request-renewed' ? `${event.kind}:${event.outcome}` : event.kind)).toEqual([
      'request-sent:error:CLIENT_OUTDATED',
      'request-sent:pending',
      'request-renewed:error',
    ])
  })
})

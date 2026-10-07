import type { DocumentEditor, EditRequestOutcome, UserSummary } from '@nerve-office/contracts'
import type { EditRequestApi, EditRequestEnd, EditRequestProgress, EditRequestsOptions } from './edit-request.ts'
import type { HandoverTraceEvent } from './handover-trace.ts'
import type { HeldLock } from './same-browser.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { createEditRequests, REQUEST_IDLE_MS, REQUEST_RENEW_MS } from './edit-request.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { memoryIssuedRequest } from './issued-request.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { issuedRequestLockNameOf, sameBrowserFor } from './same-browser.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
/** "发出过请求"的锁（复验 C2） */
const ISSUED_LOCK = issuedRequestLockNameOf(DOCUMENT_ID)
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
  /** 换掉"发出过请求"的锁（要控制拿到的时机时）；默认是假浏览器里的 */
  readonly issuerLock?: EditRequestsOptions['issuerLock']
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
  const issued = memoryIssuedRequest(DOCUMENT_ID)
  /** 同一个浏览器（"发出过请求"的锁，复验 C2）：本页在里面叫 this */
  const browser = fakeBrowser()
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
    issued: issued.marker,
    issuerLock: options.issuerLock ?? sameBrowserFor(DOCUMENT_ID, browser.tab('this')).holdIssuedRequest,
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
    issued: issued.marker,
    browser,
    /** 现在共享地持有"发出过请求"的锁的标签页 */
    issuers: () => browser.sharedHoldersOf(ISSUED_LOCK),
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
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
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
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
    context.page.set(false)
    expect(context.enter).toHaveBeenCalledOnce()
  })

  it('granted 在等什么随情形换（审查 B11）：页面在后台是 visible（回到这一页时进入）；回到前台而这一刻进入不了（状态机正在重建）是 ready（稍后进入）；再切到后台又是 visible', async () => {
    let ready = false
    const context = setup({ enter: () => ready })
    await waiting(context)
    context.page.set(true)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
    context.act()
    context.page.set(false)
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'ready' })
    context.page.set(true)
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
    ready = true
    context.page.set(false)
    expect(context.requests.progress()).toBeUndefined()
  })

  it('状态机这一刻进入不了（例如正在按新的版本重建）：留在 granted，retry 时进入', async () => {
    let ready = false
    const context = setup({ enter: () => ready })
    await waiting(context)
    context.api.renew.mockResolvedValue(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'ready' })
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
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
    context.requests.setActive(false)
    context.page.set(false)
    expect(context.enter).not.toHaveBeenCalled()
    context.requests.setActive(true)
    expect(context.enter).toHaveBeenCalledOnce()
  })
})

describe('连着的会话类失败（审查 B1：与续租的 M3-P4 复验 C1 同一个口径）', () => {
  const CSRF = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')

  /** 页面的样子：每次得知会话问题都向服务端确认（一个来回，50 毫秒），确认是本人之后告诉请求方一侧（setActive(true)，旧写法每次都这样） */
  function confirmEachTime(context: ReturnType<typeof setup>): void {
    context.onSessionProblem.mockImplementation(() => {
      context.time.clock.schedule(() => context.requests.setActive(true), 50)
    })
  }

  /** 续期的时刻（相对开始等待），续期按 outcomes 依次回答（之后都是 PENDING） */
  async function renewalsAnswering(outcomes: readonly (EditRequestOutcome | ApiError)[]) {
    const renewedAt: number[] = []
    const context = setup({ renew: async () => {
      renewedAt.push(context.time.now())
      const outcome = outcomes[renewedAt.length - 1] ?? PENDING
      if (outcome instanceof ApiError)
        throw outcome
      return outcome
    } })
    await waiting(context)
    const start = context.time.now()
    return { context, renewedAt: () => renewedAt.map(at => at - start) }
  }

  it('续期一直得到令牌失效（例如网关剥掉了 CSRF 的请求头）、页面每次确认都是本人：只有连着的第一次之后立即续期，之后按续期的节奏——不按网络往返的速度连着发', async () => {
    const { context, renewedAt } = await renewalsAnswering(Array.from<ApiError>({ length: 10 }).fill(CSRF))
    confirmEachTime(context)
    await context.time.advance(REQUEST_RENEW_MS * 4)
    // 5 秒的续期被拒、确认之后立即再续一次（5.05 秒）仍被拒；之后每次确认之后按续期的节奏：10.1、15.15 秒
    expect(renewedAt()).toEqual([5_000, 5_050, 10_100, 15_150])
    expect(context.onSessionProblem).toHaveBeenCalledTimes(4)
    expect(context.requests.progress()?.kind).toBe('waiting')
  })

  it('续期成功之后清零：之后再遇到，确认之后照样立即续期', async () => {
    const { context, renewedAt } = await renewalsAnswering([CSRF, CSRF, PENDING, CSRF])
    confirmEachTime(context)
    await context.time.advance(REQUEST_RENEW_MS * 3 + 200)
    // 第 2 次（5.05 秒）是连着的第二次，之后按节奏（10.1 秒成功，清零）；15.1 秒被拒是新的第一次，确认之后立即续期（15.15 秒）
    expect(renewedAt()).toEqual([5_000, 5_050, 10_100, 15_100, 15_150])
  })

  it('连着两次之后页面确认会话不是本人（setActive(false)：真的登出了）：清零——回到本人时立即续期（复核 D1）', async () => {
    const { context, renewedAt } = await renewalsAnswering([CSRF, CSRF])
    await context.time.advance(REQUEST_RENEW_MS)
    context.requests.setActive(true)
    await settle()
    expect(renewedAt()).toEqual([5_000, 5_000])
    context.requests.setActive(false)
    await context.time.advance(60_000)
    context.requests.setActive(true)
    await settle()
    expect(renewedAt()).toEqual([5_000, 5_000, 65_000])
  })

  it('取消得到令牌失效同样算连着的一次：之后续期又被拒，确认之后不立即续期', async () => {
    const { context, renewedAt } = await renewalsAnswering(Array.from<ApiError>({ length: 10 }).fill(CSRF))
    context.api.cancel.mockRejectedValue(CSRF)
    // 取消被拒（第一次）：回到等待、照常立即续期一次——又被拒（第二次）
    await context.requests.cancel()
    await settle()
    expect(renewedAt()).toEqual([0])
    expect(context.onSessionProblem).toHaveBeenCalledTimes(2)
    // 页面确认之后：不立即续期，按续期的节奏
    context.requests.setActive(true)
    await settle()
    expect(renewedAt()).toEqual([0])
    await context.time.advance(REQUEST_RENEW_MS)
    expect(renewedAt()).toEqual([0, REQUEST_RENEW_MS])
  })

  it('取消成功了同样清零：之后（恢复等待）再遇到会话类失败，确认之后照样立即续期', async () => {
    const { context, renewedAt } = await renewalsAnswering([CSRF, CSRF, CSRF])
    // 连着两次被拒（5 秒、确认之后立即再续的那一次）
    await context.time.advance(REQUEST_RENEW_MS)
    context.requests.setActive(true)
    await settle()
    expect(renewedAt()).toEqual([5_000, 5_000])
    // 取消成功（会话没问题）：结束；之后恢复等待（不另发出），立即续期一次又被拒——新的第一次：确认之后立即续期
    await context.requests.cancel()
    expect(context.ends).toEqual([{ kind: 'cancelled' }])
    context.requests.resume(AMY)
    await settle()
    context.requests.setActive(true)
    await settle()
    expect(renewedAt()).toEqual([5_000, 5_000, 5_000, 5_000])
  })

  it('发出成功了同样清零：撤回（不清零）之后再发出、再遇到会话类失败，确认之后照样立即续期', async () => {
    const { context, renewedAt } = await renewalsAnswering([CSRF, CSRF, CSRF])
    await context.time.advance(REQUEST_RENEW_MS)
    context.requests.setActive(true)
    await settle()
    context.requests.withdraw()
    await waiting(context)
    await context.time.advance(REQUEST_RENEW_MS)
    context.requests.setActive(true)
    await settle()
    expect(renewedAt()).toEqual([5_000, 5_000, 10_000, 10_000])
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
    expect(context.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
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

describe('这一页发出过的请求（审查 B2，issued-request.ts）', () => {
  it('发出之后在等待：记下服务端给的发出时刻；请求结束（谢绝、请求不在、取消……）时清掉', async () => {
    const context = setup()
    await waiting(context)
    expect(context.issued.read()).toEqual({ requestedAt: PENDING.kind === 'pending' ? PENDING.requestedAt : undefined })
    context.api.renew.mockResolvedValueOnce(DECLINED)
    await context.time.advance(REQUEST_RENEW_MS)
    expect(context.ends).toEqual([{ kind: 'declined', holder: AMY }])
    expect(context.issued.read()).toBeUndefined()

    const gone = setup({ renew: async () => GONE })
    await waiting(gone)
    await gone.time.advance(REQUEST_RENEW_MS)
    expect(gone.issued.read()).toBeUndefined()

    const cancelled = setup()
    await waiting(cancelled)
    await cancelled.requests.cancel()
    expect(cancelled.issued.read()).toBeUndefined()
  })

  it('发出时编辑权就交给了本页（reserved、free）：页面看得见就进入（随之清掉）；在后台时留在 granted，记号在（不带时刻），刷新之后照它恢复', async () => {
    const visible = setup({ send: async () => RESERVED })
    await visible.requests.send()
    expect(visible.enter).toHaveBeenCalledOnce()
    expect(visible.issued.read()).toBeUndefined()

    const hidden = setup({ send: async () => FREE })
    hidden.page.set(true)
    await hidden.requests.send()
    expect(hidden.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
    expect(hidden.issued.read()).toEqual({ requestedAt: undefined })
  })

  it('撤回（页面关闭）时不清：刷新时那次撤回没送到的话，刷新之后照记号恢复等待', async () => {
    const context = setup()
    await waiting(context)
    context.requests.withdraw()
    expect(context.issued.read()).toBeDefined()
  })

  it('whose：记号对得上（发出时刻相同）是这一页的；本人别的请求是别处的（清掉对不上的记号）；没有本人的请求时清掉记号；保留只认有记号的', async () => {
    const context = setup()
    const requestedAt = PENDING.kind === 'pending' ? PENDING.requestedAt : ''
    expect(context.requests.whose({ requestedAt, reserved: false }, false)).toBe('elsewhere')
    expect(context.requests.whose({ requestedAt: undefined, reserved: true }, false)).toBe('none')
    expect(context.requests.whose({ requestedAt: undefined, reserved: false }, false)).toBe('none')
    context.issued.write(requestedAt)
    expect(context.requests.whose({ requestedAt, reserved: false }, false)).toBe('here')
    expect(context.requests.whose({ requestedAt: undefined, reserved: true }, false)).toBe('here')
    expect(context.issued.read()).toBeDefined()
    expect(context.requests.whose({ requestedAt: '2026-10-07T03:09:00.000Z', reserved: false }, false)).toBe('elsewhere')
    expect(context.issued.read()).toBeUndefined()
    context.issued.write(requestedAt)
    expect(context.requests.whose({ requestedAt: undefined, reserved: false }, false)).toBe('none')
    expect(context.issued.read()).toBeUndefined()
  })

  it('whose（复验 C2）：记号对得上、而本浏览器里有页面持有"发出过请求"的锁——发出它的那一页还在，这一页是复制出来的标签页：按别处发出的回答（保留时是 none），清掉复制来的记号', async () => {
    const context = setup()
    const requestedAt = PENDING.kind === 'pending' ? PENDING.requestedAt : ''
    context.issued.write(requestedAt)
    expect(context.requests.whose({ requestedAt, reserved: false }, true)).toBe('elsewhere')
    expect(context.issued.read()).toBeUndefined()
    context.issued.write(undefined)
    expect(context.requests.whose({ requestedAt: undefined, reserved: true }, true)).toBe('none')
    expect(context.issued.read()).toBeUndefined()
  })
})

describe('"发出过请求"的锁（复验 C2：复制标签页连同记号一起复制，副本据锁认出原来那页还在）', () => {
  it('发出之后在等待：共享地持有它；请求结束（谢绝、请求不在、取消、空闲取消……）时放开', async () => {
    const context = setup()
    await waiting(context)
    await settle()
    expect(context.issuers()).toEqual(['this'])
    context.api.renew.mockResolvedValueOnce(DECLINED)
    await context.time.advance(REQUEST_RENEW_MS)
    await settle()
    expect(context.issuers()).toEqual([])

    const cancelled = setup()
    await waiting(cancelled)
    await cancelled.requests.cancel()
    await settle()
    expect(cancelled.issuers()).toEqual([])

    const idle = setup()
    await waiting(idle)
    await idle.time.advance(REQUEST_IDLE_MS)
    await settle()
    expect(idle.ends).toEqual([{ kind: 'idle' }])
    expect(idle.issuers()).toEqual([])
  })

  it('取消没成、回到等待时照旧持有；进入编辑（编辑权交给了本页、看得见）时放开', async () => {
    const context = setup({ cancel: async () => Promise.reject(new NetworkError('断网')) })
    await waiting(context)
    await context.requests.cancel()
    await settle()
    expect(context.requests.progress()).toMatchObject({ kind: 'waiting' })
    expect(context.issuers()).toEqual(['this'])
    context.api.renew.mockResolvedValueOnce(RESERVED)
    await context.time.advance(REQUEST_RENEW_MS)
    await settle()
    expect(context.enter).toHaveBeenCalledOnce()
    expect(context.issuers()).toEqual([])
  })

  it('发出时编辑权就交给了本页：看得见、随即进入的不留着锁（拿到时已经放开）；在后台、留在 granted 的持有它，回到前台进入时放开', async () => {
    const visible = setup({ send: async () => RESERVED })
    await visible.requests.send()
    await settle()
    expect(visible.enter).toHaveBeenCalledOnce()
    expect(visible.issuers()).toEqual([])

    const hidden = setup({ send: async () => FREE })
    hidden.page.set(true)
    await hidden.requests.send()
    await settle()
    expect(hidden.requests.progress()).toEqual({ kind: 'granted', until: 'visible' })
    expect(hidden.issuers()).toEqual(['this'])
    hidden.page.set(false)
    await settle()
    expect(hidden.enter).toHaveBeenCalledOnce()
    expect(hidden.issuers()).toEqual([])
  })

  it('恢复等待时持有它；撤回（页面关闭、编辑器建不起来）、停下（卸载）时放开——记号照旧留着（刷新之后照它恢复，原来那页的锁那时已经放开）', async () => {
    const context = setup()
    context.issued.write(PENDING.kind === 'pending' ? PENDING.requestedAt : '')
    context.requests.resume(AMY)
    await settle()
    expect(context.issuers()).toEqual(['this'])
    context.requests.withdraw()
    await settle()
    expect(context.issuers()).toEqual([])
    expect(context.issued.read()).toBeDefined()

    const disposed = setup()
    await waiting(disposed)
    await settle()
    disposed.requests.dispose()
    await settle()
    expect(disposed.issuers()).toEqual([])
  })

  it('拿锁还没回来时请求就结束了（或者停下了）：之后才拿到的锁随即放开，不留着', async () => {
    const granted = deferred<HeldLock>()
    const release = vi.fn()
    const context = setup({ issuerLock: async () => granted.promise })
    await waiting(context)
    await context.requests.cancel()
    expect(context.ends).toEqual([{ kind: 'cancelled' }])
    granted.resolve({ release, stolen: new Promise<void>(() => {}) })
    await settle()
    expect(release).toHaveBeenCalledOnce()

    const late = deferred<HeldLock>()
    const releaseLate = vi.fn()
    const disposed = setup({ issuerLock: async () => late.promise })
    await waiting(disposed)
    disposed.requests.dispose()
    late.resolve({ release: releaseLate, stolen: new Promise<void>(() => {}) })
    await settle()
    expect(releaseLate).toHaveBeenCalledOnce()
  })

  it('锁是共享的：同一个浏览器里另一个标签页也发出过（两页都点了"请求编辑"）时两页同时持有；一页结束不影响另一页', async () => {
    const context = setup()
    const other = sameBrowserFor(DOCUMENT_ID, context.browser.tab('other'))
    const held = await other.holdIssuedRequest()
    await waiting(context)
    await settle()
    expect(context.issuers()).toEqual(['other', 'this'])
    await context.requests.cancel()
    await settle()
    expect(context.issuers()).toEqual(['other'])
    held.release()
    await settle()
    expect(context.issuers()).toEqual([])
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

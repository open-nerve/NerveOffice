import type { HandedOverEditLease, PendingEditRequest, UserSummary } from '@nerve-office/contracts'
import type { EditLease, EditLeaseApi, LeaseOutcome } from './edit-lease.ts'
import type { HolderRequestsOptions } from './holder-requests.ts'
import { EDIT_HANDOVER_IDLE_SECONDS, EDIT_LEASE_HEARTBEAT_SECONDS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { createHolderRequests } from './holder-requests.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const BEN: UserSummary = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e2', username: 'ben', displayName: '本' }
const CAT: UserSummary = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e3', username: 'cat', displayName: '凯特' }
const REQUEST: PendingEditRequest = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f1', requester: BEN, requestedAt: '2026-10-07T03:01:00.000Z' }
const OTHER: PendingEditRequest = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f2', requester: CAT, requestedAt: '2026-10-07T03:02:00.000Z' }
const SHOWN = { id: REQUEST.id, requester: BEN, declining: false, failure: undefined }
const HANDOVER_MS = EDIT_HANDOVER_IDLE_SECONDS * 1000
const HEARTBEAT_MS = EDIT_LEASE_HEARTBEAT_SECONDS * 1000
const TOKEN = 'L'.repeat(43)
const NEXT_TOKEN = 'M'.repeat(43)
const HANDED_OVER: HandedOverEditLease = { reservedFor: BEN, reservedUntil: '2026-10-07T03:05:00.000Z' }

/** 编辑权失效（EDIT_LEASE_LOST，原因） */
function lostError(reason: string): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason } })
}

/** 由测试决定何时完成的 Promise */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

/** 假的编辑租约：现在的令牌；别的请求得知失效时（lose）按 outcome 回答，续上了就换成下一代的令牌 */
function fakeLease(outcome: LeaseOutcome = { kind: 'lost' }) {
  let token = TOKEN
  const lease: EditLease = {
    credentials: () => ({ token, writeEpoch: 7 }),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    lose: vi.fn(async () => {
      if (outcome.kind === 'held')
        token = NEXT_TOKEN
      return outcome
    }),
    noteActivity: vi.fn(),
    holdRecovery: vi.fn(),
    allowRecovery: vi.fn(),
    abandon: vi.fn(),
    release: vi.fn(async () => true),
  }
  return lease
}

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
})

interface Setup {
  readonly handOver?: EditLeaseApi['handOver']
  readonly decline?: EditLeaseApi['decline']
}

/** 持有者这一侧：编辑中、会话可写（都可设），最后一次操作停在开始的那一刻（act 记下一次），进入编辑也在那一刻 */
function setup(options: Setup = {}) {
  const time = fakeLeaseClock()
  let hidden = false
  const visibilityListeners = new Set<() => void>()
  const state = { editing: true, writable: true, lastActive: time.now(), since: time.now() }
  const api = {
    handOver: vi.fn<EditLeaseApi['handOver']>(options.handOver ?? (async () => HANDED_OVER)),
    decline: vi.fn<EditLeaseApi['decline']>(options.decline ?? (async () => {})),
  }
  const handOver = vi.fn()
  const onChange = vi.fn()
  const onSessionProblem = vi.fn<HolderRequestsOptions['onSessionProblem']>()
  const holder = createHolderRequests({
    documentId: DOCUMENT_ID,
    api,
    clock: time.clock,
    visibility: {
      hidden: () => hidden,
      onChange: (listener) => {
        visibilityListeners.add(listener)
        return () => visibilityListeners.delete(listener)
      },
    },
    lastActivity: () => state.lastActive,
    editingSince: () => state.since,
    editing: () => state.editing,
    writable: () => state.writable,
    handOver,
    onChange,
    onSessionProblem,
  })
  disposers.push(holder.dispose)
  return {
    holder,
    time,
    api,
    handOver,
    onChange,
    onSessionProblem,
    state,
    act: () => {
      state.lastActive = time.now()
    },
    setHidden: (next: boolean) => {
      hidden = next
      visibilityListeners.forEach(listener => listener())
    },
  }
}

describe('请求到了（arrive）', () => {
  it('编辑时、本页有操作（不满 2 分钟）：记下、显示提示（onChange），不交出；同一个请求再到不重复处理', () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    expect(context.holder.incoming()).toEqual(SHOWN)
    expect(context.holder.offer()).toEqual(SHOWN)
    expect(context.onChange).toHaveBeenCalledOnce()
    expect(context.handOver).not.toHaveBeenCalled()
    context.holder.arrive(REQUEST)
    expect(context.onChange).toHaveBeenCalledOnce()
  })

  it('编辑时已空闲满 2 分钟、会话可写、联网：随即交出（不显示提示）；会话不可写时只显示提示', async () => {
    const context = setup()
    await context.time.advance(HANDOVER_MS)
    context.holder.arrive(REQUEST)
    expect(context.handOver).toHaveBeenCalledOnce()
    expect(context.onChange).not.toHaveBeenCalled()

    const unwritable = setup()
    unwritable.state.writable = false
    await unwritable.time.advance(HANDOVER_MS)
    unwritable.holder.arrive(REQUEST)
    expect(unwritable.handOver).not.toHaveBeenCalled()
    expect(unwritable.onChange).toHaveBeenCalledOnce()
  })

  it('提示在的时候：从进入编辑与最后一次操作中较晚的那个起满 2 分钟就交出；其间有操作就重新算', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    await context.time.advance(60_000)
    context.act()
    await context.time.advance(HANDOVER_MS - 1)
    expect(context.handOver).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.handOver).toHaveBeenCalledOnce()
  })

  it('到了 2 分钟而会话不可写、没联网：这一轮不交出，过一个心跳周期再看；不在编辑（离开中）、正在谢绝时不交出', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    context.state.writable = false
    await context.time.advance(HANDOVER_MS)
    expect(context.handOver).not.toHaveBeenCalled()
    context.state.writable = true
    await context.time.advance(HEARTBEAT_MS - 1)
    expect(context.handOver).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.handOver).toHaveBeenCalledOnce()
  })

  it('回到前台时（Safari 隐藏之后计时器停止）按隐藏之前的操作算：满 2 分钟就在可见性的通知里交出', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    context.setHidden(true)
    context.time.elapse(HANDOVER_MS)
    context.setHidden(false)
    expect(context.handOver).toHaveBeenCalledOnce()
  })

  it('不在编辑（进入、离开编辑的过程中）只记下；进入编辑之后（entered）按编辑时的规则处理', async () => {
    const context = setup()
    context.state.editing = false
    context.holder.arrive(REQUEST)
    expect(context.holder.incoming()).toEqual(SHOWN)
    expect(context.onChange).not.toHaveBeenCalled()
    context.state.editing = true
    context.holder.entered()
    expect(context.onChange).toHaveBeenCalledOnce()
    await context.time.advance(HANDOVER_MS)
    expect(context.handOver).toHaveBeenCalledOnce()
  })

  it('请求不在了（null）：提示消失、说明请求方取消了，计时随之停下；正在谢绝时不管', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    context.holder.arrive(null)
    expect(context.holder.incoming()).toBeUndefined()
    expect(context.holder.notice()).toEqual({ kind: 'request-withdrawn', requester: BEN })
    expect(context.onChange).toHaveBeenCalledTimes(2)
    await context.time.advance(HANDOVER_MS * 2)
    expect(context.handOver).not.toHaveBeenCalled()
    // 新的请求到了：说明随之去掉
    context.holder.arrive(OTHER)
    expect(context.holder.notice()).toBeUndefined()

    const declining = setup({ decline: async () => new Promise<void>(() => {}) })
    declining.holder.arrive(REQUEST)
    void declining.holder.decline(fakeLease())
    declining.holder.arrive(null)
    expect(declining.holder.incoming()).toMatchObject({ id: REQUEST.id, declining: true })
    expect(declining.holder.notice()).toBeUndefined()
  })
})

describe('谢绝（"继续编辑"）', () => {
  it('谢绝中按钮不可用（declining）、不算要交给的请求；成了提示消失、计时停下，谢绝之前发出的心跳迟到时不再显示它', async () => {
    const reply = deferred<void>()
    const context = setup({ decline: async () => reply.promise })
    context.holder.arrive(REQUEST)
    const declining = context.holder.decline(fakeLease())
    expect(context.holder.incoming()).toEqual({ ...SHOWN, declining: true })
    expect(context.holder.offer()).toBeUndefined()
    expect(context.api.decline).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST.id)
    reply.resolve()
    await declining
    expect(context.holder.incoming()).toBeUndefined()
    context.holder.arrive(REQUEST)
    expect(context.holder.incoming()).toBeUndefined()
    await context.time.advance(HANDOVER_MS * 2)
    expect(context.handOver).not.toHaveBeenCalled()
    // 换了一代（reset）：刚谢绝的那个不再记着
    context.holder.reset()
    context.holder.arrive(REQUEST)
    expect(context.holder.incoming()).toEqual(SHOWN)
  })

  it('没成（网络）：请求照旧在，记下原因；会话类失败另交给页面确认会话', async () => {
    const context = setup({ decline: async () => Promise.reject(new NetworkError('断网')) })
    context.holder.arrive(REQUEST)
    await context.holder.decline(fakeLease())
    expect(context.holder.incoming()).toMatchObject({ declining: false, failure: { action: 'decline', error: expect.any(NetworkError) as unknown } })
    expect(context.onSessionProblem).not.toHaveBeenCalled()

    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const session = setup({ decline: async () => Promise.reject(csrf) })
    session.holder.arrive(REQUEST)
    await session.holder.decline(fakeLease())
    expect(session.onSessionProblem).toHaveBeenCalledExactlyOnceWith(csrf)
    expect(session.holder.incoming()).toMatchObject({ failure: { action: 'decline', error: csrf } })
  })

  it('得知这一代失效：交给编辑租约（续上了就用新的令牌再谢绝一次，至多一次；失效了按没成）', async () => {
    const decline = vi.fn<EditLeaseApi['decline']>().mockRejectedValueOnce(lostError('expired')).mockResolvedValue()
    const context = setup({ decline })
    context.holder.arrive(REQUEST)
    const lease = fakeLease({ kind: 'held' })
    await context.holder.decline(lease)
    expect(lease.lose).toHaveBeenCalledOnce()
    expect(decline.mock.calls.map(call => call[1])).toEqual([TOKEN, NEXT_TOKEN])
    expect(context.holder.incoming()).toBeUndefined()

    const lost = setup({ decline: async () => Promise.reject(lostError('revoked')) })
    lost.holder.arrive(REQUEST)
    await lost.holder.decline(fakeLease({ kind: 'lost' }))
    expect(lost.api.decline).toHaveBeenCalledOnce()
    expect(lost.holder.incoming()).toMatchObject({ failure: { action: 'decline' } })
  })

  it('没有请求、正在谢绝时什么也不做', async () => {
    const context = setup()
    await context.holder.decline(fakeLease())
    expect(context.api.decline).not.toHaveBeenCalled()
  })
})

describe('交出的结果（handOver）', () => {
  it.each([
    ['200', async (): Promise<HandedOverEditLease> => HANDED_OVER, { kind: 'handed' }],
    ['请求已经不在（EDIT_REQUEST_GONE）', async (): Promise<HandedOverEditLease> => Promise.reject(new ApiError(409, 'EDIT_REQUEST_GONE', '请求已不在')), { kind: 'gone' }],
    ['回包丢了的重试（handed_over）', async (): Promise<HandedOverEditLease> => Promise.reject(lostError('handed_over')), { kind: 'handed' }],
    ['请求方已经接手（replaced）', async (): Promise<HandedOverEditLease> => Promise.reject(lostError('replaced')), { kind: 'handed' }],
    ['这一代因为别的原因失效', async (): Promise<HandedOverEditLease> => Promise.reject(lostError('revoked')), { kind: 'lost', loss: { kind: 'lease', reason: 'revoked' } }],
  ] as const)('%s', async (_case, handOver, expected) => {
    const context = setup({ handOver })
    context.holder.arrive(REQUEST)
    const request = context.holder.offer()
    if (request === undefined)
      throw new Error('没有请求')
    expect(await context.holder.handOver(fakeLease(), request, context.time.now() + 5_000)).toEqual(expected)
    expect(context.api.handOver).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST.id)
  })

  it('没有结果：网络、会话的问题（另交给页面确认会话）、到了时限都算 failed', async () => {
    const unauthenticated = new ApiError(401, 'UNAUTHENTICATED', '请先登录')
    const context = setup({ handOver: async () => Promise.reject(unauthenticated) })
    context.holder.arrive(REQUEST)
    expect(await context.holder.handOver(fakeLease(), SHOWN, context.time.now() + 5_000)).toEqual({ kind: 'failed', error: unauthenticated })
    expect(context.onSessionProblem).toHaveBeenCalledExactlyOnceWith(unauthenticated)

    const hanging = setup({ handOver: async () => new Promise<HandedOverEditLease>(() => {}) })
    const handing = hanging.holder.handOver(fakeLease(), SHOWN, hanging.time.now() + 5_000)
    await hanging.time.advance(5_000)
    expect(await handing).toEqual({ kind: 'failed', error: expect.any(NetworkError) as unknown })
  })
})

describe('离开编辑时', () => {
  it('开始离开（leaving）：计时停下，离开期间不到点；交出时请求已经不在（withdrawn）：去掉、说明一句；没有结果（failed）：记下原因、请求照旧在', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    context.holder.leaving()
    await context.time.advance(HANDOVER_MS * 2)
    expect(context.handOver).not.toHaveBeenCalled()
    const error = new NetworkError('断网')
    context.holder.failed(SHOWN, error)
    expect(context.holder.incoming()).toEqual({ ...SHOWN, failure: { action: 'handover', error } })
    context.holder.withdrawn(SHOWN)
    expect(context.holder.incoming()).toBeUndefined()
    expect(context.holder.notice()).toEqual({ kind: 'request-withdrawn', requester: BEN })
  })

  it('留在编辑（stayed）：不是自动交出的照截止时刻接着计时；自动交出没成的过一个心跳周期再看，再也存不上的不再试', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    context.holder.leaving()
    await context.time.advance(HANDOVER_MS)
    context.holder.stayed({ automatic: false, ended: false })
    await settle()
    await context.time.advance(0)
    expect(context.handOver).toHaveBeenCalledOnce()

    const automatic = setup()
    automatic.holder.arrive(REQUEST)
    await automatic.time.advance(HANDOVER_MS)
    expect(automatic.handOver).toHaveBeenCalledOnce()
    automatic.holder.leaving()
    automatic.holder.stayed({ automatic: true, ended: false })
    await automatic.time.advance(HEARTBEAT_MS - 1)
    expect(automatic.handOver).toHaveBeenCalledOnce()
    await automatic.time.advance(1)
    expect(automatic.handOver).toHaveBeenCalledTimes(2)

    const ended = setup()
    ended.holder.arrive(REQUEST)
    await ended.time.advance(HANDOVER_MS)
    ended.holder.leaving()
    ended.holder.stayed({ automatic: true, ended: true })
    await ended.time.advance(HANDOVER_MS * 3)
    expect(ended.handOver).toHaveBeenCalledOnce()
  })

  it('离开的过程中才到的请求（只记下、没有计时），留在编辑时按请求刚到处理（审查 B3）：显示提示、开始计时，满 2 分钟交出；那一刻已空闲满 2 分钟就随即交出', async () => {
    const context = setup()
    context.state.editing = false
    context.holder.leaving()
    context.holder.arrive(REQUEST)
    expect(context.onChange).not.toHaveBeenCalled()
    context.state.editing = true
    context.holder.stayed({ automatic: false, ended: false })
    expect(context.onChange).toHaveBeenCalledOnce()
    expect(context.handOver).not.toHaveBeenCalled()
    await context.time.advance(HANDOVER_MS)
    expect(context.handOver).toHaveBeenCalledOnce()

    const idle = setup()
    await idle.time.advance(HANDOVER_MS)
    idle.state.editing = false
    idle.holder.leaving()
    idle.holder.arrive(REQUEST)
    idle.state.editing = true
    idle.holder.stayed({ automatic: false, ended: false })
    expect(idle.handOver).toHaveBeenCalledOnce()
  })

  it('离开了、失去编辑权（clear）：请求、说明与计时都清掉；卸载之后（dispose）不再回调', async () => {
    const context = setup()
    context.holder.arrive(REQUEST)
    context.holder.clear()
    expect(context.holder.incoming()).toBeUndefined()
    expect(context.holder.notice()).toBeUndefined()
    await context.time.advance(HANDOVER_MS * 2)
    expect(context.handOver).not.toHaveBeenCalled()

    const disposed = setup()
    disposed.holder.dispose()
    disposed.holder.arrive(REQUEST)
    expect(disposed.holder.incoming()).toBeUndefined()
    expect(disposed.onChange).not.toHaveBeenCalled()
  })
})

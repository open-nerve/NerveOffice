import type { AcquireIntent } from './edit-lease.ts'
import type { HandoverTraceEvent } from './handover-trace.ts'
import type { PendingSave, PendingSaveMarker } from './pending-save-marker.ts'
import type { HandoverMessage } from './same-browser.ts'
import type { TabAnswerPhase, TakeoverProgress } from './tab-handover.ts'
import { EDIT_PENDING_SAVE_WAIT_MS, EDIT_TAB_HANDOVER_ACK_MS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { onReply, sameBrowserFor } from './same-browser.ts'
import { PENDING_SAVE_POLL_MS } from './self-takeover.ts'
import { answerTabs, handoverFailureOf, takeOverHere } from './tab-handover.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const TAB_A = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TAB_B = '0199a2c4-1f2e-4a3b-8c4d-00000000bbbb'
const AMY = '0199a2c4-1f2e-7a3b-8c4d-0000000000e1'
const BEN = '0199a2c4-1f2e-7a3b-8c4d-0000000000e2'
const REQUEST_ID = '0199a2c4-1f2e-4a3b-8c4d-000000000001'
/** 墙上时间（记号按它比较） */
const WALL = Date.UTC(2026, 9, 7, 3, 0, 0)

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
})

describe('没能交出的原因（handoverFailureOf）', () => {
  it('版本冲突先于别的；轮到上传时会话已经变差（skipped 的 session）或者现在会话不可写是会话不对；别的都是没存上', () => {
    expect(handoverFailureOf('conflict', undefined, false)).toBe('conflict')
    expect(handoverFailureOf('failed', { edits: false, formulas: false, outcome: { kind: 'skipped', reason: 'session' } }, true)).toBe('session')
    expect(handoverFailureOf('dirty', undefined, false)).toBe('session')
    expect(handoverFailureOf('failed', { edits: false, formulas: false, outcome: { kind: 'skipped', reason: 'stopped' } }, true)).toBe('not-saved')
    expect(handoverFailureOf('dirty', undefined, true)).toBe('not-saved')
  })
})

/** 回应的一侧：A（被测，持有锁与否、在做什么可设）与发请求的 B（同一个浏览器里的另一个标签页） */
function answering() {
  const browser = fakeBrowser()
  const time = fakeLeaseClock()
  const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
  const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
  const state: { holding: boolean, phase: TabAnswerPhase } = { holding: true, phase: 'editing' }
  const leave = vi.fn()
  const events: HandoverTraceEvent[] = []
  const tabs = answerTabs({
    browser: a,
    clientInstanceId: TAB_A,
    userId: AMY,
    clock: time.clock,
    holdsLock: () => state.holding,
    phase: () => state.phase,
    leave,
    trace: event => events.push(event),
  })
  disposers.push(tabs.dispose, a.close, b.close)
  const replies: HandoverMessage[] = []
  onReply(b, REQUEST_ID, reply => replies.push(reply))
  /** B 发一次交接请求（userId 默认是同一个人），等它送到、A 回应送回来 */
  const ask = async (userId = AMY): Promise<void> => {
    b.post({ type: 'handover-request', requestId: REQUEST_ID, documentId: DOCUMENT_ID, from: TAB_B, userId })
    await settle()
    await settle()
  }
  return { browser, tabs, state, leave, events, replies, ask }
}

describe('回应交接请求（answerTabs）', () => {
  it('编辑时：在消息的处理里同步回 ack（editing），随即请状态机离开编辑；离开有了结果时告诉它（done）', async () => {
    const context = answering()
    await context.ask()
    expect(context.replies).toEqual([{ type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'editing' }])
    expect(context.leave).toHaveBeenCalledOnce()
    context.tabs.finish({ kind: 'done' })
    await settle()
    expect(context.replies.at(-1)).toEqual({ type: 'handover-done', requestId: REQUEST_ID, from: TAB_A })
    // 已经告诉过了：再有结果不再发
    context.tabs.finish({ kind: 'done' })
    await settle()
    expect(context.replies).toHaveLength(2)
    expect(context.events.map(event => event.kind)).toEqual(['handover-answer', 'handover-finish'])
  })

  it('正在离开编辑时回 ack（exiting）、不再请它离开；没离开成时告诉它原因（failed）', async () => {
    const context = answering()
    context.state.phase = 'exiting'
    await context.ask()
    expect(context.replies).toEqual([{ type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'exiting' }])
    expect(context.leave).not.toHaveBeenCalled()
    context.tabs.finish({ kind: 'failed', reason: 'conflict' })
    await settle()
    expect(context.replies.at(-1)).toEqual({ type: 'handover-failed', requestId: REQUEST_ID, from: TAB_A, reason: 'conflict' })
  })

  it('正在进入编辑时回 busy（那边稍后再请求），不记下；离开的途中失去编辑权（forget）之后不再告诉它们', async () => {
    const context = answering()
    context.state.phase = 'entering'
    await context.ask()
    expect(context.replies).toEqual([{ type: 'handover-busy', requestId: REQUEST_ID, from: TAB_A }])
    context.tabs.finish({ kind: 'done' })
    await settle()
    expect(context.replies).toHaveLength(1)

    const forgotten = answering()
    await forgotten.ask()
    forgotten.tabs.forget()
    forgotten.tabs.finish({ kind: 'done' })
    await settle()
    expect(forgotten.replies).toHaveLength(1)
  })

  it('别人的请求、本页不再持有锁（被抢之后迟到的）、不在编辑、卸载之后：一律不理', async () => {
    const other = answering()
    await other.ask(BEN)
    const notHolding = answering()
    notHolding.state.holding = false
    await notHolding.ask()
    const reading = answering()
    reading.state.phase = 'none'
    await reading.ask()
    const disposed = answering()
    disposed.tabs.dispose()
    await disposed.ask()
    for (const context of [other, notHolding, reading, disposed]) {
      expect(context.replies).toEqual([])
      expect(context.leave).not.toHaveBeenCalled()
    }
  })
})

/** 记号（刷新时在途的保存）：读出什么由用例给出 */
function fakeMarker() {
  return { write: vi.fn<PendingSaveMarker['write']>(), read: vi.fn<PendingSaveMarker['read']>(() => undefined), clear: vi.fn<PendingSaveMarker['clear']>() }
}

/**
 * 接手的一侧：B（被测）与同一个浏览器里正在编辑的 A（持有锁与否可设；回应由用例给出）。enter 交回进入了没有（默认进入了），记下申请的方式
 */
async function takingOver(options: { readonly holdingA?: boolean, readonly anyway?: boolean, readonly entered?: boolean, readonly marker?: PendingSave } = {}) {
  const browser = fakeBrowser()
  const time = fakeLeaseClock()
  const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
  const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
  disposers.push(a.close, b.close)
  const lock = options.holdingA === false ? undefined : await a.tryHold()
  const requests: string[] = []
  a.subscribe((message) => {
    if (message.type === 'handover-request')
      requests.push(message.requestId)
  })
  const marker = fakeMarker()
  marker.read.mockReturnValue(options.marker)
  const progress: TakeoverProgress[] = []
  const enters: { readonly intent: AcquireIntent, readonly selfAfterHeld: boolean }[] = []
  const state = { still: true }
  const abort = new AbortController()
  let revision = 3
  let id = 0
  const done = takeOverHere({
    browser: b,
    clock: time.clock,
    documentId: DOCUMENT_ID,
    clientInstanceId: TAB_B,
    userId: AMY,
    newId: () => `0199a2c4-1f2e-4a3b-8c4d-${String(++id).padStart(12, '0')}`,
    pendingSave: marker,
    wallNow: () => WALL,
    revision: async () => revision,
    anyway: options.anyway ?? false,
    signal: abort.signal,
    still: () => state.still,
    progress: next => progress.push(next),
    enter: async (intent, selfAfterHeld) => {
      enters.push({ intent, selfAfterHeld })
      return options.entered ?? true
    },
  })
  let finished = false
  void done.then(() => {
    finished = true
  })
  // 看锁、发出、送到（频道在下一个宏任务里送到）：之后 requests 里就有这一次的请求
  await settle()
  await settle()
  return {
    time,
    a,
    lock,
    marker,
    progress,
    enters,
    state,
    abort,
    requests,
    done,
    finished: () => finished,
    setRevision: (next: number) => {
      revision = next
    },
    /** A 回应最近的那一次请求 */
    reply: (message: { readonly type: 'handover-ack', readonly state: 'editing' | 'exiting' } | { readonly type: 'handover-done' } | { readonly type: 'handover-failed', readonly reason: 'not-saved' | 'conflict' | 'session' }) => {
      a.post({ ...message, requestId: requests.at(-1) ?? '', from: TAB_A })
    },
  }
}

describe('"在此编辑"的编排（takeOverHere）', () => {
  it('锁在本浏览器里没人持有：不发交接请求，看过记号之后以本人接管申请；进入了就清掉记号', async () => {
    const context = await takingOver({ holdingA: false })
    await context.done
    expect(context.requests).toEqual([])
    expect(context.enters).toEqual([{ intent: { takeover: 'self' }, selfAfterHeld: false }])
    expect(context.marker.read).toHaveBeenCalledOnce()
    expect(context.marker.clear).toHaveBeenCalledOnce()
  })

  it('记号在 30 秒内：先说在等、每 2 秒读一次编辑状态，修订号比记号里的新了才申请；没进入成时不清记号', async () => {
    const context = await takingOver({ holdingA: false, marker: { at: WALL - 1_000, revision: 3 }, entered: false })
    await settle()
    expect(context.progress).toEqual([{ kind: 'waiting-save' }])
    await context.time.advance(PENDING_SAVE_POLL_MS * 2)
    expect(context.enters).toEqual([])
    context.setRevision(4)
    await context.time.advance(PENDING_SAVE_POLL_MS)
    await context.done
    expect(context.enters).toEqual([{ intent: { takeover: 'self' }, selfAfterHeld: false }])
    expect(context.marker.clear).not.toHaveBeenCalled()

    // 记号已经过了 30 秒：不等
    const stale = await takingOver({ holdingA: false, marker: { at: WALL - EDIT_PENDING_SAVE_WAIT_MS, revision: 3 } })
    await stale.done
    expect(stale.progress).toEqual([])
    expect(stale.enters).toHaveLength(1)
  })

  it('锁被本浏览器的标签页持有：说正在请它交出；它回应、做完了（锁空了）——看过记号之后普通申请（不再试，被自己占着时改以本人接管）', async () => {
    const context = await takingOver()
    await settle()
    expect(context.progress).toEqual([{ kind: 'asking' }])
    expect(context.requests).toHaveLength(1)
    context.reply({ type: 'handover-ack', state: 'editing' })
    await settle()
    expect(context.enters).toEqual([])
    context.lock?.release()
    await context.done
    expect(context.enters).toHaveLength(1)
    expect(context.enters[0]?.selfAfterHeld).toBe(true)
    expect(context.enters[0]?.intent.takeover).toBeUndefined()
    expect(await context.enters[0]?.intent.retrySameUser?.()).toBe(false)
    expect(context.marker.clear).toHaveBeenCalledOnce()
  })

  it('它没有回应（3 秒）：本人接管，不看记号', async () => {
    const context = await takingOver()
    await settle()
    await context.time.advance(EDIT_TAB_HANDOVER_ACK_MS)
    await context.done
    expect(context.enters).toEqual([{ intent: { takeover: 'self' }, selfAfterHeld: false }])
    expect(context.marker.read).not.toHaveBeenCalled()
  })

  it('它没能保存（failed）：把原因交给进展、不申请；之后"仍在此编辑"（anyway）直接本人接管，不看锁、不发请求', async () => {
    const context = await takingOver()
    await settle()
    context.reply({ type: 'handover-failed', reason: 'not-saved' })
    await context.done
    expect(context.progress).toEqual([{ kind: 'asking' }, { kind: 'failed', reason: 'not-saved' }])
    expect(context.enters).toEqual([])

    const anyway = await takingOver({ anyway: true })
    await anyway.done
    expect(anyway.requests).toEqual([])
    expect(anyway.enters).toEqual([{ intent: { takeover: 'self' }, selfAfterHeld: false }])
  })

  it('这一次接手作废了（状态机开始了别的事）、撤销（取消、卸载）：不再往下走、不申请', async () => {
    const stale = await takingOver()
    stale.state.still = false
    await settle()
    stale.reply({ type: 'handover-done' })
    await stale.done
    expect(stale.enters).toEqual([])

    const aborted = await takingOver()
    await settle()
    aborted.abort.abort()
    await aborted.done
    expect(aborted.enters).toEqual([])
    expect(aborted.finished()).toBe(true)
  })
})

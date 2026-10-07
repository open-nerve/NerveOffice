import type { PendingSave } from './pending-save-marker.ts'
import type { HandoverMessage, SameBrowser } from './same-browser.ts'
import type { TabHandoverOutcome } from './self-takeover.ts'
import { EDIT_PENDING_SAVE_WAIT_MS, EDIT_TAB_HANDOVER_ACK_MS, EDIT_TAB_HANDOVER_DONE_MS } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { lockNameOf, onRequest, sameBrowserFor } from './same-browser.ts'
import { askTabToHandOver, awaitPendingSave, PENDING_SAVE_POLL_MS, TAB_HANDOVER_BUSY_RETRY_MS } from './self-takeover.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const TAB_A = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TAB_B = '0199a2c4-1f2e-4a3b-8c4d-00000000bbbb'
const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000e1'
const LOCK = lockNameOf(DOCUMENT_ID)

type HandoverRequest = Extract<HandoverMessage, { readonly type: 'handover-request' }>

/**
 * 同一个浏览器里的两个标签页：A 正在编辑（持有本机锁，收得到请求，回应由用例决定），B 请 A 交出（被测的一侧）。
 * 时间是假的：时限只在 advance 时到点
 */
async function twoTabs() {
  const browser = fakeBrowser()
  const time = fakeLeaseClock()
  const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
  const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
  const lock = await a.tryHold()
  if (lock === undefined)
    throw new Error('A 没拿到锁')
  const requests: HandoverRequest[] = []
  onRequest(a, request => requests.push(request))
  let id = 0
  const abort = new AbortController()
  let outcome: TabHandoverOutcome | undefined
  const asked = askTabToHandOver({ browser: b, clock: time.clock, documentId: DOCUMENT_ID, from: TAB_B, userId: USER_ID, newId: () => `0199a2c4-1f2e-4a3b-8c4d-${String(++id).padStart(12, '0')}`, signal: abort.signal })
  void asked.then((result) => {
    outcome = result
  })
  await settle()
  /** A 回应最近的那一次请求 */
  const reply = (message: { readonly type: 'handover-ack', readonly state: 'editing' | 'exiting' } | { readonly type: 'handover-busy' | 'handover-done' } | { readonly type: 'handover-failed', readonly reason: 'not-saved' | 'conflict' | 'session' }, requestId = requests.at(-1)?.requestId ?? ''): void => {
    a.post({ ...message, requestId, from: TAB_A })
  }
  return { browser, time, a, b, lock, requests, reply, abort, asked, outcome: () => outcome }
}

describe('请正在编辑的标签页交出（M3-P5 设计 §3.7，交接协议的请求方一侧）', () => {
  it('发出请求：带文档、本页与用户的标识；那边回应 ack 之后先保存，存上、释放、放锁——锁空了才算做完（不在回应时就往下走）', async () => {
    const tabs = await twoTabs()
    expect(tabs.requests).toEqual([{ type: 'handover-request', requestId: '0199a2c4-1f2e-4a3b-8c4d-000000000001', documentId: DOCUMENT_ID, from: TAB_B, userId: USER_ID }])
    tabs.reply({ type: 'handover-ack', state: 'editing' })
    await tabs.time.advance(EDIT_TAB_HANDOVER_DONE_MS - 1)
    expect(tabs.outcome()).toBeUndefined()
    tabs.lock.release()
    await settle()
    expect(tabs.outcome()).toEqual({ kind: 'finished' })
    // 只当信号：B 没有占着锁
    expect(tabs.browser.holderOf(LOCK)).toBeUndefined()
    expect(tabs.time.pending()).toBe(0)
  })

  it('done 与锁空了两种先后都只做完一次：先收到 done（锁还没轮到本页）也算做完；之后锁空了不再算', async () => {
    const doneFirst = await twoTabs()
    doneFirst.reply({ type: 'handover-ack', state: 'editing' })
    doneFirst.reply({ type: 'handover-done' })
    await settle()
    expect(doneFirst.outcome()).toEqual({ kind: 'finished' })
    // 不再等锁：之后锁空了，本页不会排到、也不占着
    doneFirst.lock.release()
    await settle()
    expect(doneFirst.browser.holderOf(LOCK)).toBeUndefined()

    const lockFirst = await twoTabs()
    lockFirst.reply({ type: 'handover-ack', state: 'editing' })
    await settle()
    lockFirst.lock.release()
    await settle()
    expect(lockFirst.outcome()).toEqual({ kind: 'finished' })
    lockFirst.reply({ type: 'handover-done' })
    await settle()
    expect(await lockFirst.asked).toEqual({ kind: 'finished' })
  })

  it('那边没能保存（failed）：交回原因；不再等锁——之后锁空了本页也不排到', async () => {
    const tabs = await twoTabs()
    tabs.reply({ type: 'handover-ack', state: 'editing' })
    tabs.reply({ type: 'handover-failed', reason: 'conflict' })
    await settle()
    expect(tabs.outcome()).toEqual({ kind: 'failed', reason: 'conflict' })
    tabs.lock.release()
    await settle()
    expect(tabs.browser.holderOf(LOCK)).toBeUndefined()
    expect(tabs.time.pending()).toBe(0)
  })

  it('3 秒内没有回应（冻结、暂停、卡住）：按没有回应处理（silent）——恰好 3 秒，之前不算', async () => {
    const tabs = await twoTabs()
    await tabs.time.advance(EDIT_TAB_HANDOVER_ACK_MS - 1)
    expect(tabs.outcome()).toBeUndefined()
    await tabs.time.advance(1)
    expect(tabs.outcome()).toEqual({ kind: 'silent' })
    // 撤下了等锁：A 放开之后锁空着
    tabs.lock.release()
    await settle()
    expect(tabs.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('回应了、却一直没做完：从回应起 20 秒按没有回应处理（回应之后 3 秒的时限不再算）', async () => {
    const tabs = await twoTabs()
    await tabs.time.advance(EDIT_TAB_HANDOVER_ACK_MS - 1_000)
    tabs.reply({ type: 'handover-ack', state: 'exiting' })
    await tabs.time.advance(EDIT_TAB_HANDOVER_DONE_MS - 1)
    expect(tabs.outcome()).toBeUndefined()
    await tabs.time.advance(1)
    expect(tabs.outcome()).toEqual({ kind: 'silent' })
  })

  it('别的请求的回应、请求本身不算：3 秒的时限照常', async () => {
    const tabs = await twoTabs()
    tabs.reply({ type: 'handover-ack', state: 'editing' }, '0199a2c4-1f2e-4a3b-8c4d-0000000000ff')
    tabs.reply({ type: 'handover-done' }, '0199a2c4-1f2e-4a3b-8c4d-0000000000ff')
    tabs.a.post({ type: 'handover-request', requestId: '0199a2c4-1f2e-4a3b-8c4d-0000000000fe', documentId: DOCUMENT_ID, from: TAB_A, userId: USER_ID })
    await tabs.time.advance(EDIT_TAB_HANDOVER_ACK_MS)
    expect(tabs.outcome()).toEqual({ kind: 'silent' })
  })

  it('那边正在进入编辑（busy）：隔一会儿换一个请求再问，旧请求的回应不再算；进入之后回应 ack，照常等它做完', async () => {
    const tabs = await twoTabs()
    const first = tabs.requests[0]?.requestId
    tabs.reply({ type: 'handover-busy' })
    await tabs.time.advance(TAB_HANDOVER_BUSY_RETRY_MS - 1)
    expect(tabs.requests).toHaveLength(1)
    await tabs.time.advance(1)
    expect(tabs.requests).toHaveLength(2)
    expect(tabs.requests[1]?.requestId).not.toBe(first)
    // 旧请求迟到的 failed 不算
    tabs.reply({ type: 'handover-failed', reason: 'not-saved' }, first)
    tabs.reply({ type: 'handover-ack', state: 'editing' })
    await settle()
    expect(tabs.outcome()).toBeUndefined()
    tabs.lock.release()
    await settle()
    expect(tabs.outcome()).toEqual({ kind: 'finished' })
  })

  it('一直 busy：从第一次 busy 起 20 秒按没有回应处理', async () => {
    const tabs = await twoTabs()
    for (let round = 0; round < 25 && tabs.outcome() === undefined; round += 1) {
      tabs.reply({ type: 'handover-busy' })
      await tabs.time.advance(TAB_HANDOVER_BUSY_RETRY_MS)
    }
    expect(tabs.outcome()).toEqual({ kind: 'silent' })
    expect(tabs.requests.length).toBeLessThanOrEqual(EDIT_TAB_HANDOVER_DONE_MS / TAB_HANDOVER_BUSY_RETRY_MS + 1)
    expect(tabs.time.now() - 1_000).toBeLessThanOrEqual(EDIT_TAB_HANDOVER_DONE_MS + TAB_HANDOVER_BUSY_RETRY_MS)
  })

  it('还没回应锁就空了（那边已经关了、刷新了、失去了编辑权）：立即算做完', async () => {
    const tabs = await twoTabs()
    tabs.lock.release()
    await settle()
    expect(tabs.outcome()).toEqual({ kind: 'finished' })
  })

  it('本页不再等（卸载、取消）：aborted，撤下等锁、取消时限；之后的回应不再算', async () => {
    const tabs = await twoTabs()
    tabs.reply({ type: 'handover-ack', state: 'editing' })
    await settle()
    tabs.abort.abort()
    await settle()
    expect(tabs.outcome()).toEqual({ kind: 'aborted' })
    expect(tabs.time.pending()).toBe(0)
    tabs.reply({ type: 'handover-done' })
    tabs.lock.release()
    await settle()
    expect(await tabs.asked).toEqual({ kind: 'aborted' })
    expect(tabs.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('一开始就撤销了：不发请求、不等锁', async () => {
    const browser = fakeBrowser()
    const time = fakeLeaseClock()
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const untilFree = vi.spyOn(b, 'untilFree')
    const post = vi.spyOn(b, 'post')
    const abort = new AbortController()
    abort.abort()
    expect(await askTabToHandOver({ browser: b, clock: time.clock, documentId: DOCUMENT_ID, from: TAB_B, userId: USER_ID, newId: () => '0199a2c4-1f2e-4a3b-8c4d-000000000001', signal: abort.signal })).toEqual({ kind: 'aborted' })
    expect(untilFree).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('浏览器没有锁（等锁立即交回 false）：只靠回应——收到 done 才算做完', async () => {
    const time = fakeLeaseClock()
    const replies = new Set<(message: HandoverMessage) => void>()
    const posted: HandoverMessage[] = []
    const browser: Pick<SameBrowser, 'post' | 'subscribe' | 'untilFree'> = {
      untilFree: async () => false,
      post: message => posted.push(message),
      subscribe: (listener) => {
        replies.add(listener)
        return () => replies.delete(listener)
      },
    }
    let outcome: TabHandoverOutcome | undefined
    void askTabToHandOver({ browser, clock: time.clock, documentId: DOCUMENT_ID, from: TAB_B, userId: USER_ID, newId: () => '0199a2c4-1f2e-4a3b-8c4d-000000000001', signal: new AbortController().signal }).then((result) => {
      outcome = result
    })
    await settle()
    expect(outcome).toBeUndefined()
    const requestId = posted[0]?.requestId ?? ''
    replies.forEach(listener => listener({ type: 'handover-ack', requestId, from: TAB_A, state: 'editing' }))
    await time.advance(5_000)
    expect(outcome).toBeUndefined()
    replies.forEach(listener => listener({ type: 'handover-done', requestId, from: TAB_A }))
    await settle()
    expect(outcome).toEqual({ kind: 'finished' })
  })
})

describe('刷新时在途的保存（M3-P5 设计 §3.7 的 R1）：本人接管之前先等它', () => {
  const WALL = Date.UTC(2026, 9, 7, 3, 0, 0)

  function waiting(marker: PendingSave | undefined, revisions: (() => Promise<number>), wallNow = WALL) {
    const time = fakeLeaseClock()
    const revision = vi.fn(revisions)
    const onWait = vi.fn()
    const abort = new AbortController()
    let outcome: string | undefined
    const waited = awaitPendingSave({ marker, wallNow: () => wallNow, clock: time.clock, revision, onWait, signal: abort.signal })
    void waited.then((result) => {
      outcome = result
    })
    return { time, revision, onWait, abort, waited, outcome: () => outcome }
  }

  it('没有记号：不用等（不读编辑状态、不说明）', async () => {
    const wait = waiting(undefined, async () => 9)
    expect(await wait.waited).toBe('none')
    expect(wait.revision).not.toHaveBeenCalled()
    expect(wait.onWait).not.toHaveBeenCalled()
  })

  it('记号已经过了 30 秒（从记号的时刻算）：不用等', async () => {
    const wait = waiting({ at: WALL - EDIT_PENDING_SAVE_WAIT_MS, revision: 3 }, async () => 3)
    expect(await wait.waited).toBe('none')
    expect(wait.onWait).not.toHaveBeenCalled()
  })

  it('30 秒以内：先说明，立即读一次；修订号已经比记号里的新（那次保存提交了）就不再等', async () => {
    const wait = waiting({ at: WALL - 1_000, revision: 3 }, async () => 4)
    expect(await wait.waited).toBe('committed')
    expect(wait.onWait).toHaveBeenCalledOnce()
    expect(wait.revision).toHaveBeenCalledOnce()
    expect(wait.time.pending()).toBe(0)
  })

  it('修订号还是记号里的：每 2 秒再读一次，前进了就不再等（不等到 30 秒）', async () => {
    let current = 3
    const wait = waiting({ at: WALL - 1_000, revision: 3 }, async () => current)
    await settle()
    expect(wait.revision).toHaveBeenCalledOnce()
    await wait.time.advance(PENDING_SAVE_POLL_MS - 1)
    expect(wait.revision).toHaveBeenCalledOnce()
    await wait.time.advance(1)
    expect(wait.revision).toHaveBeenCalledTimes(2)
    expect(wait.outcome()).toBeUndefined()
    current = 4
    await wait.time.advance(PENDING_SAVE_POLL_MS)
    expect(wait.outcome()).toBe('committed')
    expect(wait.revision).toHaveBeenCalledTimes(3)
    expect(wait.time.pending()).toBe(0)
  })

  it('一直没前进：到了 30 秒（从记号的时刻算，不是从开始等的那一刻）不再等；读失败的那一次不算，接着读', async () => {
    let calls = 0
    const wait = waiting({ at: WALL - 10_000, revision: 3 }, async () => {
      calls += 1
      if (calls === 2)
        throw new Error('断网')
      return 3
    })
    await wait.time.advance(EDIT_PENDING_SAVE_WAIT_MS - 10_000 - 1)
    expect(wait.outcome()).toBeUndefined()
    expect(calls).toBeGreaterThan(3)
    await wait.time.advance(1)
    expect(wait.outcome()).toBe('expired')
    expect(wait.time.pending()).toBe(0)
  })

  it('墙上时间回拨（记号的时刻在"将来"）：至多等 30 秒', async () => {
    const wait = waiting({ at: WALL + 60_000, revision: 3 }, async () => 3)
    await wait.time.advance(EDIT_PENDING_SAVE_WAIT_MS)
    expect(wait.outcome()).toBe('expired')
  })

  it('本页不再等（卸载、开始了别的事）：aborted，不再读', async () => {
    const wait = waiting({ at: WALL - 1_000, revision: 3 }, async () => 3)
    await settle()
    wait.abort.abort()
    expect(await wait.waited).toBe('aborted')
    await wait.time.advance(EDIT_PENDING_SAVE_WAIT_MS)
    expect(wait.revision).toHaveBeenCalledOnce()
  })
})

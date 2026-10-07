import type { HandoverMessage, LockApi } from './same-browser.ts'
import { describe, expect, it, vi } from 'vitest'
import { settle } from './fake-lease-clock.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { channelNameOf, HANDOVER_MESSAGE_VERSION, lockNameOf, onReply, onRequest, parseHandoverMessage, sameBrowserFor } from './same-browser.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const OTHER_DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
const TAB_A = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const TAB_B = '0199a2c4-1f2e-4a3b-8c4d-00000000bbbb'
const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000e1'
const REQUEST_ID = '0199a2c4-1f2e-4a3b-8c4d-000000000001'
const OTHER_REQUEST_ID = '0199a2c4-1f2e-4a3b-8c4d-000000000002'
const LOCK = lockNameOf(DOCUMENT_ID)
const CHANNEL = channelNameOf(DOCUMENT_ID)

const REQUEST: HandoverMessage = { type: 'handover-request', requestId: REQUEST_ID, documentId: DOCUMENT_ID, from: TAB_B, userId: USER_ID }

/** 一个 Promise 现在兑现了没有（让排着的回调先执行完） */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await settle()
  return done
}

describe('本机锁（M3-P5 设计 §3.1：先服务端、后本机锁）', () => {
  it('锁名与频道名按文档：nerve-doc:<id>（00 号计划书 §7.5）、nerve-office:doc:<id>', () => {
    expect(LOCK).toBe(`nerve-doc:${DOCUMENT_ID}`)
    expect(CHANNEL).toBe(`nerve-office:doc:${DOCUMENT_ID}`)
  })

  it('锁空着：tryHold 拿到（ifAvailable），本浏览器里看得到有人持有；放开之后空着，别的标签页拿得到', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    expect(await b.heldHere()).toBe(false)
    const held = await a.tryHold()
    expect(held).toBeDefined()
    expect(browser.holderOf(LOCK)).toBe('A')
    expect(await b.heldHere()).toBe(true)
    expect(await a.heldHere()).toBe(true)
    held?.release()
    await settle()
    expect(browser.holderOf(LOCK)).toBeUndefined()
    expect(await b.heldHere()).toBe(false)
    expect(await b.tryHold()).toBeDefined()
    expect(browser.holderOf(LOCK)).toBe('B')
  })

  it('被本浏览器的别的标签页占着：tryHold 为 undefined（不等、不抢），原来的持有者不受影响', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const held = await a.tryHold()
    expect(await b.tryHold()).toBeUndefined()
    expect(browser.holderOf(LOCK)).toBe('A')
    expect(await settled(held?.stolen ?? Promise.resolve())).toBe(false)
  })

  it('抢（steal）：立即拿到，原来的持有者的句柄兑现 stolen（AbortError）；它之后再放开无害，不影响新的持有者', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const old = await a.tryHold()
    const taken = await b.steal()
    expect(browser.holderOf(LOCK)).toBe('B')
    expect(await settled(old?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(true)
    expect(await settled(taken.stolen)).toBe(false)
    old?.release()
    await settle()
    expect(browser.holderOf(LOCK)).toBe('B')
    expect(await a.tryHold()).toBeUndefined()
  })

  it('锁空着时抢：照样拿到', async () => {
    const browser = fakeBrowser()
    const taken = await sameBrowserFor(DOCUMENT_ID, browser.apis).steal()
    expect(browser.holderOf(LOCK)).toBe('tab-1')
    taken.release()
  })

  it('放开之后被抢不算：已经放开的句柄不再兑现 stolen', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const held = await a.tryHold()
    // 放开与被抢在同一个同步段里（放开还没生效时对方抢了）
    held?.release()
    await b.steal()
    expect(await settled(held?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
  })

  it('别的文档的锁互不相干', async () => {
    const browser = fakeBrowser()
    await sameBrowserFor(DOCUMENT_ID, browser.tab('A')).tryHold()
    expect(await sameBrowserFor(OTHER_DOCUMENT_ID, browser.tab('B')).heldHere()).toBe(false)
    expect(await sameBrowserFor(OTHER_DOCUMENT_ID, browser.tab('B')).tryHold()).toBeDefined()
  })

  it('浏览器没有 Web Locks（不支持、不在安全上下文里）：拿与抢都交回从不被抢的句柄，本浏览器里看不到别人', async () => {
    const browser = sameBrowserFor(DOCUMENT_ID, { locks: undefined, openChannel: undefined })
    const held = await browser.tryHold()
    expect(held).toBeDefined()
    expect(() => held?.release()).not.toThrow()
    expect(await settled(held?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
    const taken = await browser.steal()
    expect(await settled(taken.stolen)).toBe(false)
    expect(await browser.heldHere()).toBe(false)
  })

  it('锁的请求出错（同步抛出、拿到之前就被拒绝）、查询出错：退化为从不被抢的句柄、看不到别人，从不失败', async () => {
    const throwing: LockApi = {
      request: () => {
        throw new DOMException('not allowed', 'SecurityError')
      },
      query: async () => Promise.reject(new DOMException('not allowed', 'SecurityError')),
    }
    const broken = sameBrowserFor(DOCUMENT_ID, { locks: throwing, openChannel: undefined })
    const held = await broken.tryHold()
    expect(held).toBeDefined()
    expect(await settled(held?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
    expect(await broken.steal()).toBeDefined()
    expect(await broken.heldHere()).toBe(false)

    const rejecting: LockApi = {
      request: async () => Promise.reject(new DOMException('not supported', 'NotSupportedError')),
      query: async () => ({ held: [] }),
    }
    const refused = sameBrowserFor(DOCUMENT_ID, { locks: rejecting, openChannel: undefined })
    expect(await refused.tryHold()).toBeDefined()
    expect(await refused.steal()).toBeDefined()
  })

  it('等锁直到空着（untilFree，交接的信号）：占着时排队，持有者放开之后交回 true——轮到时立即放开，不占着（之后别的标签页照样拿得到）', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const held = await a.tryHold()
    const free = b.untilFree(new AbortController().signal)
    expect(await settled(free)).toBe(false)
    expect(browser.holderOf(LOCK)).toBe('A')
    held?.release()
    expect(await free).toBe(true)
    await settle()
    expect(browser.holderOf(LOCK)).toBeUndefined()
    expect(await b.heldHere()).toBe(false)
    expect(await sameBrowserFor(DOCUMENT_ID, browser.tab('C')).tryHold()).toBeDefined()
  })

  it('等锁：锁本来就空着时立即 true；持有者被抢走（锁换了人）不算空着，接着等新的持有者放开', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    expect(await a.untilFree(new AbortController().signal)).toBe(true)
    await a.tryHold()
    const free = b.untilFree(new AbortController().signal)
    const taken = await sameBrowserFor(DOCUMENT_ID, browser.tab('C')).steal()
    expect(await settled(free)).toBe(false)
    expect(browser.holderOf(LOCK)).toBe('C')
    taken.release()
    expect(await free).toBe(true)
  })

  it('等锁撤销（时限到了、不再等）：交回 false，从队里撤下——之后持有者放开时它不会再拿到锁；撤销过的 signal 不排队', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const held = await a.tryHold()
    const waiting = new AbortController()
    const free = b.untilFree(waiting.signal)
    await settle()
    waiting.abort()
    expect(await free).toBe(false)
    held?.release()
    await settle()
    expect(browser.holderOf(LOCK)).toBeUndefined()
    expect(await b.untilFree(waiting.signal)).toBe(false)
  })

  it('等锁：浏览器没有 Web Locks、请求出错时立即 false，不抛出', async () => {
    expect(await sameBrowserFor(DOCUMENT_ID, { locks: undefined, openChannel: undefined }).untilFree(new AbortController().signal)).toBe(false)
    const throwing: LockApi = {
      request: () => {
        throw new DOMException('not allowed', 'SecurityError')
      },
      query: async () => ({ held: [] }),
    }
    expect(await sameBrowserFor(DOCUMENT_ID, { locks: throwing, openChannel: undefined }).untilFree(new AbortController().signal)).toBe(false)
  })

  it('拿到之后请求以别的错误结束（不是 AbortError）：不算被抢', async () => {
    let fail: (error: unknown) => void = () => {}
    const locks: LockApi = {
      request: async (_name, _options, callback) => new Promise((_resolve, reject) => {
        fail = reject
        void callback({ name: LOCK })
      }),
      query: async () => ({ held: [] }),
    }
    const held = await sameBrowserFor(DOCUMENT_ID, { locks, openChannel: undefined }).tryHold()
    fail(new TypeError('意外'))
    expect(await settled(held?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
  })
})

describe('交接频道（M3-P5 设计 §3.7；协议在 S6）', () => {
  it('发给本浏览器里别的标签页：对方收到解析过的消息（带版本发出，去掉版本交出）；发出的一方自己收不到；频道第一次收发时才打开', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    expect(browser.openChannels(CHANNEL)).toBe(0)
    const toA = vi.fn()
    const toB = vi.fn()
    a.subscribe(toA)
    b.subscribe(toB)
    expect(browser.openChannels(CHANNEL)).toBe(2)
    b.post(REQUEST)
    await settle()
    expect(browser.posted(CHANNEL)).toEqual([{ v: HANDOVER_MESSAGE_VERSION, ...REQUEST }])
    expect(toA).toHaveBeenCalledExactlyOnceWith(REQUEST)
    expect(toB).not.toHaveBeenCalled()
  })

  it('认不出的一律不交出：别的版本、不是对象、缺字段、取值不认识、请求里的文档不是这一份', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const received = vi.fn()
    a.subscribe(received)
    const raw = browser.tab('B').openChannel?.(CHANNEL)
    for (const data of [
      { v: 2, ...REQUEST },
      'handover-request',
      null,
      { v: 1, type: 'handover-request', requestId: REQUEST_ID, from: TAB_B, userId: USER_ID },
      { v: 1, type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'reading' },
      { v: 1, type: 'handover-failed', requestId: REQUEST_ID, from: TAB_A, reason: 'unknown' },
      { v: 1, type: 'handover-hello', requestId: REQUEST_ID, from: TAB_A },
      { v: 1, ...REQUEST, documentId: OTHER_DOCUMENT_ID },
      { v: 1, ...REQUEST, requestId: 'not-a-uuid' },
    ])
      raw?.postMessage(data)
    raw?.postMessage({ v: 1, ...REQUEST, extra: 'dropped' })
    await settle()
    expect(received).toHaveBeenCalledExactlyOnceWith(REQUEST)
  })

  it('parseHandoverMessage：五种消息各自认得出（多出的字段丢弃）', () => {
    const replies: HandoverMessage[] = [
      REQUEST,
      { type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'editing' },
      { type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'exiting' },
      { type: 'handover-busy', requestId: REQUEST_ID, from: TAB_A },
      { type: 'handover-done', requestId: REQUEST_ID, from: TAB_A },
      { type: 'handover-failed', requestId: REQUEST_ID, from: TAB_A, reason: 'not-saved' },
      { type: 'handover-failed', requestId: REQUEST_ID, from: TAB_A, reason: 'conflict' },
      { type: 'handover-failed', requestId: REQUEST_ID, from: TAB_A, reason: 'session' },
    ]
    for (const message of replies)
      expect(parseHandoverMessage({ v: HANDOVER_MESSAGE_VERSION, ...message, token: 'never' }, DOCUMENT_ID)).toEqual(message)
  })

  it('按 requestId 配对（onReply）：只交出这一次请求的回应，别的请求的回应与请求本身不交出；onRequest 只交出请求', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const replies = vi.fn()
    const requests = vi.fn()
    const stopReplies = onReply(b, REQUEST_ID, replies)
    onRequest(a, requests)
    b.post(REQUEST)
    await settle()
    expect(requests).toHaveBeenCalledExactlyOnceWith(REQUEST)
    a.post({ type: 'handover-ack', requestId: OTHER_REQUEST_ID, from: TAB_A, state: 'editing' })
    a.post({ type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'editing' })
    a.post({ type: 'handover-done', requestId: REQUEST_ID, from: TAB_A })
    a.post({ ...REQUEST, from: TAB_A })
    await settle()
    expect(replies.mock.calls).toEqual([
      [{ type: 'handover-ack', requestId: REQUEST_ID, from: TAB_A, state: 'editing' }],
      [{ type: 'handover-done', requestId: REQUEST_ID, from: TAB_A }],
    ])
    expect(requests).toHaveBeenCalledOnce()
    stopReplies()
    a.post({ type: 'handover-failed', requestId: REQUEST_ID, from: TAB_A, reason: 'session' })
    await settle()
    expect(replies).toHaveBeenCalledTimes(2)
  })

  it('退订之后不再收；关掉之后不再收，再发什么也不做（不抛出），端点随之关掉', async () => {
    const browser = fakeBrowser()
    const a = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const b = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    const received = vi.fn()
    const stop = a.subscribe(received)
    b.post(REQUEST)
    await settle()
    stop()
    b.post(REQUEST)
    await settle()
    expect(received).toHaveBeenCalledOnce()
    a.subscribe(received)
    a.close()
    expect(browser.openChannels(CHANNEL)).toBe(1)
    b.post(REQUEST)
    await settle()
    expect(received).toHaveBeenCalledOnce()
    expect(() => a.post(REQUEST)).not.toThrow()
    a.subscribe(received)
    expect(browser.openChannels(CHANNEL)).toBe(1)
  })

  it('浏览器没有 BroadcastChannel、打开出错：收发什么也不做，不抛出', () => {
    const none = sameBrowserFor(DOCUMENT_ID, { locks: undefined, openChannel: undefined })
    expect(() => none.post(REQUEST)).not.toThrow()
    const stop = none.subscribe(vi.fn())
    expect(() => stop()).not.toThrow()
    expect(() => none.close()).not.toThrow()
    const failing = sameBrowserFor(DOCUMENT_ID, {
      locks: undefined,
      openChannel: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(() => failing.post(REQUEST)).not.toThrow()
    expect(() => failing.subscribe(vi.fn())).not.toThrow()
  })
})

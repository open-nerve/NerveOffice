import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchBrowserConnection } from './browser-connection.ts'
import { createConnectionState } from './connection-state.ts'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => vi.useFakeTimers({ now: 100 }))
afterEach(() => vi.useRealTimers())

function fixture(initialOnline = true) {
  const state = createConnectionState({ online: initialOnline, now: () => Date.now() })
  const target = new EventTarget()
  const requests: { readonly signal: AbortSignal, readonly finish: (success: boolean) => void }[] = []
  let online = initialOnline
  const stop = watchBrowserConnection({
    state,
    target,
    online: () => online,
    probe: async (signal) => {
      const ticket = state.beginRequest()
      const response = deferred<boolean>()
      requests.push({ signal, finish: response.resolve })
      const success = await response.promise
      if (!signal.aborted) {
        if (success)
          state.succeeded(ticket)
        else
          state.failed(ticket)
      }
    },
  })
  return { state, target, requests, stop, browser: (value: boolean) => {
    online = value
    target.dispatchEvent(new Event(value ? 'online' : 'offline'))
  } }
}

describe('浏览器连接的受控复核', () => {
  it('健康时不探测；一次故障只排一只计时器，2 秒后开始且在途不重入', async () => {
    const f = fixture()
    expect(vi.getTimerCount()).toBe(0)
    f.state.failed(f.state.beginRequest())
    f.state.failed(f.state.beginRequest())
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.requests).toHaveLength(1)
    f.browser(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.requests).toHaveLength(1)
    f.requests[0]!.finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.view().available).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    f.stop()
  })

  it('连续探测失败按 2、4、8、16、30、30 秒退避，普通故障不重置计时', async () => {
    const f = fixture()
    f.state.failed(f.state.beginRequest())
    for (const [index, delay] of [2000, 4000, 8000, 16_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(f.requests).toHaveLength(index)
      f.state.failed(f.state.beginRequest())
      await vi.advanceTimersByTimeAsync(1)
      expect(f.requests).toHaveLength(index + 1)
      f.requests[index]!.finish(false)
      await vi.advanceTimersByTimeAsync(0)
    }
    f.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('初始 offline 不探测；online 立即复核但仍不可用，重复事件合并', async () => {
    const f = fixture(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.requests).toHaveLength(0)
    f.browser(true)
    f.browser(true)
    expect(f.requests).toHaveLength(1)
    expect(f.state.view().available).toBe(false)
    f.requests[0]!.finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.view().available).toBe(true)
    f.stop()
  })

  it('实际新请求成功清掉待探测定时器，不递归探测', async () => {
    const f = fixture()
    f.state.failed(f.state.beginRequest())
    f.state.succeeded(f.state.beginRequest())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    f.stop()
  })

  it('再次离线取消探测，旧回包无效；回来可开始新一轮', async () => {
    const f = fixture(false)
    f.browser(true)
    f.browser(false)
    expect(f.requests[0]!.signal.aborted).toBe(true)
    f.requests[0]!.finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.view().available).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    f.browser(true)
    expect(f.requests).toHaveLength(2)
    f.stop()
    f.requests[1]!.finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.view().available).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pagehide 与显式 dispose 都清监听/探测，晚到成功不再改变状态', async () => {
    const f = fixture(false)
    f.browser(true)
    f.target.dispatchEvent(new Event('pagehide'))
    f.stop()
    expect(f.requests[0]!.signal.aborted).toBe(true)
    const stopped = f.state.view()
    f.browser(false)
    f.requests[0]!.finish(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.state.view()).toBe(stopped)
    expect(f.requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('断网又立即 online 时先等被取消的探测收尾，随后只补一轮', async () => {
    const f = fixture(false)
    f.browser(true)
    f.browser(false)
    f.browser(true)
    f.browser(true)
    expect(f.requests).toHaveLength(1)
    f.requests[0]!.finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.requests).toHaveLength(2)
    expect(f.state.view().available).toBe(false)
    f.requests[1]!.finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.view().available).toBe(true)
    f.stop()
  })
})

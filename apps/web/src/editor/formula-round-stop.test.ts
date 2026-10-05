// 主线程模式下销毁之前停下正在算的一轮（M3-P4 设计 §3.14）：没有在算时什么也不做；在算时先订阅、再请求停下，等到它结束；
// 到了时限交回 timeout；无论怎样都退订、清掉计时器。在 Univer 里的接线由 sheet-editor.test.ts 测，真实的引擎由 E2E 与页面自检的校准测
import type { FormulaRound } from './formula-round-stop.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUND_STOP_TIMEOUT_MS, stopRunningRound } from './formula-round-stop.ts'

/** 假的一轮计算：running 可设，进度的订阅者可数；stop 记下调用，可以换成别的做法 */
function fakeRound(running: boolean) {
  const state = { running }
  const listeners = new Set<() => void>()
  const round = {
    running: () => state.running,
    onProgress: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: vi.fn(),
  } satisfies FormulaRound
  return {
    round,
    /** 进度变了（running 设为 next 之后通知） */
    progress: (next: boolean): void => {
      state.running = next
      listeners.forEach(listener => listener())
    },
    listeners: () => listeners.size,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('停下正在算的一轮', () => {
  it('没有在算：立即交回 idle，不请求停下、不订阅', async () => {
    const fake = fakeRound(false)
    expect(await stopRunningRound(fake.round)).toBe('idle')
    expect(fake.round.stop).not.toHaveBeenCalled()
    expect(fake.listeners()).toBe(0)
  })

  it('在算：先订阅再请求停下；进度变了但还在算时接着等，收到结束（不在算了）时交回 ended，退订', async () => {
    const fake = fakeRound(true)
    fake.round.stop.mockImplementation(() => {
      // 请求停下的这一刻已经在订阅了
      expect(fake.listeners()).toBe(1)
    })
    let outcome: string | undefined
    const stopping = stopRunningRound(fake.round).then((value) => {
      outcome = value
    })
    expect(fake.round.stop).toHaveBeenCalledOnce()
    fake.progress(true)
    await Promise.resolve()
    expect(outcome).toBeUndefined()
    fake.progress(false)
    await stopping
    expect(outcome).toBe('ended')
    expect(fake.listeners()).toBe(0)
  })

  it('请求停下的这一步里就结束了：交回 ended', async () => {
    const fake = fakeRound(true)
    fake.round.stop.mockImplementation(() => fake.progress(false))
    expect(await stopRunningRound(fake.round)).toBe('ended')
    expect(fake.listeners()).toBe(0)
  })

  it('到了时限还在算：交回 timeout（默认 ROUND_STOP_TIMEOUT_MS），退订、之后的结束不再管', async () => {
    vi.useFakeTimers()
    const fake = fakeRound(true)
    let outcome: string | undefined
    const stopping = stopRunningRound(fake.round).then((value) => {
      outcome = value
    })
    await vi.advanceTimersByTimeAsync(ROUND_STOP_TIMEOUT_MS - 1)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(outcome).toBe('timeout')
    expect(fake.listeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('时限可以给定；结束了就清掉计时器', async () => {
    vi.useFakeTimers()
    const fake = fakeRound(true)
    const stopping = stopRunningRound(fake.round, 50)
    fake.progress(false)
    expect(await stopping).toBe('ended')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('请求停下时抛出：照样抛出，退订、清掉计时器', async () => {
    vi.useFakeTimers()
    const fake = fakeRound(true)
    const failure = new Error('停止的 mutation 没有注册')
    fake.round.stop.mockImplementation(() => {
      throw failure
    })
    await expect(stopRunningRound(fake.round)).rejects.toBe(failure)
    expect(fake.listeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

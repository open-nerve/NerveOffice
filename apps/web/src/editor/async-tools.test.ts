import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, pollUntil, withDeadline } from './async-tools.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('deferred', () => {
  it('在外部完成或失败', async () => {
    const done = deferred<number>()
    done.resolve(7)
    await expect(done.promise).resolves.toBe(7)
    const failed = deferred<number>()
    failed.reject(new Error('x'))
    await expect(failed.promise).rejects.toThrow('x')
  })
})

describe('withDeadline', () => {
  it('时限之内完成：取它的结果，清掉计时器', async () => {
    vi.useFakeTimers()
    await expect(withDeadline(Promise.resolve('ok'), 1000, () => new Error('超时'))).resolves.toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('时限之内失败：取它的错误', async () => {
    await expect(withDeadline(Promise.reject(new Error('坏了')), 1000, () => new Error('超时'))).rejects.toThrow('坏了')
  })

  it('到时限还没完成：以给出的错误失败', async () => {
    vi.useFakeTimers()
    const pending = withDeadline(new Promise(() => {}), 20_000, () => new Error('超时'))
    const assertion = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
  })
})

describe('pollUntil', () => {
  it('条件本来就成立：立即返回，不等待', async () => {
    const condition = vi.fn(() => true)
    await expect(pollUntil(condition, { timeoutMs: 3000, intervalMs: 20 })).resolves.toBe(true)
    expect(condition).toHaveBeenCalledTimes(1)
  })

  it('每隔一段时间检查一次，成立就返回', async () => {
    vi.useFakeTimers()
    let now = 0
    let checks = 0
    const polling = pollUntil(() => ++checks === 4, { timeoutMs: 3000, intervalMs: 20, now: () => now })
    for (let i = 0; i < 3; i++) {
      now += 20
      await vi.advanceTimersByTimeAsync(20)
    }
    await expect(polling).resolves.toBe(true)
    expect(checks).toBe(4)
  })

  it('超过时限仍不成立：返回 false，最后一次等待不超过剩下的时间', async () => {
    vi.useFakeTimers()
    let now = 0
    const polling = pollUntil(() => false, { timeoutMs: 50, intervalMs: 20, now: () => now })
    for (const step of [20, 20, 10]) {
      now += step
      await vi.advanceTimersByTimeAsync(step)
    }
    await expect(polling).resolves.toBe(false)
  })
})

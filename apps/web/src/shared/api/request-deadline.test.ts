import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkError, RequestTimeoutError } from './api-errors.ts'
import { withinRequestDeadline } from './request-deadline.ts'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('一次完整请求的时限', () => {
  it('时限内完成交回结果并清掉计时器，之后不取消已经完成的工作', async () => {
    let received: AbortSignal | undefined
    const result = await withinRequestDeadline({ timeoutMs: 1000 }, async (signal) => {
      received = signal
      return '完成'
    })
    expect(result).toBe('完成')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(received?.aborted).toBe(false)
  })

  it('到点主动中止；底层不理取消也有界失败，超时属于网络未知结果', async () => {
    const work = deferred<string>()
    let received: AbortSignal | undefined
    const outcome = withinRequestDeadline({ timeoutMs: 1000 }, async (signal) => {
      received = signal
      return work.promise
    }).catch((error: unknown) => error)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    expect(received?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect(error).toBeInstanceOf(RequestTimeoutError)
    expect(error).toBeInstanceOf(NetworkError)
    expect(error).toMatchObject({ timeoutMs: 1000 })
    expect(received?.aborted).toBe(true)
    expect(received?.reason).toBe(error)
    expect(vi.getTimerCount()).toBe(0)
    work.resolve('迟到的成功')
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toBe(error)
  })

  it('调用方已经取消时不开始工作，保留其原始原因', async () => {
    const controller = new AbortController()
    const reason = new Error('页面卸载')
    controller.abort(reason)
    const run = vi.fn(async () => '不应执行')
    await expect(withinRequestDeadline({ timeoutMs: 1000, signal: controller.signal }, run)).rejects.toBe(reason)
    expect(run).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('调用方在途取消原样交回原因，底层之后拒绝也不会改写结果', async () => {
    const work = deferred<string>()
    const controller = new AbortController()
    const reason = new DOMException('页面卸载', 'AbortError')
    let received: AbortSignal | undefined
    const outcome = withinRequestDeadline({ timeoutMs: 1000, signal: controller.signal }, async (signal) => {
      received = signal
      return work.promise
    }).catch((error: unknown) => error)
    controller.abort(reason)
    expect(await outcome).toBe(reason)
    expect(received?.reason).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    work.reject(new Error('迟到的失败'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toBe(reason)
  })

  it('超时后再取消、底层再失败：仍只有最先确定的超时结果', async () => {
    const work = deferred<string>()
    const controller = new AbortController()
    const results: unknown[] = []
    const outcome = withinRequestDeadline({ timeoutMs: 1000, signal: controller.signal }, async () => work.promise)
      .then(value => results.push(value), (error: unknown) => results.push(error))
    await vi.advanceTimersByTimeAsync(1000)
    await outcome
    controller.abort(new Error('稍后才卸载'))
    work.reject(new Error('网络终于报错'))
    await vi.advanceTimersByTimeAsync(0)
    expect(results).toHaveLength(1)
    expect(results[0]).toBeInstanceOf(RequestTimeoutError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('工作同步抛错也清理作用域，原样交回错误', async () => {
    const failure = new Error('同步校验失败')
    await expect(withinRequestDeadline({ timeoutMs: 1000 }, () => {
      throw failure
    })).rejects.toBe(failure)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['done', 'failed'] as const)('同步处理已经耗尽时限：计时器尚没轮到执行也不能交回迟到的 %s', async (ending) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const result = withinRequestDeadline({ timeoutMs: 1000 }, async () => {
      now.mockReturnValue(1000)
      if (ending === 'failed')
        throw new Error('校验结束时才确定失败')
      return '校验完了，但已经到期'
    })
    await expect(result).rejects.toBeInstanceOf(RequestTimeoutError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject', 'cancel', 'timeout'] as const)('%s 结束都移除上游取消监听器', async (ending) => {
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const work = deferred<string>()
    const outcome = withinRequestDeadline({ timeoutMs: 1000, signal: controller.signal }, async () => work.promise).catch(() => undefined)
    if (ending === 'resolve')
      work.resolve('完成')
    else if (ending === 'reject')
      work.reject(new Error('失败'))
    else if (ending === 'cancel')
      controller.abort()
    else
      await vi.advanceTimersByTimeAsync(1000)
    await outcome
    const listener = added.mock.calls.find(call => call[0] === 'abort')?.[1]
    expect(listener).toBeDefined()
    expect(removed.mock.calls.some(call => call[0] === 'abort' && call[1] === listener)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    work.resolve('清理悬挂的替身')
  })
})

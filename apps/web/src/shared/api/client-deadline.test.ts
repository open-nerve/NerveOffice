import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { json } from '../testing/fake-api.test-support.ts'
import { apiFetch, apiRequest, isDefiniteRejection, isTransientError, isUnknownOutcome, NetworkError, setCsrfToken } from './client.ts'

const schema = z.object({ name: z.string() })
const cleanup: (() => void)[] = []

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function observe<T>(promise: Promise<T>) {
  let result: { kind: 'done', value: T } | { kind: 'failed', error: unknown } | undefined
  void promise.then((value) => {
    result = { kind: 'done', value }
  }, (error: unknown) => {
    result = { kind: 'failed', error }
  })
  return () => result
}

/** 真实 Response/ReadableStream：HTTP 头已到，正文直到 finish 才结束。 */
function stalledBody(status = 200) {
  let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined
  let closed = false
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start: (stream) => { controller = stream },
    cancel: () => { closed = true },
  })
  const finish = (value?: unknown) => {
    if (closed)
      return
    if (value !== undefined)
      controller?.enqueue(new TextEncoder().encode(JSON.stringify(value)))
    controller?.close()
    closed = true
  }
  cleanup.push(finish)
  return { response: new Response(body, { status, headers: { 'content-type': 'application/json' } }), finish }
}

beforeEach(() => {
  vi.useFakeTimers()
  setCsrfToken(undefined)
})

afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('请求的默认时限覆盖完整响应', () => {
  it('未收到响应时默认 30 秒结束并取消 fetch，迟到成功不再返回数据', async () => {
    const waiting = deferred<Response>()
    let signal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      signal = init?.signal
      return waiting.promise
    }))
    const result = observe(apiRequest('/api/item', { schema }))
    await vi.advanceTimersByTimeAsync(29_999)
    expect(result()).toBeUndefined()
    expect(signal?.aborted ?? false).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(result()).toMatchObject({ kind: 'failed', error: { name: 'RequestTimeoutError', timeoutMs: 30_000 } })
    expect(signal?.aborted).toBe(true)
    waiting.resolve(json(200, { name: '迟到的成功' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(result()).toMatchObject({ kind: 'failed', error: { name: 'RequestTimeoutError' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([200, 409])('HTTP %s 的头在 20 秒到了但正文挂住：仍在总计 30 秒时结束', async (status) => {
    const waiting = deferred<Response>()
    const body = stalledBody(status)
    vi.stubGlobal('fetch', vi.fn(async () => waiting.promise))
    const result = observe(apiRequest('/api/item', { schema, method: 'PUT' }))
    await vi.advanceTimersByTimeAsync(20_000)
    waiting.resolve(body.response)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    const current = result()
    expect(current).toMatchObject({ kind: 'failed', error: { name: 'RequestTimeoutError', timeoutMs: 30_000 } })
    if (current?.kind !== 'failed')
      throw new Error('请求没有按时结束')
    expect(current.error).toBeInstanceOf(NetworkError)
    expect(isDefiniteRejection(current.error)).toBe(false)
    expect(isUnknownOutcome(current.error)).toBe(true)
    expect(isTransientError(current.error)).toBe(true)
    body.finish(status === 200 ? { name: '迟到' } : { error: { code: 'CONFLICT', message: '迟到', requestId: 'late' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(result()).toBe(current)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正文在时限前结束照常交回数据，并撤掉时限', async () => {
    const body = stalledBody()
    vi.stubGlobal('fetch', vi.fn(async () => body.response))
    const result = apiRequest('/api/item', { schema })
    await vi.advanceTimersByTimeAsync(29_999)
    body.finish({ name: '周报' })
    await expect(result).resolves.toEqual({ name: '周报' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('调用方指定时限同样覆盖正文，不另从响应头重新计时', async () => {
    const body = stalledBody()
    vi.stubGlobal('fetch', vi.fn(async () => body.response))
    const result = observe(apiRequest('/api/item', { schema, timeoutMs: 10_000 }))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result()).toMatchObject({ kind: 'failed', error: { name: 'RequestTimeoutError', timeoutMs: 10_000 } })
  })

  it('非 JSON 的正文也在 reader 完成前保持计时', async () => {
    const body = stalledBody()
    vi.stubGlobal('fetch', vi.fn(async () => body.response))
    const result = observe(apiFetch('/api/content', {}, async response => response.text()))
    await vi.advanceTimersByTimeAsync(29_999)
    expect(result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result()).toMatchObject({ kind: 'failed', error: { name: 'RequestTimeoutError' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('头已到、调用方取消时不把取消吞成格式错误，底层不理取消也结束', async () => {
    const controller = new AbortController()
    const reason = new Error('换了文档')
    const body = stalledBody()
    vi.stubGlobal('fetch', vi.fn(async () => body.response))
    const result = observe(apiRequest('/api/item', { schema, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(result()).toEqual({ kind: 'failed', error: reason })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('原始正文也必须在请求作用域内读完；超时后的头不再交给 reader', async () => {
    const waiting = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async () => waiting.promise))
    const read = vi.fn(async (response: Response) => response.text())
    const result = observe(apiFetch('/api/raw', {}, read))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(result()).toMatchObject({ kind: 'failed', error: { name: 'RequestTimeoutError' } })
    waiting.resolve(new Response('迟到正文'))
    await vi.advanceTimersByTimeAsync(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('204 与 304 没有正文：立即结束作用域，不留下计时器', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(apiRequest('/api/logout', { schema: z.undefined(), method: 'POST' })).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304 })))
    await expect(apiFetch('/api/content', { acceptNotModified: true }, response => response.status)).resolves.toBe(304)
    expect(vi.getTimerCount()).toBe(0)
  })
})

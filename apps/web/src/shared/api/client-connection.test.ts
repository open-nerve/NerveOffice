import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectionState } from '../lib/connection-state.ts'
import { apiError, installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { apiFetch, apiRequest, NetworkError, RequestTimeoutError } from './client.ts'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  connectionState.setBrowserOnline(false)
  connectionState.setBrowserOnline(true)
  connectionState.succeeded(connectionState.beginRequest())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('完整请求结束之后才发布连接事实', () => {
  it('拿到响应头仍不恢复，读取方完成才发布成功', async () => {
    connectionState.failed(connectionState.beginRequest())
    installFakeApi({ 'GET /api/value': () => json(200, {}) })
    const entered = deferred<void>()
    const body = deferred<string>()
    const result = apiFetch('/api/value', {}, async () => {
      entered.resolve()
      return body.promise
    })
    await entered.promise
    expect(connectionState.view().available).toBe(false)
    body.resolve('读完')
    await expect(result).resolves.toBe('读完')
    expect(connectionState.view().available).toBe(true)
  })

  it('真实 fetch 失败进入连接异常', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('failed to fetch')
    })
    await expect(apiFetch('/api/value', {}, () => undefined)).rejects.toBeInstanceOf(NetworkError)
    expect(connectionState.view()).toMatchObject({ available: false, browserOnline: true, problem: 'unresponsive' })
  })

  it('正文超过时限只记录一次故障，迟到读完不能恢复', async () => {
    vi.useFakeTimers()
    installFakeApi({ 'GET /api/value': () => json(200, {}) })
    const entered = deferred<void>()
    const body = deferred<string>()
    const result = apiFetch('/api/value', { timeoutMs: 1000 }, async () => {
      entered.resolve()
      return body.promise
    }).catch((error: unknown) => error)
    await entered.promise
    const generation = connectionState.view().generation
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBeInstanceOf(RequestTimeoutError)
    expect(connectionState.view()).toMatchObject({ available: false, generation: generation + 1 })
    const failed = connectionState.view()
    body.resolve('迟到')
    await vi.advanceTimersByTimeAsync(0)
    expect(connectionState.view()).toBe(failed)
  })

  it('调用方主动取消，连自带的 NetworkError 原因也不算连接故障', async () => {
    installFakeApi({ 'GET /api/value': () => json(200, {}) })
    const controller = new AbortController()
    const body = deferred<string>()
    const result = apiFetch('/api/value', { signal: controller.signal }, async () => body.promise).catch((error: unknown) => error)
    const reason = new NetworkError('调用方结束自己的工作')
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(connectionState.view().available).toBe(true)
    body.resolve('迟到')
  })

  it.each(['http', 'format'] as const)('%s 拒绝仍保留原错误语义，既不伪造故障也不恢复既有故障', async (kind) => {
    installFakeApi({ 'GET /api/value': () => kind === 'http' ? apiError(403, 'PERMISSION_DENIED', '不允许') : json(200, { value: 1 }) })
    for (const available of [true, false]) {
      if (!available)
        connectionState.failed(connectionState.beginRequest())
      await expect(apiRequest('/api/value', { schema: z.strictObject({ value: z.string() }) })).rejects.toThrow()
      expect(connectionState.view().available).toBe(available)
    }
  })

  it('早先的完整成功晚于另一次网络故障，不能恢复连接', async () => {
    const body = deferred<string>()
    const entered = deferred<void>()
    installFakeApi({
      'GET /api/early': () => json(200, {}),
      'GET /api/failure': () => {
        throw new TypeError('网络中断')
      },
    })
    const early = apiFetch('/api/early', {}, async () => {
      entered.resolve()
      return body.promise
    })
    await entered.promise
    await expect(apiFetch('/api/failure', {}, () => undefined)).rejects.toBeInstanceOf(NetworkError)
    body.resolve('旧响应')
    await early
    expect(connectionState.view().available).toBe(false)
  })
})

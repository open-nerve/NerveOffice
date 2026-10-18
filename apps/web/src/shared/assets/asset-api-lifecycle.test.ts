import type { SessionResponse } from '@nerve-office/contracts'
import type { AssetRequestOptions } from './asset-api.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, setApiSession, setCsrfToken } from '../api/client.ts'
import { rememberSessionPermit } from '../api/session-association.ts'
import { reportRequestSessionFailure } from '../api/session-tracking.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { apiError, installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { readAsset, uploadAsset } from './asset-api.ts'

vi.mock('../api/session-tracking.ts', () => ({ reportRequestSessionFailure: vi.fn(async () => {}) }))

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE = `/api/assets/${USER}`
const DATA = new Uint8Array([1, 2, 3])
const cleanup: (() => void)[] = []
const operations = [
  { name: '上传', key: 'POST /api/assets', run: async (options: AssetRequestOptions = {}) => uploadAsset({ data: DATA, mimeType: 'image/png', extension: 'png' }, options), response: () => json(201, { assetId: USER, url: SOURCE, mimeType: 'image/png', width: 1, height: 1, bytes: 3 }) },
  { name: '读取', key: `GET ${SOURCE}`, run: async (options: AssetRequestOptions = {}) => readAsset(SOURCE, options), response: () => new Response(DATA, { headers: { 'content-type': 'image/png', 'x-asset-status': '200' } }) },
]

function session(generation: string): SessionResponse {
  const value: SessionResponse = { user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: USER, name: '甲' }, csrfToken: generation, features: { localDraftsEnabled: true } }
  rememberSessionPermit(value, Object.freeze({ userId: USER, generation }))
  return value
}

beforeEach(() => {
  setCsrfToken(undefined)
})

afterEach(() => {
  for (const finish of cleanup.splice(0))
    finish()
  setCsrfToken(undefined)
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.each(operations)('图片 $name 复用请求生命周期', ({ run, key, response, name }) => {
  it('已取消时不发请求，原样交回任意取消原因', async () => {
    const api = installFakeApi()
    const controller = new AbortController()
    const reason = { stopped: 'controlled' }
    controller.abort(reason)
    await expect(run({ signal: controller.signal })).rejects.toBe(reason)
    expect(api.requests).toHaveLength(0)
  })

  it('网络失败不自动重试', async () => {
    const api = installFakeApi({ [key]: () => {
      throw new TypeError('controlled network failure')
    } })
    await expect(run()).rejects.toBeInstanceOf(NetworkError)
    expect(api.requests).toHaveLength(1)
  })

  it('30 秒未收到响应即结束，取消底层，迟到成功不改变结果', async () => {
    vi.useFakeTimers()
    const waiting = deferred<Response>()
    let signal: AbortSignal | null | undefined
    const api = installFakeApi({ [key]: async (init) => {
      signal = init?.signal
      return waiting.promise
    } })
    let outcome: unknown
    const task = run().then((value) => {
      outcome = value
    }, (error: unknown) => {
      outcome = error
    })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await task
    expect(outcome).toMatchObject({ name: 'RequestTimeoutError', timeoutMs: 30_000 })
    expect(signal?.aborted).toBe(true)
    waiting.resolve(response())
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toMatchObject({ name: 'RequestTimeoutError' })
    expect(api.requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('请求期间取消保留原因；忽略 abort 的迟到响应也不能变成成功', async () => {
    const waiting = deferred<Response>()
    const api = installFakeApi({ [key]: async () => waiting.promise })
    const controller = new AbortController()
    const reason = Object.freeze({ changedInstance: true })
    const task = run({ signal: controller.signal }).catch((error: unknown) => error)
    controller.abort(reason)
    expect(await task).toBe(reason)
    waiting.resolve(response())
    expect(api.requests).toHaveLength(1)
    expect(reportRequestSessionFailure).not.toHaveBeenCalled()
  })

  it.each([false, true])('原会话归属保持（显式绑定=%s），新登录不会接收旧请求的 401', async (explicit) => {
    const original = session('old-generation')
    setApiSession(original)
    const waiting = deferred<Response>()
    const api = installFakeApi({ [key]: async () => waiting.promise })
    const task = run(explicit ? { session: original } : {}).catch((error: unknown) => error)
    setApiSession(session('new-generation'))
    waiting.resolve(apiError(401, 'SESSION_EXPIRED'))
    const error: unknown = await task
    expect(error).toMatchObject({ name: 'ApiError', status: 401 })
    await vi.waitFor(() => expect(reportRequestSessionFailure).toHaveBeenCalledExactlyOnceWith(error, { userId: USER, generation: 'old-generation' }))
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.headers['x-csrf-token']).toBe(name === '上传' ? 'old-generation' : undefined)
  })

  it('取消原因恰好是认证错误时，不误触发会话清理', async () => {
    setApiSession(session('controlled-generation'))
    const api = installFakeApi()
    const controller = new AbortController()
    const reason = new ApiError(401, 'SESSION_EXPIRED', '受控取消')
    controller.abort(reason)
    await expect(run({ signal: controller.signal })).rejects.toBe(reason)
    expect(reportRequestSessionFailure).not.toHaveBeenCalled()
    expect(api.requests).toHaveLength(0)
  })
})

describe('图片读取正文仍在同一个时限中', () => {
  it.each(['timeout', 'cancel'] as const)('HTTP 头已到但正文挂住：%s 后没有迟到成功', async (stop) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = { stopped: true }
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    let signal: AbortSignal | null | undefined
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        stream = value
        value.enqueue(DATA)
      },
    })
    // 模拟不理 fetch abort 的正文：外层依然必须按时结束，并消费迟到兑现/拒绝。
    cleanup.push(() => {
      stream?.close()
      stream = undefined
    })
    installFakeApi({ [`GET ${SOURCE}`]: (init) => {
      signal = init?.signal
      return new Response(body, { headers: { 'content-type': 'image/png', 'x-asset-status': '200' } })
    } })
    let outcome: unknown
    const task = readAsset(SOURCE, { signal: controller.signal }).then((value) => {
      outcome = value
    }, (error: unknown) => {
      outcome = error
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBeUndefined()
    if (stop === 'timeout')
      await vi.advanceTimersByTimeAsync(29_999)
    else
      controller.abort(reason)
    await task
    const stopped = outcome
    if (stop === 'timeout')
      expect(stopped).toMatchObject({ name: 'RequestTimeoutError', timeoutMs: 30_000 })
    else
      expect(stopped).toBe(reason)
    expect(signal?.aborted).toBe(true)
    stream?.enqueue(DATA)
    stream?.close()
    stream = undefined
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBe(stopped)
    expect(vi.getTimerCount()).toBe(0)
  })
})

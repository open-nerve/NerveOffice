import type { LocalKeyHandle } from './draft-codec.ts'
import type { LocalKeyProblem } from './local-key.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, RequestTimeoutError, ResponseFormatError, setCsrfToken } from '../api/client.ts'
import { apiError, installFakeApi, json, networkFailure } from '../testing/fake-api.test-support.ts'
import { createLocalKeyKeeper, fetchLocalKey } from './local-key.ts'

const PATH = 'POST /api/local-key'

/** 测试向量（不是任何环境的密钥）：0x40…0x5f */
const RAW = new Uint8Array(Array.from({ length: 32 }, (_, index) => 0x40 + index))
const RAW_BASE64 = btoa(String.fromCharCode(...RAW))

afterEach(() => {
  vi.restoreAllMocks()
  setCsrfToken(undefined)
})

/** 用同一份原始字节独立导入的一把（核对取到的就是服务端给的那一把） */
async function referenceKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(RAW), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function roundTrips(encryptWith: CryptoKey, decryptWith: CryptoKey): Promise<boolean> {
  const iv = new Uint8Array(12).fill(7)
  const plain = new TextEncoder().encode('本机草稿')
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptWith, plain)
  const opened = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decryptWith, sealed))
  return new TextDecoder().decode(opened) === '本机草稿'
}

describe('取用本机密钥（M4-P1 设计 §3.4.9，ADR-019）', () => {
  it.each(['headers', 'body', 'error-body'] as const)('%s 挂住时 10 秒结束；迟到密钥不再导入', async (waiting) => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined
    let deliver: (response: Response) => void = () => {}
    const headers = new Promise<Response>((resolve) => {
      deliver = resolve
    })
    const response = new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: (controller) => { stream = controller },
    }), { status: waiting === 'error-body' ? 503 : 200 })
    let signal: AbortSignal | null | undefined
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      signal = init?.signal
      return waiting === 'headers' ? headers : response
    }))
    let outcome: unknown
    const requesting = fetchLocalKey().catch((error: unknown) => {
      outcome = error
    })
    try {
      await vi.advanceTimersByTimeAsync(9_999)
      expect(outcome).toBeUndefined()
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toBeInstanceOf(RequestTimeoutError)
      expect(outcome).toMatchObject({ timeoutMs: 10_000 })
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      stream?.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, key: RAW_BASE64 })))
      stream?.close()
      deliver(response)
      await requesting
      vi.useRealTimers()
    }
    expect(importKey).not.toHaveBeenCalled()
  })

  it('正文还在路上时调用方取消：保留原原因，撤掉 10 秒计时器', async () => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined
    const response = new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: (controller) => { stream = controller },
    }))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const controller = new AbortController()
    const reason = new Error('退出了这次登录')
    const requesting = fetchLocalKey(controller.signal).catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      controller.abort(reason)
      expect(await requesting).toBe(reason)
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      stream?.close()
      vi.useRealTimers()
    }
  })

  it('POST /api/local-key（带 CSRF 令牌、不带请求体）：交回版本与导入好的密钥——不可导出、AES-GCM-256、用途只有加密与解密，就是服务端给的那一把', async () => {
    setCsrfToken('csrf-lk')
    const api = installFakeApi({ [PATH]: () => json(200, { version: 3, key: RAW_BASE64 }) })
    const handle = await fetchLocalKey()
    expect(api.requests).toEqual([expect.objectContaining({ key: PATH, body: undefined })])
    expect(api.requests[0]?.headers['x-csrf-token']).toBe('csrf-lk')
    expect(handle.version).toBe(3)
    expect(handle.key.extractable).toBe(false)
    expect(handle.key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect([...handle.key.usages].sort()).toEqual(['decrypt', 'encrypt'])
    await expect(crypto.subtle.exportKey('raw', handle.key)).rejects.toMatchObject({ name: 'InvalidAccessError' })
    expect(await roundTrips(handle.key, await referenceKey())).toBe(true)
    expect(await roundTrips(await referenceKey(), handle.key)).toBe(true)
  })

  it('导入用的原始字节在导入之后清零（导入失败时同样）；导入时声明不可导出、用途只有加密与解密', async () => {
    installFakeApi({ [PATH]: () => json(200, { version: 1, key: RAW_BASE64 }) })
    const importKey = crypto.subtle.importKey.bind(crypto.subtle)
    const calls: { readonly bytes: Uint8Array, readonly extractable: boolean, readonly usages: readonly string[] }[] = []
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (format, keyData, algorithm, extractable, usages) => {
      calls.push({ bytes: keyData as Uint8Array, extractable, usages: [...usages] })
      return importKey(format as 'raw', keyData as Uint8Array<ArrayBuffer>, algorithm, extractable, usages)
    })
    await fetchLocalKey()
    expect(calls).toHaveLength(1)
    expect([calls[0]?.extractable, calls[0]?.usages]).toEqual([false, ['encrypt', 'decrypt']])
    expect(calls[0]?.bytes.byteLength).toBe(32)
    expect(Array.from(calls[0]?.bytes ?? []).every(byte => byte === 0), '原始字节没有清零').toBe(true)

    spy.mockImplementation(async (_format, keyData) => {
      calls.push({ bytes: keyData as Uint8Array, extractable: false, usages: [] })
      throw new DOMException('导入失败', 'DataError')
    })
    await expect(fetchLocalKey()).rejects.toMatchObject({ name: 'DataError' })
    expect(Array.from(calls[1]?.bytes ?? [1]).every(byte => byte === 0), '导入失败时原始字节没有清零').toBe(true)
  })

  it('响应不合契约（版本不是正整数、密钥不是 32 字节的规范 base64）：ResponseFormatError，不导入', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const bad = [
      { version: 0, key: RAW_BASE64 },
      { version: 1.5, key: RAW_BASE64 },
      { version: 1, key: RAW_BASE64.slice(0, 43) },
      { version: 1, key: `${RAW_BASE64.slice(0, 42)}B=` },
      { version: 1, key: btoa(String.fromCharCode(...new Uint8Array(31))) },
      { version: 1 },
    ]
    for (const body of bad) {
      installFakeApi({ [PATH]: () => json(200, body) })
      await expect(fetchLocalKey(), JSON.stringify(body)).rejects.toBeInstanceOf(ResponseFormatError)
    }
    expect(importKey).not.toHaveBeenCalled()
  })

  it('请求的错误照常抛出：会话类（401、CSRF）是 ApiError，断网是 NetworkError，取消时原样抛出', async () => {
    installFakeApi({ [PATH]: () => apiError(401, 'SESSION_EXPIRED') })
    await expect(fetchLocalKey()).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' })
    installFakeApi({ [PATH]: () => apiError(403, 'CSRF_TOKEN_INVALID') })
    await expect(fetchLocalKey()).rejects.toBeInstanceOf(ApiError)
    installFakeApi({ [PATH]: () => networkFailure() })
    await expect(fetchLocalKey()).rejects.toBeInstanceOf(NetworkError)
    const controller = new AbortController()
    installFakeApi({ [PATH]: async (init) => {
      controller.abort()
      throw init?.signal?.reason ?? new DOMException('取消', 'AbortError')
    } })
    await expect(fetchLocalKey(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

// ---- 保管者 ----

interface Timer {
  readonly at: number
  readonly callback: () => void
  cancelled: boolean
}

/** 假的时钟：时间只在 advance 时前进，到点的计时器按时间顺序执行 */
function fakeClock(start = 1_000) {
  let now = start
  const timers: Timer[] = []
  return {
    clock: {
      now: () => now,
      schedule: (callback: () => void, delayMs: number) => {
        const timer: Timer = { at: now + delayMs, callback, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
    },
    now: () => now,
    advance: async (ms: number) => {
      const target = now + ms
      for (;;) {
        await settle()
        const due = timers.filter(timer => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined)
          break
        now = due.at
        due.cancelled = true
        due.callback()
      }
      now = target
      await settle()
    },
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 可控的取用：每次调用排一个，由用例决定它成功、失败或一直不回来 */
function controllableFetch() {
  const calls: { readonly signal: AbortSignal, readonly resolve: (handle: LocalKeyHandle) => void, readonly reject: (error: unknown) => void }[] = []
  const fetch = async (signal: AbortSignal): Promise<LocalKeyHandle> => new Promise((resolve, reject) => {
    calls.push({ signal, resolve, reject })
  })
  return { fetch, calls }
}

async function handleOf(version: number): Promise<LocalKeyHandle> {
  return { version, key: await referenceKey() }
}

const RETRY = { initialMs: 2_000, maxMs: 60_000 }
const TIMEOUT_MS = 10_000

function keeperWith(fetch: (signal: AbortSignal) => Promise<LocalKeyHandle>, clock = fakeClock()) {
  const keeper = createLocalKeyKeeper({ fetch, clock: clock.clock, retry: RETRY, requestTimeoutMs: TIMEOUT_MS })
  const seen: (number | undefined)[] = []
  keeper.subscribe(handle => seen.push(handle?.version))
  return { keeper, clock, seen }
}

describe('本机密钥的保管者（M4-P1 设计 §3.4.9）', () => {
  it('取到之后放在内存里：之后的 ensure 不再发请求；订阅者得知一次', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    expect(keeper.current()).toBeUndefined()
    const first = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    expect((await first as LocalKeyHandle).version).toBe(1)
    expect(keeper.current()?.version).toBe(1)
    expect((await keeper.ensure() as LocalKeyHandle).version).toBe(1)
    expect(remote.calls).toHaveLength(1)
    expect(seen).toEqual([1])
  })

  it('同时只有一个取用在途：并发的 ensure 共用同一个请求、得到同一把', async () => {
    const remote = controllableFetch()
    const { keeper } = keeperWith(remote.fetch)
    const all = Promise.all([keeper.ensure(), keeper.ensure(), keeper.ensure()])
    await settle()
    expect(remote.calls).toHaveLength(1)
    const handle = await handleOf(2)
    remote.calls[0]?.resolve(handle)
    expect(await all).toEqual([handle, handle, handle])
  })

  it('时限：请求一直不回来，到点取消它、按"暂时取不到"退避；之后才回来的结果不用', async () => {
    const remote = controllableFetch()
    const { keeper, clock, seen } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    await clock.advance(TIMEOUT_MS - 1)
    expect(remote.calls[0]?.signal.aborted).toBe(false)
    await clock.advance(1)
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    expect(remote.calls[0]?.signal.aborted).toBe(true)
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(keeper.current()).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('网络与 5xx 按退避：退避期间 ensure 不发请求、交回同一个 retryAt；到点再取，又失败就翻倍，至多 maxMs；取到之后从头算', async () => {
    const remote = controllableFetch()
    const { keeper, clock } = keeperWith(remote.fetch)
    const expected: number[] = []
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const pending = keeper.ensure()
      remote.calls.at(-1)?.reject(new NetworkError('断网'))
      const problem = await pending as LocalKeyProblem
      expect(problem).toEqual({ kind: 'unavailable', retryAt: clock.now() + delay })
      expected.push(delay)
      // 退避期间：不发请求
      const calls = remote.calls.length
      await clock.advance(delay - 1)
      expect(await keeper.ensure()).toEqual(problem)
      expect(remote.calls).toHaveLength(calls)
      await clock.advance(1)
    }
    const pending = keeper.ensure()
    remote.calls.at(-1)?.resolve(await handleOf(1))
    expect((await pending as LocalKeyHandle).version).toBe(1)
    // 取到之后丢掉（版本变了），再失败时退避从头算
    keeper.observeVersion(2)
    remote.calls.at(-1)?.reject(new ApiError(500, 'INTERNAL_ERROR', '解不开'))
    await settle()
    expect(await keeper.ensure()).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    expect(expected).toHaveLength(7)
  })

  it('服务端给的 Retry-After 比退避长时按它（至多 maxMs）', async () => {
    const remote = controllableFetch()
    const { keeper, clock } = keeperWith(remote.fetch)
    let pending = keeper.ensure()
    remote.calls[0]?.reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 30 }))
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + 30_000 })
    await clock.advance(30_000)
    pending = keeper.ensure()
    remote.calls[1]?.reject(new ApiError(429, 'RATE_LIMITED', '太频繁', { retryAfterSeconds: 3_600 }))
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.maxMs })
  })

  it('会话类失败交给页面确认会话：连着的第一次，确认之后立即再取；连着的第二次起照样交给页面，但按退避再取（不重试成风暴）；取到之后从头算', async () => {
    const remote = controllableFetch()
    const { keeper, clock } = keeperWith(remote.fetch)
    const expired = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    let pending = keeper.ensure()
    remote.calls[0]?.reject(expired)
    expect(await pending).toEqual({ kind: 'session', error: expired })
    // 页面确认会话之后再要：立即再取
    pending = keeper.ensure()
    await settle()
    expect(remote.calls).toHaveLength(2)
    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '令牌不对')
    remote.calls[1]?.reject(csrf)
    expect(await pending).toEqual({ kind: 'session', error: csrf })
    // 第二次起：确认之后再要，在退避结束之前不发请求
    expect(await keeper.ensure()).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    expect(remote.calls).toHaveLength(2)
    await clock.advance(RETRY.initialMs)
    pending = keeper.ensure()
    remote.calls[2]?.resolve(await handleOf(4))
    expect((await pending as LocalKeyHandle).version).toBe(4)
    // 取到之后从头算：再遇到一次会话类失败，又是"确认之后立即再取"
    keeper.observeVersion(5)
    remote.calls[3]?.reject(expired)
    await settle()
    pending = keeper.ensure()
    await settle()
    expect(remote.calls).toHaveLength(5)
    remote.calls[4]?.resolve(await handleOf(5))
    expect((await pending as LocalKeyHandle).version).toBe(5)
  })

  it('别的失败（回包不合契约、别的 4xx）同样按"暂时取不到"退避', async () => {
    const remote = controllableFetch()
    const { keeper, clock } = keeperWith(remote.fetch)
    let pending = keeper.ensure()
    remote.calls[0]?.reject(new ResponseFormatError('不合契约'))
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    await clock.advance(RETRY.initialMs)
    pending = keeper.ensure()
    remote.calls[1]?.reject(new ApiError(404, 'NOT_FOUND', '不存在'))
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + 2 * RETRY.initialMs })
  })

  it('心跳带来的版本：相同不动；不同就停用旧的（订阅者得知 undefined）、重取；手里没有密钥时不发请求', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    keeper.observeVersion(1)
    expect(remote.calls).toHaveLength(0)
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await pending
    keeper.observeVersion(1)
    expect(remote.calls).toHaveLength(1)
    keeper.observeVersion(2)
    expect(keeper.current()).toBeUndefined()
    expect(remote.calls).toHaveLength(2)
    remote.calls[1]?.resolve(await handleOf(2))
    await settle()
    expect(keeper.current()?.version).toBe(2)
    // 服务端说没有密钥（null）：手里这一把同样停用、重取
    keeper.observeVersion(null)
    expect(keeper.current()).toBeUndefined()
    remote.calls[2]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([1, undefined, 2, undefined, 1])
  })

  it('丢掉（退出登录、换人）：停用当前的、取消在途的请求；在途的 ensure 交回 discarded，回来的密钥不用；之后的 ensure 重新取', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    let pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await pending
    keeper.discard()
    expect(keeper.current()).toBeUndefined()
    pending = keeper.ensure()
    await settle()
    keeper.discard()
    expect(remote.calls[1]?.signal.aborted).toBe(true)
    remote.calls[1]?.resolve(await handleOf(1))
    expect(await pending).toEqual({ kind: 'discarded' })
    expect(keeper.current()).toBeUndefined()
    pending = keeper.ensure()
    await settle()
    expect(remote.calls).toHaveLength(3)
    remote.calls[2]?.resolve(await handleOf(2))
    expect((await pending as LocalKeyHandle).version).toBe(2)
    expect(seen).toEqual([1, undefined, 2])
  })

  it('取用途中观察到新版：不发布晚到的旧钥，并发 ensure 共用紧接的一次重取', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    const first = keeper.ensure()
    keeper.observeVersion(2)
    const joined = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([])
    expect(keeper.current()).toBeUndefined()
    expect(remote.calls).toHaveLength(2)
    const latest = keeper.ensure()
    const handle = await handleOf(2)
    remote.calls[1]?.resolve(handle)
    expect(await Promise.all([first, joined, latest])).toEqual([handle, handle, handle])
    expect(seen).toEqual([2])
    expect(remote.calls).toHaveLength(2)
  })

  it('没有密钥时也记住最高数字版本但不取用；旧数字心跳不能降低要求', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    keeper.observeVersion(2)
    keeper.observeVersion(1)
    expect(remote.calls).toHaveLength(0)
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
    const handle = await handleOf(3)
    remote.calls[1]?.resolve(handle)
    expect(await pending).toBe(handle)
    keeper.observeVersion(2)
    keeper.observeVersion(1)
    expect(keeper.current()).toBe(handle)
    expect(remote.calls).toHaveLength(2)
    expect(seen).toEqual([3])
  })

  it('响应比已观察版本更高时可用；旧数字心跳不能停掉已取到的新版', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    keeper.observeVersion(2)
    const handle = await handleOf(3)
    remote.calls[0]?.resolve(handle)
    expect(await pending).toBe(handle)
    keeper.observeVersion(2)
    expect(keeper.current()).toBe(handle)
    expect(seen).toEqual([3])
    expect(remote.calls).toHaveLength(1)
  })

  it('连续旧回包每轮只重取一次，仍旧则退避；下一轮沿用版本要求且退避递增', async () => {
    const remote = controllableFetch()
    const { keeper, clock, seen } = keeperWith(remote.fetch)
    keeper.observeVersion(2)
    for (const [round, delay] of [2_000, 4_000, 8_000].entries()) {
      const pending = keeper.ensure()
      remote.calls[round * 2]?.resolve(await handleOf(1))
      await settle()
      expect(seen).toEqual([])
      expect(remote.calls).toHaveLength(round * 2 + 2)
      remote.calls[round * 2 + 1]?.resolve(await handleOf(1))
      expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + delay })
      expect(keeper.current()).toBeUndefined()
      await clock.advance(delay - 1)
      expect(await keeper.ensure()).toEqual({ kind: 'unavailable', retryAt: clock.now() + 1 })
      expect(remote.calls).toHaveLength(round * 2 + 2)
      await clock.advance(1)
    }
    const pending = keeper.ensure()
    const handle = await handleOf(2)
    remote.calls[6]?.resolve(handle)
    expect(await pending).toBe(handle)
    expect(seen).toEqual([2])
  })

  it('取用途中新观察到 null：作废原回包；相同 null 不作废重取，允许取得重新建立的较低版本', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    keeper.observeVersion(5)
    const pending = keeper.ensure()
    keeper.observeVersion(null)
    remote.calls[0]?.resolve(await handleOf(5))
    await settle()
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
    keeper.observeVersion(null)
    const handle = await handleOf(1)
    remote.calls[1]?.resolve(handle)
    expect(await pending).toBe(handle)
    expect(seen).toEqual([1])
    expect(remote.calls).toHaveLength(2)
  })

  it('重取途中再次发生版本清空也不循环取用；只交回退避，连中间曾满足数字要求的旧回包也不发布', async () => {
    const remote = controllableFetch()
    const { keeper, clock, seen } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    keeper.observeVersion(null)
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
    keeper.observeVersion(2)
    keeper.observeVersion(null)
    remote.calls[1]?.resolve(await handleOf(2))
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
  })

  it('重取仍有完整的时限：到点取消并退避，旧响应晚到不发布', async () => {
    const remote = controllableFetch()
    const { keeper, clock, seen } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    await clock.advance(9_000)
    keeper.observeVersion(2)
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
    await clock.advance(TIMEOUT_MS - 1)
    expect(remote.calls[1]?.signal.aborted).toBe(false)
    await clock.advance(1)
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    expect(remote.calls[1]?.signal.aborted).toBe(true)
    remote.calls[1]?.resolve(await handleOf(2))
    await settle()
    expect(seen).toEqual([])
    expect(keeper.current()).toBeUndefined()
  })

  it.each([
    { error: new ApiError(401, 'SESSION_EXPIRED', '登录已过期'), kind: 'session' },
    { error: new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 30 }), kind: 'unavailable' },
  ])('重取失败保留原有的 $kind 处理', async ({ error, kind }) => {
    const remote = controllableFetch()
    const { keeper, clock, seen } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    keeper.observeVersion(2)
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
    remote.calls[1]?.reject(error)
    expect(await pending).toEqual(kind === 'session'
      ? { kind, error }
      : { kind, retryAt: clock.now() + 30_000 })
    expect(seen).toEqual([])
  })

  it('discard 清掉版本要求；旧重取完成不能解除新登录的 pending 或取消新请求', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    const old = keeper.ensure()
    keeper.observeVersion(7)
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(seen).toEqual([])
    expect(remote.calls).toHaveLength(2)
    keeper.discard()
    expect(remote.calls[1]?.signal.aborted).toBe(true)
    const fresh = keeper.ensure()
    remote.calls[1]?.resolve(await handleOf(7))
    expect(await old).toEqual({ kind: 'discarded' })
    const joined = keeper.ensure()
    expect(remote.calls).toHaveLength(3)
    const handle = await handleOf(1)
    remote.calls[2]?.resolve(handle)
    expect(await Promise.all([fresh, joined])).toEqual([handle, handle])
    expect(seen).toEqual([1])
    expect(remote.calls[2]?.signal.aborted).toBe(false)
  })

  it('停用通知中同步退出登录：observeVersion 不得在 discard 之后自行重新取钥', async () => {
    const remote = controllableFetch()
    const { keeper, seen } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await pending
    keeper.subscribe((handle) => {
      if (handle === undefined)
        keeper.discard()
    })
    keeper.observeVersion(2)
    expect(remote.calls).toHaveLength(1)
    expect(keeper.current()).toBeUndefined()
    expect(seen).toEqual([1, undefined])
  })

  it('新钥通知中 discard 并重新 ensure：旧调用 discarded，嵌套通知后不能再给剩余订阅者发旧钥', async () => {
    const remote = controllableFetch()
    const { keeper } = keeperWith(remote.fetch)
    let fresh: Promise<LocalKeyHandle | LocalKeyProblem> | undefined
    keeper.subscribe((handle) => {
      if (handle?.version === 7) {
        keeper.discard()
        fresh = keeper.ensure()
      }
    })
    const lastSubscriber: (number | undefined)[] = []
    keeper.subscribe(handle => lastSubscriber.push(handle?.version))
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(7))
    expect(await pending).toEqual({ kind: 'discarded' })
    expect(lastSubscriber).toEqual([undefined])
    expect(remote.calls).toHaveLength(2)
    const joined = keeper.ensure()
    expect(remote.calls).toHaveLength(2)
    const handle = await handleOf(1)
    remote.calls[1]?.resolve(handle)
    expect(await Promise.all([fresh, joined])).toEqual([handle, handle])
    expect(lastSubscriber).toEqual([undefined, 1])
  })

  it('新钥通知中观察到更新版本：原 ensure 取得新版，不交回已停用的旧钥', async () => {
    const remote = controllableFetch()
    const { keeper } = keeperWith(remote.fetch)
    keeper.subscribe((handle) => {
      if (handle?.version === 1)
        keeper.observeVersion(2)
    })
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(remote.calls).toHaveLength(2)
    const handle = await handleOf(2)
    remote.calls[1]?.resolve(handle)
    expect(await pending).toBe(handle)
    expect(keeper.current()).toBe(handle)
  })

  it('新钥通知中连续观察到更新版本：原 ensure 有界重取，不加入自己后交回已停用的旧钥', async () => {
    const remote = controllableFetch()
    const { keeper, clock } = keeperWith(remote.fetch)
    keeper.subscribe((handle) => {
      if (handle !== undefined)
        keeper.observeVersion(handle.version + 1)
    })
    const lastSubscriber: (number | undefined)[] = []
    keeper.subscribe(handle => lastSubscriber.push(handle?.version))
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await settle()
    expect(remote.calls).toHaveLength(2)
    expect(lastSubscriber).toEqual([undefined])
    remote.calls[1]?.resolve(await handleOf(2))
    expect(await pending).toEqual({ kind: 'unavailable', retryAt: clock.now() + RETRY.initialMs })
    expect(keeper.current()).toBeUndefined()
    expect(remote.calls).toHaveLength(2)
    expect(lastSubscriber).toEqual([undefined, undefined])
    // 通知中已停用的候选不能清掉上一轮退避。
    await clock.advance(RETRY.initialMs)
    const next = keeper.ensure()
    remote.calls[2]?.resolve(await handleOf(3))
    await settle()
    expect(remote.calls).toHaveLength(4)
    remote.calls[3]?.resolve(await handleOf(4))
    expect(await next).toEqual({ kind: 'unavailable', retryAt: clock.now() + 2 * RETRY.initialMs })
    expect(remote.calls).toHaveLength(4)
  })

  it('丢掉会清掉退避与会话类失败的计数：换了人之后立即可以取', async () => {
    const remote = controllableFetch()
    const { keeper } = keeperWith(remote.fetch)
    const pending = keeper.ensure()
    remote.calls[0]?.reject(new NetworkError('断网'))
    expect((await pending as LocalKeyProblem).kind).toBe('unavailable')
    keeper.discard()
    void keeper.ensure()
    await settle()
    expect(remote.calls).toHaveLength(2)
  })

  it('退订之后不再得知', async () => {
    const remote = controllableFetch()
    const { keeper } = keeperWith(remote.fetch)
    const later: (number | undefined)[] = []
    const unsubscribe = keeper.subscribe(handle => later.push(handle?.version))
    unsubscribe()
    const pending = keeper.ensure()
    remote.calls[0]?.resolve(await handleOf(1))
    await pending
    expect(later).toEqual([])
  })
})

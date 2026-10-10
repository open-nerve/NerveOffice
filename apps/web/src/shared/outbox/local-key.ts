// 本机密钥的客户端（M4-P1 设计 §3.4.9，M4 总设计 §6.5，ADR-019）：取用与保管。
// - 取用：POST /api/local-key（请求层自动带 CSRF 令牌）→ 按契约校验 → 导入（local-key-import.ts：恰好 32 字节、不可导出、
//   用途只有加密与解密、原始字节清零）。
// - 保管者：密钥只在内存里；同时只有一个取用在途；会话类失败交给页面确认会话，连着的第一次确认之后立即再取；别的失败按"暂时取不到"退避，
//   不重试成风暴；心跳带来的新版先停用旧的，取用期间也记住版本；旧回包最多立即重取一次；退出登录、换人时丢掉。计时一律经注入的时钟。
// 只在主线程：这里引用带 zod 的契约与请求层，发件箱 Worker 不引用这个文件（Worker 拿到的是导入好的 CryptoKey，类型在 draft-codec.ts）
import type { LocalKeyHandle } from './draft-codec.ts'
import { localKeySchema } from '@nerve-office/contracts'
import { ApiError, apiRequest, isAuthenticationError, isCsrfTokenError } from '../api/client.ts'
import { importLocalKey } from './local-key-import.ts'

/**
 * 取当前的本机密钥（只给本人）：交回版本与导入好的密钥。请求失败时照常抛出（ApiError、NetworkError、ResponseFormatError；
 * 取消时原样抛出），由保管者归类
 */
export async function fetchLocalKey(signal?: AbortSignal): Promise<LocalKeyHandle> {
  return importLocalKey(await apiRequest('/api/local-key', { method: 'POST', schema: localKeySchema, signal, timeoutMs: 10_000 }))
}

/** 取不到时的原因 */
export type LocalKeyProblem
  /** 会话类的失败（未登录、登录过期、CSRF 令牌不对）：交给页面确认会话。连着的第一次，确认之后再要就立即再取 */
  = | { readonly kind: 'session', readonly error: unknown }
  /** 暂时取不到（网络、5xx、时限、回包不对，以及连着第二次起的会话类失败之后）：retryAt 之前不发请求（clock.now 的时间轴） */
    | { readonly kind: 'unavailable', readonly retryAt: number }
  /** 取用期间密钥被丢掉了（退出登录、换人）：这次的结果不用 */
    | { readonly kind: 'discarded' }

export interface LocalKeyKeeper {
  /** 手里现在的密钥；没有时为 undefined */
  readonly current: () => LocalKeyHandle | undefined
  /** 有就交回手里的；没有就取（同时只有一个取用在途，并发的调用共用它）；退避期间不发请求、交回 unavailable */
  readonly ensure: () => Promise<LocalKeyHandle | LocalKeyProblem>
  /** 心跳带来的版本：新版或 null 先停用旧钥；手里没有时只记录，不启动取用。旧数字通知不能降版 */
  readonly observeVersion: (version: number | null) => void
  /** 退出登录、换人：丢掉手里的、取消在途的请求，退避与会话类失败的计数从头算 */
  readonly discard: () => void
  /** 手里的密钥换了（取到新的、停用、丢掉）时得知；交回退订的函数 */
  readonly subscribe: (listener: (key: LocalKeyHandle | undefined) => void) => () => void
}

export interface LocalKeyKeeperOptions {
  /** 取一次（生产是 fetchLocalKey）：保管者带上取消用的 signal */
  readonly fetch: (signal: AbortSignal) => Promise<LocalKeyHandle>
  /** 单调的"现在"与计时器（编辑器页传 browserLeaseClock：E2E 的 page.clock 拨得动） */
  readonly clock: { readonly now: () => number, readonly schedule: (callback: () => void, delayMs: number) => () => void }
  /** 退避：从 initialMs 起每次失败翻倍，至多 maxMs；服务端给的 Retry-After 更长时按它，同样至多 maxMs */
  readonly retry: { readonly initialMs: number, readonly maxMs: number }
  /** 一次取用最多等多久：到点取消、按暂时取不到处理（请求挂住也不挂住页面） */
  readonly requestTimeoutMs: number
}

/** 一次取用的结局 */
type Attempt
  = | { readonly kind: 'fetched', readonly key: LocalKeyHandle }
    | { readonly kind: 'failed', readonly error: unknown }

export function createLocalKeyKeeper(options: LocalKeyKeeperOptions): LocalKeyKeeper {
  let key: LocalKeyHandle | undefined
  /** 在途的取用（并发的 ensure 共用）与它的取消 */
  let pending: Promise<LocalKeyHandle | LocalKeyProblem> | undefined
  let cancelPending: (() => void) | undefined
  /** 每次丢掉（discard）加一：在途的取用回来时代已经换了，结果不用 */
  let generation = 0
  /** 数字版本只升不降；null 表示已观察到清空，之后允许重新建立较低版本 */
  let observedVersion: number | null | undefined
  /** 清空之前已发出的取用不能发布，即使它的数字版本满足之后的要求 */
  let clearedVersion = 0
  /** 连着的会话类失败（取到之后、丢掉之后清零） */
  let sessionFailures = 0
  /** 下一次退避的时长（0：还没失败过，或者取到之后从头算） */
  let backoffMs = 0
  let retryAt: number | undefined
  let publication = 0
  const listeners = new Set<(key: LocalKeyHandle | undefined) => void>()

  function publish(next: LocalKeyHandle | undefined): void {
    const publishing = ++publication
    key = next
    for (const listener of [...listeners]) {
      // 订阅者可同步退出登录或停用这把钥匙；剩余订阅者不能在嵌套的停用通知之后又拿到旧钥。
      if (publication !== publishing)
        break
      listener(next)
    }
  }

  /** 记下一次失败的退避，交回到点的时刻：从 initialMs 起翻倍，至多 maxMs；Retry-After 更长时按它（同样至多 maxMs） */
  function backOff(error: unknown): number {
    backoffMs = backoffMs === 0 ? options.retry.initialMs : Math.min(backoffMs * 2, options.retry.maxMs)
    const retryAfterMs = error instanceof ApiError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : 0
    retryAt = options.clock.now() + Math.min(Math.max(backoffMs, retryAfterMs), options.retry.maxMs)
    return retryAt
  }

  /** 取一次，带时限：到点取消请求、按失败交回（请求之后才回来的结果不看） */
  async function fetchWithin(controller: AbortController): Promise<Attempt> {
    return new Promise((resolve) => {
      const cancelTimer = options.clock.schedule(() => {
        controller.abort()
        resolve({ kind: 'failed', error: new DOMException('取本机密钥超过了时限', 'TimeoutError') })
      }, options.requestTimeoutMs)
      options.fetch(controller.signal).then(
        (fetched) => {
          cancelTimer()
          resolve({ kind: 'fetched', key: fetched })
        },
        (error: unknown) => {
          cancelTimer()
          resolve({ kind: 'failed', error })
        },
      )
    })
  }

  async function attempt(): Promise<LocalKeyHandle | LocalKeyProblem> {
    const started = generation
    for (let count = 0; count < 2; count += 1) {
      const clearedAtStart = clearedVersion
      const controller = new AbortController()
      const cancel = () => controller.abort()
      cancelPending = cancel
      const outcome = await fetchWithin(controller)
      if (generation !== started)
        return { kind: 'discarded' }
      if (cancelPending === cancel)
        cancelPending = undefined
      if (outcome.kind === 'failed')
        return failed(outcome.error)
      if (clearedAtStart !== clearedVersion || (typeof observedVersion === 'number' && outcome.key.version < observedVersion))
        continue
      observedVersion = outcome.key.version
      publish(outcome.key)
      if (generation !== started)
        return { kind: 'discarded' }
      if (key !== outcome.key)
        continue
      sessionFailures = 0
      backoffMs = 0
      retryAt = undefined
      return outcome.key
    }
    // 旧回包不算成功；每轮只紧接再取一次，仍旧则沿用原退避，不能被心跳推成请求风暴。
    return { kind: 'unavailable', retryAt: backOff(undefined) }
  }

  function failed(error: unknown): LocalKeyProblem {
    if (isAuthenticationError(error) || isCsrfTokenError(error)) {
      sessionFailures += 1
      // 连着的第二次起：页面确认会话照常是本人、服务端却一直拒绝（例如网关剥掉了 CSRF 的请求头），确认之后立即再取只会再被拒——
      // 照样交给页面，但按退避再取（与续租的做法相同，M3 复验 C1）
      if (sessionFailures > 1)
        backOff(error)
      return { kind: 'session', error }
    }
    return { kind: 'unavailable', retryAt: backOff(error) }
  }

  const keeper: LocalKeyKeeper = {
    current: () => key,
    ensure: async () => {
      if (key !== undefined)
        return key
      if (pending !== undefined)
        return pending
      if (retryAt !== undefined && options.clock.now() < retryAt)
        return { kind: 'unavailable', retryAt }
      const current = attempt()
      pending = current
      void current.finally(() => {
        if (pending === current)
          pending = undefined
      })
      return current
    },
    observeVersion: (version) => {
      if (version === observedVersion || (typeof observedVersion === 'number' && version !== null && version < observedVersion))
        return
      if (version === null)
        clearedVersion += 1
      observedVersion = version
      if (key === undefined)
        return
      // 服务端说当前有新版或已清空：先停用旧的（订阅者随即换下它），再重取。
      const stopped = generation
      publish(undefined)
      if (generation === stopped)
        void keeper.ensure()
    },
    discard: () => {
      generation += 1
      cancelPending?.()
      cancelPending = undefined
      pending = undefined
      observedVersion = undefined
      clearedVersion = 0
      sessionFailures = 0
      backoffMs = 0
      retryAt = undefined
      if (key !== undefined)
        publish(undefined)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return keeper
}

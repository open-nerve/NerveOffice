import type { ConnectionState } from './connection-state.ts'

export interface ConnectionClock {
  readonly setTimeout: (callback: () => void, delay: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface BrowserConnectionOptions {
  readonly state: ConnectionState
  readonly target?: EventTarget
  readonly online?: () => boolean
  readonly clock?: ConnectionClock
  /** 经正常请求层复核；该层发布结果。这里不采纳会话或改动 CSRF。 */
  readonly probe: (signal: AbortSignal) => Promise<unknown>
}

/** 每页一份；浏览器明确离线时不探测，异常时单飞并退避，不自动重放写操作。 */
export function watchBrowserConnection(options: BrowserConnectionOptions): () => void {
  const { state, probe } = options
  const target = options.target ?? window
  const online = options.online ?? (() => navigator.onLine)
  const clock = options.clock ?? {
    setTimeout: (callback: () => void, delay: number) => window.setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
  }
  let disposed = false
  let timer: unknown
  let pending: AbortController | undefined
  let attempts = 0
  let immediate = false

  function clearTimer(): void {
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
  }

  function reconcile(): void {
    if (disposed)
      return
    const current = state.view()
    if (!current.browserOnline || current.available) {
      clearTimer()
      attempts = 0
      immediate = false
      if (!current.browserOnline)
        pending?.abort()
      return
    }
    if (pending !== undefined || timer !== undefined)
      return
    if (immediate) {
      run()
      return
    }
    timer = clock.setTimeout(() => {
      timer = undefined
      run()
    }, Math.min(2000 * 2 ** Math.min(attempts, 4), 30_000))
  }

  function run(): void {
    const current = state.view()
    if (disposed || pending !== undefined || !current.browserOnline || current.available)
      return
    clearTimer()
    immediate = false
    attempts += 1
    const controller = new AbortController()
    pending = controller
    void (async () => {
      try {
        await probe(controller.signal)
      }
      catch {
        // 结果的网络/业务分类属于请求层；仍异常时只安排下一次复核。
      }
      finally {
        pending = undefined
        reconcile()
      }
    })()
  }

  function onNetwork(): void {
    const before = state.view().browserOnline
    const next = online()
    state.setBrowserOnline(next)
    if (!before && next) {
      clearTimer()
      immediate = true
      reconcile()
    }
  }

  state.setBrowserOnline(online())
  const unsubscribe = state.subscribe(reconcile)
  target.addEventListener('online', onNetwork)
  target.addEventListener('offline', onNetwork)
  target.addEventListener('pagehide', dispose)
  reconcile()

  function dispose(): void {
    if (disposed)
      return
    disposed = true
    unsubscribe()
    clearTimer()
    pending?.abort()
    target.removeEventListener('online', onNetwork)
    target.removeEventListener('offline', onNetwork)
    target.removeEventListener('pagehide', dispose)
  }

  return dispose
}

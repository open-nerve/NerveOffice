import type { SessionResponse } from '@nerve-office/contracts'

/** 一轮显示读取的失败；轮次替换后，旧请求不能向新一轮登记失败。 */
export interface ImageReadFailures {
  readonly has: (source: string) => boolean
  readonly add: (source: string) => void
}

export function createImageReadFailures(): ImageReadFailures {
  const sources = new Set<string>()
  return { has: source => sources.has(source), add: source => sources.add(source) }
}

export interface SessionImageAccessController {
  readonly owner: string
  readonly current: () => SessionResponse | undefined
  readonly subscribe: (listener: () => void) => () => void
  readonly readFailures: () => ImageReadFailures
  readonly resetReadFailures: () => void
  readonly confirm: (session: SessionResponse) => void
  readonly refresh: () => void
  readonly suspend: () => void
  readonly dispose: () => void
}

export function createSessionImageAccess(owner: string, options: { readonly preserveReadFailures?: boolean } = {}): SessionImageAccessController {
  let current: SessionResponse | undefined
  let lastConfirmed: SessionResponse | undefined
  let readFailures = createImageReadFailures()
  let disposed = false
  const listeners = new Set<() => void>()
  function notify(): void {
    for (const listener of [...listeners])
      listener()
  }
  function suspend(): void {
    if (current === undefined)
      return
    current = undefined
    notify()
  }
  return {
    owner,
    current: () => current,
    readFailures: () => readFailures,
    resetReadFailures: () => {
      if (!disposed)
        readFailures = createImageReadFailures()
    },
    subscribe: (listener) => {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    confirm: (session) => {
      if (disposed)
        return
      if (session.user.id !== owner) {
        lastConfirmed = undefined
        readFailures = createImageReadFailures()
        suspend()
        return
      }
      const changed = current?.csrfToken !== session.csrfToken
      // 编辑页的同身份复核只恢复许可，不自动重试失败图片。历史预览默认仍在恢复时刷新。
      if ((changed && options.preserveReadFailures !== true) || lastConfirmed?.csrfToken !== session.csrfToken)
        readFailures = createImageReadFailures()
      lastConfirmed = session
      current = session
      if (changed)
        notify()
    },
    refresh: () => {
      if (current !== undefined) {
        readFailures = createImageReadFailures()
        notify()
      }
    },
    suspend,
    dispose: () => {
      disposed = true
      lastConfirmed = undefined
      readFailures = createImageReadFailures()
      suspend()
      listeners.clear()
    },
  }
}

import type { Page } from '@playwright/test'

export interface ListFocusSnapshot {
  started: boolean
  sealed: boolean
  elapsedMs: number
  events: { atMs: number, target: 'list-search' }[]
  overflow: boolean
  expired: boolean
}

// 必须保持自包含，Playwright 直接序列化此函数到当前 document；没有产品探针或全局持久记录。
export function installListAutoFocusObserver(): { finish: () => ListFocusSnapshot } {
  const owner = document
  const startedAt = performance.now()
  const events: ListFocusSnapshot['events'] = []
  let overflow = false
  let expired = false
  let stopped = false
  let snapshot: ListFocusSnapshot | undefined
  const elapsed = () => Math.min(15_000, Math.max(0, Math.round(performance.now() - startedAt)))
  let listener: (event: FocusEvent) => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (stopped)
      return
    stopped = true
    owner.removeEventListener('focusin', listener)
    clearTimeout(timer)
  }
  listener = (event: FocusEvent) => {
    if (stopped || !(event.target as Element | null)?.matches?.('[data-u-comp="sheets-dropdown-list"] input'))
      return
    if (elapsed() >= 15_000) {
      expired = true
      stop()
      return
    }
    if (events.length === 16) {
      overflow = true
      return
    }
    events.push({ atMs: elapsed(), target: 'list-search' })
  }
  owner.addEventListener('focusin', listener)
  timer = setTimeout(() => {
    expired = true
    stop()
  }, 15_000)
  return {
    finish() {
      if (snapshot)
        return snapshot
      stop()
      expired ||= elapsed() >= 15_000
      if (document !== owner || !owner.documentElement.isConnected)
        throw new Error('list-focus-document-invalid')
      const result: ListFocusSnapshot = { started: true, sealed: true, elapsedMs: elapsed(), events, overflow, expired }
      // 仅 ASCII 固定标记与有界数字；字符长度即实际 UTF-8 字节长度。
      if (JSON.stringify(result).length > 4096)
        throw new Error('list-focus-snapshot-too-large')
      snapshot = result
      return result
    },
  }
}

export async function beginListAutoFocusObservation(page: Page): Promise<{ finish: () => Promise<ListFocusSnapshot> }> {
  const handle = await page.evaluateHandle(installListAutoFocusObserver)
  let finished: Promise<ListFocusSnapshot> | undefined
  return {
    async finish() {
      finished ??= (async () => {
        let snapshot: ListFocusSnapshot | undefined
        const errors: unknown[] = []
        try {
          snapshot = await handle.evaluate(observer => observer.finish())
        }
        catch (error) {
          errors.push(error)
        }
        try {
          await handle.dispose()
        }
        catch (error) {
          errors.push(error)
        }
        if (errors.length > 1)
          throw new AggregateError(errors, '列表焦点观察封存与 handle 清理均失败')
        if (errors.length === 1)
          throw errors[0]
        return snapshot!
      })()
      return finished
    },
  }
}

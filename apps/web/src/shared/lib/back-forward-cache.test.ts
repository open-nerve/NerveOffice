import { describe, expect, it, vi } from 'vitest'
import { reloadWhenRestoredFromCache } from './back-forward-cache.ts'

function pageshow(persisted: boolean): Event {
  return Object.assign(new Event('pageshow'), { persisted })
}

describe('reloadWhenRestoredFromCache', () => {
  it('从往返缓存恢复（persisted）：整页重新加载', () => {
    const page = new EventTarget()
    const reload = vi.fn()
    reloadWhenRestoredFromCache(page, reload)
    page.dispatchEvent(pageshow(true))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('正常加载的 pageshow：不重新加载', () => {
    const page = new EventTarget()
    const reload = vi.fn()
    reloadWhenRestoredFromCache(page, reload)
    page.dispatchEvent(pageshow(false))
    expect(reload).not.toHaveBeenCalled()
  })
})

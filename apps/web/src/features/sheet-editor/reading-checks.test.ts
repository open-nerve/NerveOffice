// 阅读时的检查：每 30 秒一次，隐藏时暂停、回到前台立即一次；只认最新发出的那一次（审查 A9）。
import type { FetchedEditStatus } from './editor-api.ts'
import type { ReadingCheckResult } from './reading-checks.ts'
import { describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../../shared/api/index.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { createReadingChecks, READING_CHECK_INTERVAL_MS } from './reading-checks.ts'

function status(revision: number): FetchedEditStatus {
  return { status: { revision, editor: null, canEdit: true }, serverTime: undefined }
}

/** 由测试决定何时回来的一次读取 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function setup() {
  const time = fakeLeaseClock()
  let hidden = false
  let allowed = true
  const visibilityListeners = new Set<() => void>()
  const fetch = vi.fn(async (): Promise<FetchedEditStatus> => status(3))
  const results: ReadingCheckResult[] = []
  const onResult = vi.fn((result: ReadingCheckResult) => {
    results.push(result)
  })
  const checks = createReadingChecks({
    clock: time.clock,
    visibility: {
      hidden: () => hidden,
      onChange: (listener) => {
        visibilityListeners.add(listener)
        return () => visibilityListeners.delete(listener)
      },
    },
    fetch,
    allowed: () => allowed,
    onResult,
  })
  return {
    checks,
    time,
    fetch,
    onResult,
    results,
    setHidden: (next: boolean) => {
      hidden = next
      visibilityListeners.forEach(listener => listener())
    },
    setAllowed: (next: boolean) => {
      allowed = next
    },
    visibilityListeners,
  }
}

describe('阅读时的检查（US-M3-05）', () => {
  it('立即读一次，交出结果，之后每 30 秒一次（同一时刻只有一个计时器）；失败照常交出、照常排下一次', async () => {
    const context = setup()
    context.checks.checkNow()
    await settle()
    expect(context.results).toEqual([{ kind: 'status', fetched: status(3) }])
    expect(context.time.pending()).toBe(1)
    const offline = new NetworkError('断网')
    context.fetch.mockRejectedValueOnce(offline)
    await context.time.advance(READING_CHECK_INTERVAL_MS - 1)
    expect(context.fetch).toHaveBeenCalledOnce()
    await context.time.advance(1)
    expect(context.results.at(-1)).toEqual({ kind: 'failed', error: offline })
    expect(context.time.pending()).toBe(1)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.fetch).toHaveBeenCalledTimes(3)
  })

  it('有一次在途时又立即读一次（例如进入编辑又退出、回到阅读）：先发出的那次回来时结果丢弃、也不排下一次，只认后一次（审查 A9）', async () => {
    const context = setup()
    const stale = deferred<FetchedEditStatus>()
    context.fetch.mockReturnValueOnce(stale.promise)
    context.checks.checkNow()
    context.checks.stop()
    context.checks.checkNow()
    await settle()
    expect(context.results).toEqual([{ kind: 'status', fetched: status(3) }])
    stale.resolve(status(9))
    await settle()
    expect(context.results).toEqual([{ kind: 'status', fetched: status(3) }])
    expect(context.time.pending()).toBe(1)
  })

  it('立即读一次时上一次还在途（没有先停下）：同样只认后一次', async () => {
    const context = setup()
    const stale = deferred<FetchedEditStatus>()
    context.fetch.mockReturnValueOnce(stale.promise)
    context.checks.checkNow()
    context.checks.checkNow()
    await settle()
    stale.reject(new NetworkError('断网'))
    await settle()
    expect(context.results).toEqual([{ kind: 'status', fetched: status(3) }])
    expect(context.time.pending()).toBe(1)
  })

  it('停下（离开阅读、会话不是本人）：取消计时器，在途的那次回来时不交出、不排下一次', async () => {
    const context = setup()
    context.checks.checkNow()
    await settle()
    const inFlight = deferred<FetchedEditStatus>()
    context.fetch.mockReturnValueOnce(inFlight.promise)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    context.checks.stop()
    inFlight.resolve(status(5))
    await settle()
    expect(context.results).toHaveLength(1)
    expect(context.time.pending()).toBe(0)
  })

  it('不能检查时（不在阅读、会话不是本人）立即读一次也不读；交出结果之后变得不能检查了就不排下一次', async () => {
    const context = setup()
    context.setAllowed(false)
    context.checks.checkNow()
    await settle()
    expect(context.fetch).not.toHaveBeenCalled()
    context.setAllowed(true)
    context.onResult.mockImplementationOnce(() => context.setAllowed(false))
    context.checks.checkNow()
    await settle()
    expect(context.onResult).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('交出结果时停下了（例如确认会话之后不是本人）：不排下一次', async () => {
    const context = setup()
    context.onResult.mockImplementationOnce(() => context.checks.stop())
    context.checks.checkNow()
    await settle()
    expect(context.time.pending()).toBe(0)
  })

  it('页面隐藏时暂停（在途的那次作废），回到前台立即读一次；卸载之后不再看可见性', async () => {
    const context = setup()
    context.checks.checkNow()
    await settle()
    const inFlight = deferred<FetchedEditStatus>()
    context.fetch.mockReturnValueOnce(inFlight.promise)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    context.setHidden(true)
    inFlight.resolve(status(5))
    await context.time.advance(READING_CHECK_INTERVAL_MS * 3)
    expect(context.fetch).toHaveBeenCalledTimes(2)
    expect(context.results).toHaveLength(1)
    context.setHidden(false)
    await settle()
    expect(context.fetch).toHaveBeenCalledTimes(3)
    expect(context.results).toHaveLength(2)
    context.checks.dispose()
    expect(context.visibilityListeners.size).toBe(0)
    expect(context.time.pending()).toBe(0)
  })
})

import type { SelftestTimelineEntry } from './selftest-report.ts'
import { EDIT_IDLE_RELEASE_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { requestBudgetMs, summarizeCancelledWaiter, WAITER_IDLE_MS, waiterShownWaitMs } from './selftest-waiter-variants.ts'

const BASE = 1_800_000_000_000
const event = (kind: string, delta: number, fields: Record<string, unknown> = {}): SelftestTimelineEntry => ({ kind, wall: BASE + delta, at: delta, ...fields })
function cancelled(): SelftestTimelineEntry[] {
  return [
    event('page:click', 0),
    event('request-sent', 20, { outcome: 'pending' }),
    event('page:visibility-hidden', 2000),
    event('page:state', 600_010, { mode: 'reading', notice: 'request-idle', visible: false }),
    event('page:visibility-visible', 605_000),
  ]
}

describe('请求方长场景的页面判定', () => {
  it('取消时限与生产空闲规则相同；只有十分钟变体延长预算和返回等待', () => {
    expect(WAITER_IDLE_MS).toBe(EDIT_IDLE_RELEASE_SECONDS * 1000)
    expect(requestBudgetMs('request-waiter')).toBe(600_000)
    expect(requestBudgetMs('paused-holder')).toBe(600_000)
    expect(requestBudgetMs('paused-local-holder')).toBe(600_000)
    expect(requestBudgetMs('request-waiter-expired')).toBe(600_000)
    expect(requestBudgetMs('request-waiter-cancelled')).toBe(1_080_000)
    expect(waiterShownWaitMs('request-waiter')).toBe(240_000)
    expect(waiterShownWaitMs('request-waiter-expired')).toBe(240_000)
    expect(waiterShownWaitMs('request-waiter-cancelled')).toBe(780_000)
  })

  it('真实等待满十分钟后取消，前台保持阅读；没有获得编辑权', () => {
    const result = summarizeCancelledWaiter(cancelled())
    expect(result.problems).toEqual([])
    expect(result.path).toBe('cancelled-after-idle')
    expect(result.ms).toMatchObject({ hiddenToShown: 603_000, clickToCancelled: 600_010 })
  })

  it('后台计时器暂停时，返回前台同步按此前空闲取消，也成立', () => {
    const events = cancelled().filter(entry => entry.kind !== 'page:state')
    events.push(event('page:state', 605_000, { mode: 'reading', notice: 'request-idle', visible: true }))
    expect(summarizeCancelledWaiter(events).problems).toEqual([])
  })

  it.each([
    ['没有隐藏', (events: SelftestTimelineEntry[]) => events.filter(entry => entry.kind !== 'page:visibility-hidden')],
    ['没有回到前台', (events: SelftestTimelineEntry[]) => events.filter(entry => entry.kind !== 'page:visibility-visible')],
    ['提前取消', (events: SelftestTimelineEntry[]) => events.map(entry => entry.notice === 'request-idle' ? { ...entry, wall: BASE + 599_999 } : entry)],
    ['后台不到十分钟', (events: SelftestTimelineEntry[]) => events.map(entry => entry.kind === 'page:visibility-visible' ? { ...entry, wall: BASE + 601_999 } : entry)],
    ['没有空闲说明', (events: SelftestTimelineEntry[]) => events.filter(entry => entry.notice !== 'request-idle')],
    ['取得了保留', (events: SelftestTimelineEntry[]) => [...events, event('request-granted', 5000, { visible: false })]],
    ['发出过申请', (events: SelftestTimelineEntry[]) => [...events, event('acquire', 605_001, { trigger: 'granted', takeover: null })]],
    ['进入了编辑', (events: SelftestTimelineEntry[]) => [...events, event('page:state', 605_001, { mode: 'editing' })]],
    ['没有发出等待请求', (events: SelftestTimelineEntry[]) => events.filter(entry => entry.kind !== 'request-sent')],
  ])('%s 不能冒充后台空闲取消', (_name, mutate) => {
    expect(summarizeCancelledWaiter(mutate(cancelled())).problems.length).toBeGreaterThan(0)
  })
})

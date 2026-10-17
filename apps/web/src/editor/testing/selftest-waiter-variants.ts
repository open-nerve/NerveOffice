// 长等待只用于明确选择的页面自检，不改变产品空闲或服务端保留期。
import type { SelftestTimelineEntry } from './selftest-report.ts'

export type WaiterScenario = 'request-waiter' | 'request-waiter-expired' | 'request-waiter-cancelled'

// 不从 contracts 运行时导入，避免早期共享分块改变 CSP 初始化顺序；单元测试核对正式常量。
export const WAITER_IDLE_MS = 600_000

export function requestBudgetMs(scenario: string): number {
  return scenario === 'request-waiter-cancelled' ? 1_080_000 : 600_000
}

export function waiterShownWaitMs(scenario: WaiterScenario): number {
  return scenario === 'request-waiter-cancelled' ? 780_000 : 240_000
}

export function summarizeCancelledWaiter(timeline: readonly SelftestTimelineEntry[]) {
  const click = timeline.find(entry => entry.kind === 'page:click')
  const sent = timeline.find(entry => entry.kind === 'request-sent')
  const origin = click?.wall ?? Number.POSITIVE_INFINITY
  const hidden = timeline.find(entry => entry.kind === 'page:visibility-hidden' && entry.wall >= origin)
  const shown = timeline.find(entry => entry.kind === 'page:visibility-visible' && entry.wall >= (hidden?.wall ?? Number.POSITIVE_INFINITY))
  const cancelled = timeline.find(entry => entry.kind === 'page:state' && entry.notice === 'request-idle' && entry.mode === 'reading' && entry.wall >= origin)
  const problems: string[] = []
  if (click === undefined || sent?.outcome !== 'pending' || sent.wall < origin)
    problems.push('缺少本页明确发出并等待的请求')
  if (hidden === undefined || shown === undefined || shown.wall - hidden.wall < WAITER_IDLE_MS)
    problems.push('没有完整的十分钟后台与返回前台记录')
  if (cancelled === undefined || cancelled.wall - origin < WAITER_IDLE_MS)
    problems.push('没有等够生产空闲时限之后的取消说明')
  if (timeline.some(entry => entry.wall >= origin && (['request-granted', 'request-enter', 'acquire', 'entered'].includes(entry.kind) || (entry.kind === 'page:state' && entry.mode === 'editing'))))
    problems.push('等待取消的这页曾取得保留、申请或进入编辑')
  const ms = {
    hiddenToShown: hidden === undefined || shown === undefined ? null : shown.wall - hidden.wall,
    clickToCancelled: click === undefined || cancelled === undefined ? null : cancelled.wall - click.wall,
  }
  return { path: problems.length === 0 ? 'cancelled-after-idle' : 'invalid-idle-cancellation', problems, ms, text: `后台 ${String(ms.hiddenToShown)} ms，发起之后 ${String(ms.clickToCancelled)} ms 因空闲取消；回到前台保持阅读` }
}

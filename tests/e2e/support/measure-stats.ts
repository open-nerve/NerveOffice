// 实测的统计与结果的格式（M3-P2 S5）：切换耗时（measure/switch.spec.ts）与反复切换的内存（measure/memory.spec.ts）共用的纯函数，
// 单元测试覆盖（measure-stats.test.ts），不起浏览器。
// - 分布：p50、p95、最大值。百分位按最近秩法（第 ceil(p × n) 个）：每组十几个样本时 p95 就是最大值或次大值，偏保守；
// - 结果文件：每个浏览器、每份文档一个 JSON（环境、负载、每次切换的时刻），汇总成 Markdown 的表（报告里用）；
// - 内存：每次之后的读数与第 2 次之后的增长斜率（最小二乘）。
import type { SwitchDirection, SwitchDurationKey, SwitchTiming } from '../../../apps/web/src/editor/testing/switch-timing.ts'
import { switchDurations } from '../../../apps/web/src/editor/testing/switch-timing.ts'

export interface Distribution {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

/** 最近秩法的百分位：排好序的 values 里第 ceil(p × n) 个（从 1 数）；p 在 0 到 1 之间 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0)
    throw new Error('没有样本')
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)))
  return sorted[rank - 1] ?? Number.NaN
}

/** 一组样本的分布；没有样本时为 null */
export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? Number.NaN, mean: Math.round(mean * 10) / 10 }
}

/** 一次切换的样本 */
export interface SwitchSample {
  readonly direction: SwitchDirection
  /** 第几次（从 1 数）；打开：1 是新的浏览器上下文里第一次打开，2 是刷新 */
  readonly round: number
  readonly timing: SwitchTiming
}

/** 一份文档在一个浏览器里的实测结果（measure/switch.spec.ts 写出） */
export interface SwitchRun {
  readonly format: 'nerve-office.switch-measure.v1'
  readonly browser: { readonly project: string, readonly version: string }
  readonly document: { readonly id: string, readonly title: string, readonly bytes: number, readonly scale: string }
  readonly startedAt: string
  readonly finishedAt: string
  /** 开始与结束时本机的负载（1、5、15 分钟） */
  readonly load: { readonly before: readonly number[], readonly after: readonly number[] }
  readonly samples: readonly SwitchSample[]
}

/** 一组（浏览器、文档、方向）里每一段的分布 */
export interface SwitchGroup {
  readonly browser: string
  readonly document: string
  readonly direction: SwitchDirection
  readonly durations: Readonly<Record<SwitchDurationKey, Distribution | null>>
}

/** 按方向分组，算出每一段的分布 */
export function switchGroups(run: SwitchRun): SwitchGroup[] {
  const directions = [...new Set(run.samples.map(sample => sample.direction))]
  return directions.map((direction) => {
    const durations = run.samples.filter(sample => sample.direction === direction).map(sample => switchDurations(sample.timing))
    const keys = Object.keys(durations[0] ?? {}) as SwitchDurationKey[]
    const byKey = Object.fromEntries(keys.map(key => [key, distribution(durations.map(item => item[key]).filter((value): value is number => value !== null))]))
    return { browser: run.browser.project, document: run.document.id, direction, durations: byKey as Record<SwitchDurationKey, Distribution | null> }
  })
}

const DIRECTION_NAMES: Readonly<Record<SwitchDirection, string>> = { open: '打开', enter: '进入编辑', exit: '退出编辑', refresh: '有更新，点击刷新' }

function ms(value: number | undefined): string {
  return value === undefined ? '—' : String(Math.round(value))
}

/** 一段的 p50 / p95 / 最大值，例如"512 / 640 / 655"；没有时是"—" */
export function triple(value: Distribution | null): string {
  return value === null ? '—' : `${ms(value.p50)} / ${ms(value.p95)} / ${ms(value.max)}`
}

/** Markdown 的表：每行一组（浏览器、文档、方向），每列一段（p50 / p95 / 最大值，毫秒） */
export function switchTable(groups: readonly SwitchGroup[], keys: readonly SwitchDurationKey[], names: Readonly<Partial<Record<SwitchDurationKey, string>>> = {}): string {
  const head = `| 浏览器 | 文档 | 方向 | n | ${keys.map(key => names[key] ?? key).join(' | ')} |`
  const rule = `|${' --- |'.repeat(4 + keys.length)}`
  const rows = groups.map(group => `| ${group.browser} | ${group.document} | ${DIRECTION_NAMES[group.direction]} | ${group.durations.ready?.n ?? group.durations.steady?.n ?? 0} | ${keys.map(key => triple(group.durations[key])).join(' | ')} |`)
  return [head, rule, ...rows].join('\n')
}

// ---- 内存 ----

/** 一次读数（每次切换之后、强制回收之后） */
export interface MemoryReading {
  /** 第几次之后（0 是打开之后、还没有切换） */
  readonly round: number
  /** Runtime.getHeapUsage 的已用堆（字节） */
  readonly usedHeap: number
  readonly totalHeap: number
  /** Memory.getDOMCounters */
  readonly documents: number
  readonly nodes: number
  readonly listeners: number
  /** page.workers().length */
  readonly workers: number
}

/** 最小二乘的斜率：y 随 x 每加一变化多少 */
export function slope(points: readonly { readonly x: number, readonly y: number }[]): number {
  if (points.length < 2)
    return 0
  const n = points.length
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n
  const covariance = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
  const variance = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  return variance === 0 ? 0 : covariance / variance
}

/** 内存的增长：第 from 次之后（含）每次的已用堆增长（KiB/次）与 DOM 节点、事件监听的增长（个/次） */
export interface MemoryTrend {
  readonly from: number
  readonly heapKiBPerRound: number
  readonly nodesPerRound: number
  readonly listenersPerRound: number
  /** 从第 from 次到最后一次，已用堆一共变了多少 KiB */
  readonly heapKiBTotal: number
}

export function memoryTrend(readings: readonly MemoryReading[], from = 2): MemoryTrend {
  const tail = readings.filter(reading => reading.round >= from)
  const along = (pick: (reading: MemoryReading) => number): number => slope(tail.map(reading => ({ x: reading.round, y: pick(reading) })))
  const first = tail[0]
  const last = tail.at(-1)
  return {
    from,
    heapKiBPerRound: Math.round(along(reading => reading.usedHeap) / 1024 * 10) / 10,
    nodesPerRound: Math.round(along(reading => reading.nodes) * 10) / 10,
    listenersPerRound: Math.round(along(reading => reading.listeners) * 10) / 10,
    heapKiBTotal: first === undefined || last === undefined ? 0 : Math.round((last.usedHeap - first.usedHeap) / 1024),
  }
}

/** Markdown 的表：每次之后的读数（堆以 MiB 计，一位小数） */
export function memoryTable(readings: readonly MemoryReading[]): string {
  const head = '| 次 | 已用堆（MiB） | 堆总量（MiB） | 文档 | DOM 节点 | 事件监听 | Worker |'
  const rule = '| --- | --- | --- | --- | --- | --- | --- |'
  const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
  const rows = readings.map(reading => `| ${reading.round} | ${mib(reading.usedHeap)} | ${mib(reading.totalHeap)} | ${reading.documents} | ${reading.nodes} | ${reading.listeners} | ${reading.workers} |`)
  return [head, rule, ...rows].join('\n')
}

// 真实 Safari 的页面自检：驱动脚本（./selftest.ts）里不碰进程与网络的部分，单元测试覆盖（./run-plan.test.ts）。
// - 一串步骤怎么接起来（chainOf、nextAfter）：每一步的入口页把结果交回收集端的 /report?step=<序号>，收集端再把页面带到下一步，
//   最后停在结束页；交接的复核（M3-P5）的几步由驱动脚本各另开一个标签页打开（opened），交回之后停在结束页，另开的 B 交回之后去一个
//   关掉自己的页（CLOSE_PATH：B 的标签页关掉，Safari 回到 A）；
// - 收集端收到的请求（parseReportRequest）；
// - 每一步的结论与退出码（outcomeOf、exitCodeOf；hidden-save 与交接的几步按库里的证据判定，serverJudgedOutcome）；结果文件的名字
//   （resultFileName）；计时的说明（timingLines：切换的耗时，与捕获时机的时间线）。
import type { SelftestReport, SelftestTiming } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SelftestStep } from '../support/selftest-plan.ts'
import { HANDOVER_SCENARIOS, RESULT_PARAM } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { problemsOf, selftestPageUrl } from '../support/selftest-plan.ts'

/** 收集端收结果的路径 */
export const REPORT_PATH = '/report'

/** 全部步骤做完之后停在这里 */
export const DONE_PATH = '/done'

/** hidden-save：驱动脚本在 Safari 里另开这一页（收集端的空白页），让编辑器页真的变成隐藏 */
export const HIDE_PATH = '/hide'

/**
 * 交接的复核里另开的 B 交回结果之后去这一页：它关掉自己的标签页（window.close：这个标签页由 open 打开、一路 location.replace，历史里只有
 * 一项，脚本可以关掉它），Safari 随之回到 A，A 从后台回来、得知锁被抢（2026-10-07 本机 Safari 27.0 的探针：关掉之后左边的标签页成为当前的）
 */
export const CLOSE_PATH = '/close'

/** 驱动脚本另开标签页打开的场景（交接的复核）：不是上一步带过去的 */
const OPENED_SCENARIOS: ReadonlySet<string> = new Set(HANDOVER_SCENARIOS)

/** 一步交回结果之后页面去哪：下一步的入口（由这一步带过去）、结束页、关掉自己的页（另开的 B） */
export type AfterReport = 'next' | 'done' | 'close'

/** 一步与它的入口地址 */
export interface ChainLink {
  readonly step: SelftestStep
  /** 入口页的地址（# 片段里有账户、文档、场景与结果交回的地址；直接打开编辑器页的那一步是编辑器页的地址） */
  readonly url: string
  /** 由驱动脚本另开标签页打开（交接的复核） */
  readonly opened: boolean
  readonly after: AfterReport
}

/** 第 index 步的结果交回的地址 */
export function reportUrlOf(collector: string, index: number): string {
  const url = new URL(REPORT_PATH, collector)
  url.searchParams.set('step', String(index))
  return url.href
}

/**
 * 每一步的入口地址：origin 是被测站点的源，collector 是收集端的源。上一步带过去的那些（不是另开的）交回之后去下一步，下一步是另开的或者
 * 没有了就去结束页；另开的交回之后去结束页，B（takeover-taker）去关掉自己的页
 */
export function chainOf(steps: readonly SelftestStep[], origin: string, collector: string): ChainLink[] {
  return steps.map((step, index) => {
    const opened = OPENED_SCENARIOS.has(step.scenario)
    const following = steps[index + 1]
    const after: AfterReport = step.scenario === 'takeover-taker' ? 'close' : !opened && following !== undefined && !OPENED_SCENARIOS.has(following.scenario) ? 'next' : 'done'
    return { step, url: selftestPageUrl(origin, step, reportUrlOf(collector, index)), opened, after }
  })
}

/** 收下第 index 步的结果之后，页面去哪：下一步的入口、结束页，或者关掉自己的页 */
export function nextAfter(chain: readonly ChainLink[], index: number, collector: string): string {
  const link = chain[index]
  if (link?.after === 'next')
    return chain[index + 1]?.url ?? new URL(DONE_PATH, collector).href
  return new URL(link?.after === 'close' ? CLOSE_PATH : DONE_PATH, collector).href
}

/** 收集端收到的一次交回：第几步、编码的结果 */
export type ReportRequest = { readonly step: number, readonly encoded: string } | { readonly error: string }

/** 解析收集端收到的地址（只认 /report?step=<序号>&result=<结果>，序号在 0 到 steps - 1 之间） */
export function parseReportRequest(url: URL, steps: number): ReportRequest {
  if (url.pathname !== REPORT_PATH)
    return { error: `不是交回结果的地址：${url.pathname}` }
  const raw = url.searchParams.get('step') ?? ''
  const step = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(step) || step < 0 || step >= steps)
    return { error: `步骤的序号不对：${raw}` }
  const encoded = url.searchParams.get(RESULT_PARAM)
  if (encoded === null || encoded === '')
    return { error: '没有结果' }
  return { step, encoded }
}

export type StepStatus = 'passed' | 'failed' | 'missing'

/** 一步的结论：通过、不通过（problems 说明），或者没有交回结果（超时） */
export interface StepOutcome {
  readonly id: string
  readonly scenario: string
  readonly documentId: string
  readonly status: StepStatus
  readonly problems: readonly string[]
  readonly report?: SelftestReport | undefined
  /** 按库里的证据判定的一步（hidden-save）：证据的说明 */
  readonly evidence?: string | undefined
}

/** 收集端收到的一步：解开的结果，或者解不开的原因 */
export type Received = SelftestReport | { readonly undecodable: string }

/** 一步的结论：没有结果是 missing；结果解不开、结果里有问题（problemsOf 的口径）是 failed */
export function outcomeOf(step: SelftestStep, received: Received | undefined): StepOutcome {
  const base = { id: step.id, scenario: step.scenario, documentId: step.documentId }
  if (received === undefined)
    return { ...base, status: 'missing', problems: ['没有交回结果（超时）'] }
  if ('undecodable' in received)
    return { ...base, status: 'failed', problems: [`交回的结果解不开：${received.undecodable}`] }
  if (received.scenario !== step.scenario || received.documentId !== step.documentId)
    return { ...base, status: 'failed', problems: [`交回的是别的一步（${received.scenario}，文档 ${received.documentId}）`], report: received }
  const problems = problemsOf(received)
  return { ...base, status: problems.length === 0 ? 'passed' : 'failed', problems, report: received }
}

/**
 * 按库里的证据判定的一步（hidden-save；交接的复核里在后台的 A）：页面在后台，结果不一定交得回来（Safari 隐藏几秒之后压低、停下计时器）。
 * 库里的证据都对（serverProblems 为空）就算通过；交回了结果时，结果里的问题照样算不通过；没交回只在说明里写明
 */
export function serverJudgedOutcome(step: SelftestStep, received: Received | undefined, serverProblems: readonly string[], evidence: string): StepOutcome {
  const base = { id: step.id, scenario: step.scenario, documentId: step.documentId, evidence }
  const page = received === undefined ? undefined : outcomeOf(step, received)
  const problems = [...serverProblems, ...(page?.problems ?? [])]
  return { ...base, status: problems.length === 0 ? 'passed' : 'failed', problems, report: page?.report }
}

/** 退出码：0 全部通过；1 有不通过的检查、页面错误或服务器上的核对不对；2 有的步没有交回结果（超时） */
export function exitCodeOf(outcomes: readonly StepOutcome[], serverProblems: readonly string[]): 0 | 1 | 2 {
  if (outcomes.some(outcome => outcome.status === 'missing'))
    return 2
  if (outcomes.some(outcome => outcome.status === 'failed') || serverProblems.length > 0)
    return 1
  return 0
}

/** 结果文件的名字：开始的时刻（UTC），文件名里不用冒号 */
export function resultFileName(startedAt: Date): string {
  return `${startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')}.json`
}

function milliseconds(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value)} ms` : '—'
}

/**
 * 计时的说明，每项一行：切换（enter-exit 交回的 switch.*，各段见 switch-timing.ts 的 switchDurations）写成点击到可以操作、到 steady，
 * 其中页头、网络与重建各多久；别的（捕获时机的时间线）逐段列出
 */
export function timingLines(timings: readonly SelftestTiming[]): string[] {
  return timings.map(({ id, ms }) => id.startsWith('switch.')
    ? `${id}：点击到可以操作 ${milliseconds(ms.ready)}、到 steady ${milliseconds(ms.steady)}（页头 ${milliseconds(ms.header)}，网络 ${milliseconds(ms.network)}，重建 ${milliseconds(ms.rebuild)}）`
    : `${id}：${Object.entries(ms).map(([key, value]) => `${key} ${milliseconds(value)}`).join('、')}`)
}

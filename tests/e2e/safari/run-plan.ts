// 真实 Safari 的页面自检：驱动脚本（./selftest.ts）里不碰进程与网络的部分，单元测试覆盖（./run-plan.test.ts）。
// - 一串步骤怎么接起来（chainOf、nextAfter）：每一步的入口页把结果交回收集端的 /report?step=<序号>，收集端再把页面带到下一步，
//   最后停在结束页；
// - 收集端收到的请求（parseReportRequest）；
// - 每一步的结论与退出码（outcomeOf、exitCodeOf）；结果文件的名字（resultFileName）；切换耗时的说明（timingLines）。
import type { SelftestReport, SelftestTiming } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SelftestStep } from '../support/selftest-plan.ts'
import { RESULT_PARAM } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { problemsOf, selftestPageUrl } from '../support/selftest-plan.ts'

/** 收集端收结果的路径 */
export const REPORT_PATH = '/report'

/** 全部步骤做完之后停在这里 */
export const DONE_PATH = '/done'

/** 一步与它的入口地址 */
export interface ChainLink {
  readonly step: SelftestStep
  /** 入口页的地址（# 片段里有账户、文档、场景与结果交回的地址） */
  readonly url: string
}

/** 第 index 步的结果交回的地址 */
export function reportUrlOf(collector: string, index: number): string {
  const url = new URL(REPORT_PATH, collector)
  url.searchParams.set('step', String(index))
  return url.href
}

/** 每一步的入口地址：origin 是被测站点的源，collector 是收集端的源 */
export function chainOf(steps: readonly SelftestStep[], origin: string, collector: string): ChainLink[] {
  return steps.map((step, index) => ({ step, url: selftestPageUrl(origin, step, reportUrlOf(collector, index)) }))
}

/** 收下第 index 步的结果之后，页面去哪：下一步的入口，或者结束页 */
export function nextAfter(chain: readonly ChainLink[], index: number, collector: string): string {
  return chain[index + 1]?.url ?? new URL(DONE_PATH, collector).href
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
 * 切换耗时的说明（enter-exit 交回的 timings，各段见 switch-timing.ts 的 switchDurations），每次切换一行：
 * 点击到可以操作、到 steady，其中页头、网络与重建各多久
 */
export function timingLines(timings: readonly SelftestTiming[]): string[] {
  return timings.map(({ id, ms }) => `${id}：点击到可以操作 ${milliseconds(ms.ready)}、到 steady ${milliseconds(ms.steady)}（页头 ${milliseconds(ms.header)}，网络 ${milliseconds(ms.network)}，重建 ${milliseconds(ms.rebuild)}）`)
}

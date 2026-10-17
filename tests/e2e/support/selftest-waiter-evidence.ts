// S3 请求方补充路径：页面、HTTP 与数据库边界分别判定，时钟校准不能记作实机时长。
import type { DocumentState, Judgement, ServerRequest } from './selftest-handover.ts'
import type { WaiterEvidence } from './selftest-request.ts'
import { EDIT_HANDOVER_RESERVE_SECONDS, EDIT_IDLE_RELEASE_SECONDS } from '@nerve-office/contracts'
import { selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { waiterJudgement } from './selftest-request.ts'

export type WaiterVariant = 'request-waiter-expired' | 'request-waiter-cancelled'
export const WAITER_CANCEL_MS = EDIT_IDLE_RELEASE_SECONDS * 1000

/** 同一条 SELECT 读到的事实；serverNow 来自数据库 clock_timestamp()，不修改 TTL 或时间。 */
export interface WaiterBoundary {
  readonly at: number
  readonly serverNow: number
  readonly epoch: number
  readonly holderId: string
  readonly endReason: string | null
  readonly endedAt: number | null
  readonly renewedAt: number
  readonly expiresAt: number
  readonly requestId: string | null
  readonly requestedBy: string | null
  readonly requestExpiresAt: number | null
  readonly reservedFor: string | null
  readonly reservedUntil: number | null
}

export interface WaiterBoundaries {
  pending?: WaiterBoundary | undefined
  reserved?: WaiterBoundary | undefined
  hiddenEnd?: WaiterBoundary | undefined
  terminal?: WaiterBoundary | undefined
}

// 可替换字段便于纯负例逐项反证，运行时的来源仍是独立只读证据。
export interface WaiterVariantEvidence {
  scenario: WaiterVariant
  mode: 'native' | 'clock-calibration'
  documentId: string
  holderId: string
  waiterId: string
  report: WaiterEvidence['report']
  marks: WaiterEvidence['marks']
  states: readonly DocumentState[]
  requests: readonly ServerRequest[]
  boundaries: WaiterBoundaries
  voided?: string | undefined
}

export const requestStartedAt = (request: ServerRequest): number => request.time - (request.durationMs ?? 0)
const isRequest = (r: ServerRequest, method: string): boolean => r.method === method && r.route?.endsWith('/edit-lease/request') === true
const live = (b: WaiterBoundary | undefined, holder: string, epoch: number | undefined): boolean => b !== undefined && b.holderId === holder && b.epoch === epoch && b.endReason === null && b.expiresAt > b.serverNow

function expiredProblems(e: WaiterVariantEvidence): string[] {
  const problems = [...waiterJudgement(e).problems]
  const { reserved, hiddenEnd, pending } = e.boundaries
  const { hiddenAt, handedOverAt, shownAt } = e.marks
  if (reserved === undefined || reserved.holderId !== e.holderId || reserved.epoch !== pending?.epoch || reserved.endReason !== 'handed_over'
    || reserved.reservedFor !== e.waiterId || reserved.endedAt === null || reserved.reservedUntil === null
    || reserved.reservedUntil - reserved.endedAt !== EDIT_HANDOVER_RESERVE_SECONDS * 1000 || reserved.serverNow >= reserved.reservedUntil
    || reserved.at < (handedOverAt ?? Number.POSITIVE_INFINITY)) {
    problems.push('没有数据库原两分钟保留期与本轮交出身份的完整证据')
  }
  if (hiddenEnd === undefined || reserved?.reservedUntil == null || hiddenEnd.serverNow < reserved.reservedUntil
    || hiddenEnd.epoch !== pending?.epoch || hiddenEnd.holderId !== e.holderId || hiddenEnd.endReason !== 'handed_over'
    || hiddenEnd.reservedUntil !== reserved.reservedUntil || hiddenEnd.reservedFor !== e.waiterId
    || hiddenEnd.at > (shownAt ?? 0) || hiddenEnd.at < (hiddenAt ?? Number.POSITIVE_INFINITY)) {
    problems.push('返回前台之前没有独立证实原保留期已到且仍未新增代次')
  }
  const renewals = e.requests.filter(r => r.userId === e.waiterId && isRequest(r, 'PUT') && requestStartedAt(r) > (handedOverAt ?? Number.POSITIVE_INFINITY) && requestStartedAt(r) < (shownAt ?? Number.POSITIVE_INFINITY))
  if (renewals.length !== 1 || renewals[0]?.statusCode !== 200 || renewals[0].aborted)
    problems.push('交出之后应只续期一次取得 granted，此后在后台停止续期')
  const granted = e.report?.timeline?.find(entry => entry.kind === 'request-granted')
  if (granted === undefined || granted.visible !== false || granted.wall < (hiddenAt ?? Number.POSITIVE_INFINITY) || granted.wall >= (shownAt ?? 0))
    problems.push('没有页面在后台得知 granted 的事实')
  if (e.requests.some(r => r.userId === e.waiterId && r.method === 'POST' && r.route?.endsWith('/edit-lease') === true && requestStartedAt(r) < (shownAt ?? Number.POSITIVE_INFINITY)))
    problems.push('请求方曾在返回前台之前发起编辑申请（按 HTTP 发起时刻）')
  return problems
}

function cancelledProblems(e: WaiterVariantEvidence): string[] {
  const problems: string[] = []
  const timeline = e.report?.timeline ?? []
  const click = timeline.find(entry => entry.kind === 'page:click')?.wall
  const hidden = timeline.find(entry => entry.kind === 'page:visibility-hidden')?.wall
  const shown = timeline.find(entry => entry.kind === 'page:visibility-visible' && entry.wall >= (hidden ?? Number.POSITIVE_INFINITY))?.wall
  const idle = timeline.find(entry => entry.kind === 'page:state' && entry.notice === 'request-idle' && entry.mode === 'reading')?.wall
  if (click === undefined || hidden === undefined || hidden < click || shown === undefined || shown - hidden < WAITER_CANCEL_MS
    || idle === undefined || idle - click < WAITER_CANCEL_MS || timeline.some(entry => ['request-granted', 'request-enter', 'acquire', 'entered'].includes(entry.kind) || (entry.kind === 'page:state' && entry.mode === 'editing'))) {
    problems.push('页面没有完整的十分钟后台、空闲取消和保持阅读的时间线')
  }
  const { pending, hiddenEnd, terminal } = e.boundaries
  const { hiddenAt, shownAt } = e.marks
  if (hiddenAt === undefined || shownAt === undefined || shownAt < hiddenAt || hiddenEnd === undefined || hiddenEnd.at > shownAt || hiddenEnd.at < hiddenAt)
    problems.push('缺少后台等待、返回与返回前数据库边界的时序')
  if (e.mode === 'native' && (shownAt === undefined || hiddenAt === undefined || shownAt - hiddenAt < WAITER_CANCEL_MS || e.marks.clockAdvancedMs !== undefined))
    problems.push('真实后台等待不足十分钟或混入了时钟校准')
  if (e.mode === 'clock-calibration' && e.marks.clockAdvancedMs !== WAITER_CANCEL_MS)
    problems.push('加速校准缺少明确的十分钟推进事实')
  if (!live(hiddenEnd, e.holderId, pending?.epoch) || !live(terminal, e.holderId, pending?.epoch)
    || e.states.some(s => s.epoch !== null && (s.epoch !== pending?.epoch || s.holderId !== e.holderId || s.endReason !== null))) {
    problems.push('等待与取消期间原持有者没有始终保持同一有效代次')
  }
  if (terminal === undefined || terminal.requestId !== null || terminal.requestedBy !== null || terminal.requestExpiresAt !== null || terminal.reservedFor !== null)
    problems.push('数据库尚未清理本轮请求或出现了编辑保留')
  const own = e.requests.filter(r => r.userId === e.waiterId)
  const sent = own.filter(r => isRequest(r, 'POST') && r.statusCode === 200 && !r.aborted)
  const cancelled = own.filter(r => isRequest(r, 'DELETE'))
  if (sent.length !== 1 || cancelled.length !== 1 || cancelled[0]?.statusCode !== 204 || cancelled[0].aborted
    || terminal === undefined || cancelled[0].time > terminal.at) {
    problems.push('没有本轮请求与成功取消的独立 HTTP 证据')
  }
  if (e.mode === 'native' && (click === undefined || cancelled[0] === undefined || requestStartedAt(cancelled[0]) - click < WAITER_CANCEL_MS))
    problems.push('HTTP 取消早于页面实际发起后的十分钟')
  if (own.some(r => r.route?.endsWith('/edit-lease') === true && ['POST', 'PUT'].includes(r.method)))
    problems.push('取消场景的请求方曾申请或续租编辑权')
  return problems
}

export function waiterVariantJudgement(e: WaiterVariantEvidence): Judgement {
  const { report, boundaries } = e
  const problems: string[] = []
  const required = ['reading', 'send', 'hidden', ...(e.scenario === 'request-waiter-cancelled' ? ['cancelled'] : ['entered', 'save'])]
  if (report === undefined || report.documentId !== e.documentId || report.scenario !== e.scenario || !selftestPassed(report)
    || report.path !== (e.scenario === 'request-waiter-cancelled' ? 'cancelled-after-idle' : 'entered-on-return')
    || !required.every(id => report.checks.some(c => c.id === `request.waiter.${id}` && c.pass))) {
    problems.push('页面报告身份、路径或必要检查不完整')
  }
  if (e.voided !== undefined)
    problems.push('本轮已经作废')
  if (!live(boundaries.pending, e.holderId, boundaries.pending?.epoch) || boundaries.pending?.requestId == null || boundaries.pending.requestedBy !== e.waiterId
    || boundaries.pending.requestExpiresAt === null || boundaries.pending.requestExpiresAt <= boundaries.pending.serverNow) {
    problems.push('缺少原持有者与请求方待回应请求的有效数据库事实')
  }
  problems.push(...(e.scenario === 'request-waiter-expired' ? expiredProblems(e) : cancelledProblems(e)))
  return { problems, evidence: `${e.scenario}；${e.mode === 'native' ? '实际时长' : '显式时钟校准，不是实机十分钟'}；后台 ${(e.marks.shownAt ?? 0) - (e.marks.hiddenAt ?? 0)} ms；数据库边界 ${Object.keys(boundaries).join('、')}；${problems.length} 项问题` }
}

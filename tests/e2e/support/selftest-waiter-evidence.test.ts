import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { DocumentState, ServerRequest } from './selftest-handover.ts'
import type { WaiterBoundary, WaiterVariantEvidence } from './selftest-waiter-evidence.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { waiterVariantJudgement } from './selftest-waiter-evidence.ts'

const BASE = 1_800_000_000_000
const at = (ms: number): number => BASE + ms
function report(cancelled: boolean): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario: cancelled ? 'request-waiter-cancelled' : 'request-waiter-expired',
    documentId: 'doc',
    userAgent: 'Safari',
    startedAt: new Date(BASE).toISOString(),
    finishedAt: new Date(at(cancelled ? 610_000 : 130_000)).toISOString(),
    page: { state: 'ready', readOnly: true },
    visibility: [],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    path: cancelled ? 'cancelled-after-idle' : 'entered-on-return',
    checks: ['reading', 'send', 'hidden', ...(cancelled ? ['cancelled'] : ['entered', 'save'])].map(id => ({ id: `request.waiter.${id}`, pass: true, detail: '', ms: 1 })),
    timeline: [
      { kind: 'page:click', wall: at(1000), at: 1000 },
      { kind: 'request-sent', wall: at(1100), at: 1100, outcome: 'pending' },
      { kind: 'page:visibility-hidden', wall: at(2000), at: 2000 },
      ...(cancelled ? [{ kind: 'page:state', wall: at(601_100), at: 601_100, mode: 'reading', notice: 'request-idle' }] : [{ kind: 'request-granted', wall: at(6000), at: 6000, visible: false }]),
      { kind: 'page:visibility-visible', wall: at(cancelled ? 605_000 : 125_000), at: cancelled ? 605_000 : 125_000 },
    ],
  }
}
function boundary(ms: number, fields: Partial<WaiterBoundary> = {}): WaiterBoundary {
  return { at: at(ms), serverNow: at(ms - 2), epoch: 1, holderId: 'peer', endReason: null, endedAt: null, renewedAt: at(1000), expiresAt: at(91_000), requestId: 'request', requestedBy: 'author', requestExpiresAt: at(601_000), reservedFor: null, reservedUntil: null, ...fields }
}
function state(ms: number, fields: Partial<DocumentState> = {}): DocumentState {
  return { at: at(ms), revision: 1, epoch: 1, holderId: 'peer', endReason: null, takeover: null, clientInstanceId: 'peer-page', ...fields }
}
function request(ms: number, method: string, suffix: string, userId = 'author', statusCode = 200): ServerRequest {
  return { time: at(ms), method, route: `/api/documents/:id/edit-lease${suffix}`, userId, statusCode, durationMs: 5, aborted: false }
}
function evidence(cancelled = false): WaiterVariantEvidence {
  const reserved = boundary(4100, { endReason: 'handed_over', endedAt: at(4000), reservedFor: 'author', reservedUntil: at(124_000) })
  return {
    scenario: cancelled ? 'request-waiter-cancelled' : 'request-waiter-expired',
    mode: 'native',
    documentId: 'doc',
    holderId: 'peer',
    waiterId: 'author',
    report: report(cancelled),
    marks: { requestSeenAt: at(1500), hiddenAt: at(2000), ...(cancelled ? {} : { handedOverAt: at(4000), renewedAt: at(6000) }), shownAt: at(cancelled ? 605_000 : 125_000) },
    boundaries: {
      pending: boundary(1600),
      ...(cancelled ? {} : { reserved }),
      hiddenEnd: cancelled ? boundary(604_999, { renewedAt: at(600_000), expiresAt: at(690_000), requestId: null, requestedBy: null, requestExpiresAt: null }) : { ...reserved, at: at(124_999), serverNow: at(124_997) },
      terminal: cancelled ? boundary(606_000, { renewedAt: at(600_000), expiresAt: at(690_000), requestId: null, requestedBy: null, requestExpiresAt: null }) : boundary(129_000, { epoch: 2, holderId: 'author', requestId: null, requestedBy: null, requestExpiresAt: null }),
    },
    states: cancelled ? [state(100), state(1500, { requestedBy: 'author' }), state(601_100)] : [state(100), state(1500, { requestedBy: 'author' }), state(4100, { endReason: 'handed_over', reservedFor: 'author' }), state(125_100, { epoch: 2, holderId: 'author' })],
    requests: [request(1100, 'POST', '/request'), request(1500, 'PUT', '', 'peer'), ...(cancelled ? [request(601_100, 'DELETE', '/request', 'author', 204)] : [request(4000, 'POST', '/handover', 'peer'), request(6000, 'PUT', '/request'), request(125_100, 'POST', '', 'author', 201)])],
  }
}

describe('请求方保留期之后返回的独立证据', () => {
  it('数据库实际跨过原两分钟保留期、期间零申请零新代次、前台普通申请', () => {
    expect(waiterVariantJudgement(evidence()).problems).toEqual([])
  })

  it.each([
    ['缺少期限', (e: WaiterVariantEvidence) => { e.boundaries.reserved = undefined }],
    ['缩短保留期', (e: WaiterVariantEvidence) => { e.boundaries.reserved = { ...e.boundaries.reserved!, reservedUntil: at(123_999) } }],
    ['服务端还没到期', (e: WaiterVariantEvidence) => { e.boundaries.hiddenEnd = { ...e.boundaries.hiddenEnd!, serverNow: at(123_999) } }],
    ['提前显示', (e: WaiterVariantEvidence) => { e.marks = { ...e.marks, shownAt: at(123_000) } }],
    ['错误保留人', (e: WaiterVariantEvidence) => { e.boundaries.reserved = { ...e.boundaries.reserved!, reservedFor: 'other' } }],
    ['后台新增代次', (e: WaiterVariantEvidence) => { e.boundaries.hiddenEnd = { ...e.boundaries.hiddenEnd!, epoch: 2 } }],
    ['获准以后继续续期', (e: WaiterVariantEvidence) => { e.requests = [...e.requests, request(11_000, 'PUT', '/request')] }],
    ['隐藏时申请且回答迟到', (e: WaiterVariantEvidence) => { e.requests = [...e.requests, { ...request(125_100, 'POST', '', 'author', 409), durationMs: 200 }] }],
    ['页面缺少保存核对', (e: WaiterVariantEvidence) => { e.report = { ...e.report!, checks: e.report!.checks.filter(c => !c.id.endsWith('.save')) } }],
    ['报告是其他文档', (e: WaiterVariantEvidence) => { e.report = { ...e.report!, documentId: 'other' } }],
  ])('%s 拒绝通过', (_name, mutate) => {
    const e = evidence()
    mutate(e)
    expect(waiterVariantJudgement(e).problems.length).toBeGreaterThan(0)
  })
})

describe('请求方十分钟空闲取消的独立证据', () => {
  it('实际隐藏十分钟、取消成功、请求清掉，原持有者继续持有且请求方从未申请', () => {
    expect(waiterVariantJudgement(evidence(true)).problems).toEqual([])
  })

  it.each([
    ['后台不足十分钟', (e: WaiterVariantEvidence) => { e.marks = { ...e.marks, shownAt: at(601_999) } }],
    ['HTTP 提前取消', (e: WaiterVariantEvidence) => { e.requests = e.requests.map(r => r.method === 'DELETE' ? { ...r, time: at(600_000) } : r) }],
    ['缺少取消 HTTP', (e: WaiterVariantEvidence) => { e.requests = e.requests.filter(r => r.method !== 'DELETE') }],
    ['取消失败', (e: WaiterVariantEvidence) => { e.requests = e.requests.map(r => r.method === 'DELETE' ? { ...r, statusCode: 500 } : r) }],
    ['请求尚未清理', (e: WaiterVariantEvidence) => { e.boundaries.terminal = boundary(606_000) }],
    ['持有者已经到期', (e: WaiterVariantEvidence) => { e.boundaries.hiddenEnd = { ...e.boundaries.hiddenEnd!, expiresAt: at(100_000) } }],
    ['曾经换代', (e: WaiterVariantEvidence) => { e.states = [...e.states, state(500_000, { epoch: 2 })] }],
    ['曾经申请', (e: WaiterVariantEvidence) => { e.requests = [...e.requests, request(500_000, 'POST', '', 'author', 409)] }],
    ['页面失败', (e: WaiterVariantEvidence) => { e.report = { ...e.report!, failure: '没有完成' } }],
    ['运行作废', (e: WaiterVariantEvidence) => { e.voided = '用户操作' }],
  ])('%s 拒绝通过', (_name, mutate) => {
    const e = evidence(true)
    mutate(e)
    expect(waiterVariantJudgement(e).problems.length).toBeGreaterThan(0)
  })

  it('时钟加速必须显式标为校准并有推进事实，不能充当真实十分钟', () => {
    const e = evidence(true)
    e.marks = { ...e.marks, shownAt: at(10_000), clockAdvancedMs: 600_000 }
    e.requests = e.requests.map(r => r.method === 'DELETE' ? { ...r, time: at(9000) } : r)
    e.boundaries.hiddenEnd = { ...e.boundaries.hiddenEnd!, at: at(9999), serverNow: at(9997) }
    e.boundaries.terminal = { ...e.boundaries.terminal!, at: at(11_000), serverNow: at(10_998) }
    expect(waiterVariantJudgement(e).problems.length).toBeGreaterThan(0)
    e.mode = 'clock-calibration'
    expect(waiterVariantJudgement(e).problems).toEqual([])
    e.marks = { ...e.marks, clockAdvancedMs: undefined }
    expect(waiterVariantJudgement(e).problems.length).toBeGreaterThan(0)
  })
})

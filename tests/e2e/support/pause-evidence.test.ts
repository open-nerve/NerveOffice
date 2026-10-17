import type { RequestRun } from './selftest-request.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { pauseRequestEvidence, pauseServerProblems } from './pause-evidence.ts'

const holderId = 'holder'
const report: NonNullable<RequestRun['report']> = { format: SELFTEST_REPORT_FORMAT, scenario: 'paused-local-holder', documentId: 'document', userAgent: 'test', startedAt: '2026-10-17T01:00:00Z', finishedAt: '2026-10-17T01:03:00Z', page: { state: 'ready' }, checks: [], visibility: [], pageErrors: [], consoleErrors: [], ignoredNotices: [], facts: { staleSaveSentAt: 100_010, staleSaveAnsweredAt: 100_025 } }
const denied = { time: 100_020, method: 'PUT', route: '/api/documents/:id/content', statusCode: 409, userId: holderId, aborted: false, durationMs: 5 }
const run: RequestRun = { judgement: { problems: [], evidence: '不可复制的原始说明' }, marks: { pausedAt: 1_000, requestedAt: 1_100, acquiredAt: 99_000 }, states: [], requests: [denied], calls: [], notes: [], report, voided: undefined }
const window = { pausedAt: 999, resumedAt: 100_000, holderId, native: true }

describe('暂停独立 HTTP 时序判定', () => {
  it('请求在已确认暂停之后，协作者在恢复前接手；恢复后的三格旧保存确实被拒', () => {
    expect(pauseServerProblems(run, window)).toEqual([])
  })

  it.each([
    { marks: { ...run.marks, requestedAt: 500 } },
    { marks: { ...run.marks, acquiredAt: 100_001 } },
    { requests: [] },
    { requests: [{ ...denied, statusCode: 200 }] },
    { requests: [{ ...denied, userId: 'peer' }] },
    { requests: [{ ...denied, aborted: true }] },
    { report: undefined },
    { voided: '用户返回' },
  ])('时序或拒绝证据缺失不能通过：%j', (change) => {
    expect(pauseServerProblems({ ...run, ...change }, window).length).toBeGreaterThan(0)
  })

  it('原生停止期间任何持有者文档请求都失败，不能只看心跳；停止之前已发出、之后结束的请求不冒称继续执行', () => {
    const during = { ...denied, time: 5_000, method: 'GET' }
    expect(pauseServerProblems({ ...run, requests: [during, denied] }, window)).toContain('原生停止期间服务端仍收到持有者的文档请求')
    expect(pauseServerProblems({ ...run, requests: [{ ...during, time: 1005, durationMs: 10 }, denied] }, window)).toEqual([])
    expect(pauseServerProblems({ ...run, requests: [during, denied] }, { ...window, native: false })).toEqual([])
  })

  it('回执跨越停止前或当前时段不能冒充恢复之后的拒绝', () => {
    const changed = { ...report, facts: { staleSaveSentAt: 90_000, staleSaveAnsweredAt: 100_025 } }
    expect(pauseServerProblems({ ...run, report: changed }, window).length).toBeGreaterThan(0)
  })

  it('存档不携带协作者令牌或任意响应正文、原始说明', () => {
    const input = { ...run, notes: ['secret-note'], calls: [{ sentAt: 1, at: 2, method: 'POST', path: '/api/documents/:id/edit-lease', status: 201, body: { kind: 'reserved', token: 'secret-token', content: 'secret-content' } }] }
    const evidence = pauseRequestEvidence(input)
    expect(JSON.stringify(evidence)).not.toMatch(/secret-|不可复制/)
    expect(evidence.calls[0]).toMatchObject({ status: 201, kind: 'reserved' })
  })
})

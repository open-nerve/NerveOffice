import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { ItemVerdict } from './probe-verdicts.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { probeCalibrationPassed, probeCalibrationSummary } from './probe-calibration.ts'
import { probeVerdicts } from './probe-verdicts.ts'

function verdict(id: string, status: ItemVerdict['status'], missing: string[] = []): ItemVerdict {
  return { id, item: Number.parseInt(id), title: `第 ${id} 项`, status, lines: ['原始判定的说明'], missing }
}

describe('CI 的探针校准', () => {
  it.each(['1', '2', '3', '9', '9-production', '10', '11', '12'])('非语义项 %s 的数据齐全时不把独立实测的失败说明作为 CI 失败', (id) => {
    const scenario = ({ '1': 'storage', '2': 'storage', '3': 'storage', '9': 'worker-stall', '9-production': 'outbox-stall', '10': 'capture-cost', '11': 'outbox-pipeline', '12': 'perf-baseline' } as Record<string, string>)[id] ?? ''
    expect(probeCalibrationSummary(scenario, [verdict(id, 'fail')])).toContainEqual({ id, status: 'complete', missing: [], lines: [] })
  })

  it.each(['5', '6', '7', '8'])('语义项 %s 的失败说明不能被当作计时数据吞掉', (id) => {
    const scenario = id === '7' ? 'key-transfer' : 'storage'
    expect(probeCalibrationSummary(scenario, [verdict(id, 'fail')])).toContainEqual({ id, status: 'fail', missing: [], lines: ['原始判定的说明'] })
  })

  it.each([['capture-cost', '10'], ['key-transfer', '7']])('%s 缺数据时保留原因，不能通过校准', (scenario, id) => {
    const summary = probeCalibrationSummary(scenario, [verdict(id, 'missing', ['缺了的计时或事实'])])
    expect(summary).toEqual([{ id, status: 'missing', missing: ['缺了的计时或事实'], lines: ['原始判定的说明'] }])
    expect(summary).not.toEqual(probeCalibrationPassed(scenario))
  })

  it('没有对应判定时明确失败；没有探针的自检步骤没有探针判定', () => {
    expect(probeCalibrationSummary('capture-cost', [])).toEqual([{ id: '10', status: '没有这一项', missing: [], lines: [] }])
    expect(probeCalibrationSummary('read-only', [])).toEqual([])
  })

  it('预期清单仍要求全部数据项，以及回滚、IndexedDB、密钥与 Web Locks 的通过', () => {
    expect(probeCalibrationPassed('storage')).toEqual([
      { id: '1', status: 'complete', missing: [], lines: [] },
      { id: '2', status: 'complete', missing: [], lines: [] },
      { id: '3', status: 'complete', missing: [], lines: [] },
      { id: '5', status: 'pass', missing: [], lines: [] },
      { id: '6', status: 'pass', missing: [], lines: [] },
      { id: '8', status: 'pass', missing: [], lines: [] },
    ])
    expect(probeCalibrationPassed('key-transfer')).toEqual([{ id: '7', status: 'pass', missing: [], lines: [] }])
  })

  it('Edge 首轮的 13.3 ms 仍让真实实测不通过，CI 校准则确认该数据确实交回', () => {
    const report: SelftestReport = {
      format: SELFTEST_REPORT_FORMAT,
      scenario: 'capture-cost',
      documentId: 'capture-document',
      userAgent: 'Edge',
      startedAt: '2026-10-10T03:40:00.000Z',
      finishedAt: '2026-10-10T03:40:01.000Z',
      page: { state: 'ready', readOnly: false },
      visibility: [],
      checks: [{ id: 'capture.cost', pass: true, detail: '测一次', ms: 1 }],
      pageErrors: [],
      consoleErrors: [],
      ignoredNotices: [],
      facts: { 'capture.raw-bytes': 1_018_521, 'capture.gzip-bytes': 206_920, 'capture.formula-mode': 'worker' },
      timings: [
        { id: 'capture.sync#1', ms: { save: 11.1, stringify: 9.3, encode: 5.3, total: 25.7 } },
        { id: 'capture.worker#1', ms: { roundTrip: 44.7, worker: 34, lagMax: 13.3, frameMax: 23.3 } },
        { id: 'capture.main-gzip#1', ms: { total: 24.2, lagMax: 24.2 } },
        { id: 'capture.main-pipeline#1', ms: { total: 31.6, put: 5.9, lagMax: 26.3 } },
      ],
    }
    const verdicts = probeVerdicts([{ stepId: 'capture-1m', report, cold: true }])
    const measured = verdicts.find(entry => entry.id === '10')
    expect(measured).toMatchObject({ status: 'fail', missing: [] })
    expect(measured?.lines.join('\n')).toContain('13.3 ms 超过 10 ms')
    expect(probeCalibrationSummary('capture-cost', verdicts)).toEqual([{ id: '10', status: 'complete', missing: [], lines: [] }])
    expect(measured?.status).toBe('fail')
  })
})

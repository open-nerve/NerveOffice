import { describe, expect, it } from 'vitest'
import { localSavePrefixProblems, localSaveProblems, localSaveSnapshotProblems, localSaveTargets, summarizeLocalSaves } from './local-save-report.ts'

const identity = { userId: 'u', documentId: 'd', writerId: 'w', writeEpoch: 1, writtenBy: 'p' }
const online = { sample: '1m', network: 'online', rounds: 2 } as const
function samples() {
  return [1, 2].map(round => ({
    ...identity,
    round,
    cold: round === 1,
    wallStartedAt: 17000 + round * 2000,
    checkedAt: 18500 + round * 2000,
    startedAt: round * 2000,
    savedAt: round * 2000 + 1000,
    localSavedMs: 1000,
    commandMs: 10,
    formulaSettledMs: 0,
    editorSeq: round,
    draftSeq: round,
    baseRevision: round,
    captureMs: 30,
    captureAt: round * 2000 + 900,
    captureSeq: round,
    workerSentAt: round * 2000 + 930,
    workerReceivedAt: round * 2000 + 990,
    workerMs: 60,
    workerConfirmed: true,
    rawBytes: 1024000,
    snapshotHash: 'a'.repeat(64),
    contentChecked: true,
    formulasPending: false,
    cloudChecked: true,
    cloudRevision: round + 1,
    visible: true,
  }))
}

describe('本机保存逐轮证据', () => {
  it('逐轮宿主只检查有效前缀，完整验收仍拒绝同一份少轮数据', () => {
    const partial = samples().slice(0, 1)
    expect(localSavePrefixProblems(partial, online, identity)).toEqual([])
    expect(localSaveProblems(partial, online, identity).length).toBeGreaterThan(0)
    expect(localSavePrefixProblems([], online, identity).length).toBeGreaterThan(0)
    expect(localSavePrefixProblems([partial[0], partial[0]], online, identity).length).toBeGreaterThan(0)
  })
  it('接受完整、身份稳定、实际 Worker 完成且在线逐轮确认的两轮校准', () => {
    expect(localSaveProblems(samples(), online, identity)).toEqual([])
  })

  it.each([
    { round: 1 },
    { cold: true },
    { draftSeq: 1 },
    { editorSeq: 1 },
    { writerId: 'other' },
    { writtenBy: 'other' },
    { userId: 'other' },
    { documentId: 'other' },
    { writeEpoch: 2 },
    { localSavedMs: Number.NaN },
    { commandMs: -1 },
    { captureMs: Number.POSITIVE_INFINITY },
    { localSavedMs: 900 },
    { captureSeq: 9 },
    { captureAt: 100 },
    { workerSentAt: 100 },
    { workerReceivedAt: 6000 },
    { workerMs: 61 },
    { workerConfirmed: false },
    { contentChecked: false },
    { formulasPending: true },
    { visible: false },
    { rawBytes: 0 },
    { snapshotHash: 'old' },
    { cloudChecked: false },
    { cloudRevision: null },
    { checkedAt: 1 },
    { unexpected: '不得保留' },
  ])('拒绝第二轮的缺证据/错身份/错时序 %j', (change) => {
    const data = samples()
    expect(localSaveProblems([data[0], { ...data[1], ...change }], online, identity).length).toBeGreaterThan(0)
  })

  it('少轮、重复轮和非数组输入不能被过滤成通过', () => {
    const data = samples()
    for (const value of [data.slice(0, 1), [...data, data[1]], null, {}, [null, data[1]]])
      expect(localSaveProblems(value, online, identity).length).toBeGreaterThan(0)
  })

  it('离线轮次必须没有云端确认和修订，不能冒用在线结果', () => {
    const config = { ...online, network: 'offline' } as const
    expect(localSaveProblems(samples(), config, identity).length).toBeGreaterThan(0)
    const data = samples().map(row => ({ ...row, baseRevision: 1, cloudChecked: false, cloudRevision: null }))
    expect(localSaveProblems(data, config, identity)).toEqual([])
  })
})

describe('完整样本统计与门槛', () => {
  it('最近秩计算，首轮与公式条件外轮次保留在全部分布里', () => {
    const data = samples().map((row, i) => ({ ...row, localSavedMs: i === 0 ? 1100 : 2400, formulaSettledMs: i === 0 ? 850 : 1100 }))
    const summary = summarizeLocalSaves(data)
    expect(summary.all).toEqual({ n: 2, min: 1100, p50: 1100, p95: 2400, max: 2400 })
    expect(summary.eligible).toEqual({ n: 1, min: 1100, p50: 1100, p95: 1100, max: 1100 })
    expect(summary.outsideFormulaCondition).toEqual([2])
    expect(localSaveTargets(data, { ...online, sample: 'perf-50k' })).toEqual([])
  })

  it('全部公式条件外时仍按全部样本检验两秒，不能得到空集通过', () => {
    const data = samples().map(row => ({ ...row, localSavedMs: 2200, formulaSettledMs: 1000 }))
    expect(localSaveTargets(data, { ...online, sample: 'perf-50k' }).length).toBeGreaterThan(0)
    expect(summarizeLocalSaves(data).outsideFormulaCondition).toEqual([1, 2])
    expect(localSaveTargets(data.map(row => ({ ...row, localSavedMs: 1800 })), { ...online, sample: 'perf-50k' })).toEqual([])
  })

  it('一 MiB 捕获门槛单独核对，空样本没有统计结论', () => {
    const data = samples().map(row => ({ ...row, captureMs: 101 }))
    expect(localSaveTargets(data, online).length).toBeGreaterThan(0)
    expect(localSaveTargets(data, { ...online, sample: '5m' })).toEqual([])
    expect(localSaveTargets([], online).length).toBeGreaterThan(0)
  })
})

describe('解密正文与公式缓存的独立核对', () => {
  const book = { sheetOrder: ['s'], sheets: { s: { name: '明细', cellData: { 1: { 3: { v: 2 }, 4: { v: 3 }, 5: { v: 4 }, 6: { v: 5 }, 7: { v: 6 }, 8: { v: 7 }, 9: { f: '=SUM(D2:I2)', v: 27 } } } } } }
  const edit = { sheet: '明细', cell: 'D2', value: 2, formula: true }
  it('原始快照与持久信封均包含本轮值及正确公式缓存', () => {
    expect(localSaveSnapshotProblems(JSON.stringify(book), edit)).toEqual([])
    expect(localSaveSnapshotProblems(JSON.stringify({ snapshot: book }), edit)).toEqual([])
  })

  it('缺工作表、错值、错缓存或错公式不通过', () => {
    expect(localSaveSnapshotProblems('{}', edit).length).toBeGreaterThan(0)
    expect(localSaveSnapshotProblems(JSON.stringify(book), { ...edit, sheet: '另一个' }).length).toBeGreaterThan(0)
    expect(localSaveSnapshotProblems(JSON.stringify(book), { ...edit, value: 8 }).length).toBeGreaterThan(0)
    const changed = structuredClone(book)
    changed.sheets.s.cellData[1][9].v = 28
    expect(localSaveSnapshotProblems(JSON.stringify(changed), edit).length).toBeGreaterThan(0)
    changed.sheets.s.cellData[1][9] = { f: '=SUM(D2:H2)', v: 27 }
    expect(localSaveSnapshotProblems(JSON.stringify(changed), edit).length).toBeGreaterThan(0)
  })
})

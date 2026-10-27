import type { EditorPageView } from './editor-page.ts'
import type { FormulaRecoveryView } from './formula-recovery.ts'
import { describe, expect, it } from 'vitest'
import { formulaRecoveryNotice } from './formula-recovery-ui.ts'

const BASE: EditorPageView = {
  load: { kind: 'ready', documentId: 'doc', title: '表格', space: { type: 'personal', id: 'space' }, accessVia: 'space', canShare: false, canViewHistory: true, userId: 'user' },
  mode: { kind: 'editing' },
  save: { status: 'dirty', formulasPending: true, problem: undefined, conflict: undefined, canSave: true, unsaved: true, unsavedEdits: false, checking: false, snapshotBytes: undefined },
  autosave: undefined,
  session: 'active',
  sessionProblem: undefined,
  confirmingSession: false,
  detailProblem: undefined,
  detailRefreshing: false,
  surface: 'loading',
}
const FAULT: FormulaRecoveryView = { failure: 'error-after-ready', phase: 'failed', problem: 'create', blocksInput: true, blocksActions: true }

describe('US-M4-13 公式恢复说明只陈述恢复事实', () => {
  it.each([
    ['waiting-input', undefined, '请先完成当前输入，页面随后恢复公式计算。'],
    ['preparing', undefined, '正在恢复公式计算，请稍候。'],
    ['rebuilding', undefined, '正在恢复公式计算，请稍候。'],
    ['paused', undefined, '公式恢复已暂停，请先处理页面中的其他提示。'],
    ['failed', 'input', '当前输入尚未完成，请完成输入后重试公式恢复。'],
    ['failed', 'capture', '暂时无法保留完整内容，页面尚未重建。请重试公式恢复。'],
    ['failed', 'create', '公式计算暂时无法恢复，重建前的内容仍保留在本页。'],
    ['failed', 'open-check', '重建后的表格未完整载入，原内容仍保留在本页。'],
    ['ready', undefined, '公式已改用当前页面计算，大表格可能暂时卡顿。'],
  ] as const)('%s/%s：说明与重试资格', (phase, problem, text) => {
    const notice = formulaRecoveryNotice({ ...BASE, formulaRecovery: { ...FAULT, phase, problem } })
    expect(notice).toEqual({ text, canRetry: phase === 'failed' })
    expect(notice?.text).not.toMatch(/已保存|已落盘|已同步/)
  })

  it('未故障/没有有效页面/失权不显示旧恢复事实', () => {
    expect(formulaRecoveryNotice(BASE)).toBeUndefined()
    expect(formulaRecoveryNotice({ ...BASE, load: { kind: 'loading' }, formulaRecovery: FAULT })).toBeUndefined()
    expect(formulaRecoveryNotice({ ...BASE, mode: { kind: 'losing', loss: { kind: 'newer' } }, formulaRecovery: FAULT })).toBeUndefined()
  })

  it('重试不依赖网络；换人、会话确认或终态不能触发', () => {
    expect(formulaRecoveryNotice({ ...BASE, formulaRecovery: FAULT, connection: { browserOnline: false, available: false, problem: 'offline', since: 1, generation: 1 } })?.canRetry).toBe(true)
    for (const overrides of [{ session: 'other-user' as const }, { session: 'signed-out' as const }, { confirmingSession: true }, { sessionProblem: new Error('断网') }, { save: { ...BASE.save!, status: 'conflict' as const } }, { save: { ...BASE.save!, status: 'outdated' as const } }, { save: { ...BASE.save!, status: 'too-new' as const } }])
      expect(formulaRecoveryNotice({ ...BASE, formulaRecovery: FAULT, ...overrides })?.canRetry).toBe(false)
    expect(formulaRecoveryNotice({ ...BASE, session: 'signed-out', formulaRecovery: { ...FAULT, phase: 'paused' } })?.text).toBe('公式恢复已暂停，请使用原账户登录后回到本页。')
  })
})

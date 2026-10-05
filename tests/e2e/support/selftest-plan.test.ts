// 页面自检怎么跑（selftest-plan.ts）：入口页的地址（账户放在 # 片段里，不发给服务器）、各场景的步骤、结果有什么问题。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from './database.ts'
import { describe, expect, it } from 'vitest'
import { CAPTURE_SCENARIOS, SELFTEST_REPORT_FORMAT, SELFTEST_SCENARIOS } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { SAMPLE_FORMULAS } from './read-only-sample.ts'
import { problemsOf, SELFTEST_PAGE, SELFTEST_STEPS, selftestPageUrl, stepsOf } from './selftest-plan.ts'

function user(username: string): TestUser {
  return { id: `${username}-id`, username, displayName: username, password: `${username} 的密码 &=#`, personalSpaceId: 'space' }
}

const PEOPLE = { author: user('author'), viewer: user('viewer') }
const STEPS = stepsOf(SELFTEST_STEPS, PEOPLE, SELFTEST_STEPS.map(definition => `${definition.id}-doc`))

function report(overrides: Partial<SelftestReport> = {}): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario: 'read-only',
    documentId: 'sample-doc',
    userAgent: 'Safari',
    startedAt: '2026-10-04T01:00:00.000Z',
    finishedAt: '2026-10-04T01:00:09.000Z',
    page: { state: 'ready', readOnly: true },
    visibility: [],
    checks: [{ id: 'facade.筛选', pass: true, detail: '取消了', ms: 3 }],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    ...overrides,
  }
}

const EXPECTED_FORMULAS = Object.fromEntries(SAMPLE_FORMULAS.map(formula => [`${formula.sheetId}!${formula.cell}`, formula.value]))

describe('页面自检的步骤', () => {
  it('M3-P2 的四步（查看者的只读入口与公式，作者的界面对照、进入与退出编辑）之后是 M3-P4 的捕获时机复核（作者、编辑时），hidden-save 在最后', () => {
    expect(STEPS.map(step => [step.id, step.scenario, step.account.username, step.formula ?? '—'])).toEqual([
      ['read-only', 'read-only', 'viewer', '—'],
      ['read-only-formulas', 'read-only-formulas', 'viewer', '—'],
      ['edit-chrome', 'edit-chrome', 'author', '—'],
      ['enter-exit', 'enter-exit', 'author', '—'],
      ['environment', 'environment', 'author', '—'],
      ['change-detection', 'change-detection', 'author', '—'],
      ['formula-timing-worker', 'formula-timing', 'author', 'worker'],
      ['formula-timing-main', 'formula-timing', 'author', 'main-thread'],
      ['auto-height', 'auto-height', 'author', '—'],
      ['large-copy', 'large-copy', 'author', '—'],
      ['composition', 'composition', 'author', '—'],
      ['hidden-save', 'hidden-save', 'author', '—'],
    ])
  })

  it('每一步自己一份文档（有的步骤会保存）；每个场景至少一步，公式时序两种模式各一步', () => {
    expect(new Set(STEPS.map(step => step.documentId)).size).toBe(STEPS.length)
    expect(new Set(STEPS.map(step => step.id)).size).toBe(STEPS.length)
    expect([...new Set(STEPS.map(step => step.scenario))].sort()).toEqual([...SELFTEST_SCENARIOS].sort())
    expect(CAPTURE_SCENARIOS.every(scenario => SELFTEST_STEPS.some(definition => definition.scenario === scenario && definition.role === 'author'))).toBe(true)
    expect(SELFTEST_STEPS.at(-1)?.scenario).toBe('hidden-save')
    expect(() => stepsOf(SELFTEST_STEPS, PEOPLE, ['one'])).toThrow('步却有 1 份文档')
  })

  it('入口页的地址：被测站点上的自检页，账户、文档、场景与结果交回的地址都在 # 片段里（查询里没有）', () => {
    const step = STEPS.find(item => item.scenario === 'read-only')
    if (step === undefined)
      throw new Error('没有 read-only 这一步')
    const url = new URL(selftestPageUrl('http://127.0.0.1:4100', step, 'http://127.0.0.1:4200/report?step=0'))
    expect(`${url.origin}${url.pathname}`).toBe(`http://127.0.0.1:4100${SELFTEST_PAGE}`)
    expect(url.search).toBe('')
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(Object.fromEntries(fragment)).toEqual({ user: 'viewer', password: 'viewer 的密码 &=#', document: 'read-only-doc', scenario: 'read-only', next: 'http://127.0.0.1:4200/report?step=0' })
  })

  it('选了公式模式的步骤：片段里带 formula（主线程是 main，Worker 是 worker）', () => {
    const formula = (id: string): string | null => {
      const step = STEPS.find(item => item.id === id)
      if (step === undefined)
        throw new Error(`没有 ${id} 这一步`)
      return new URLSearchParams(new URL(selftestPageUrl('http://127.0.0.1:4100', step, 'http://127.0.0.1:4200/report?step=0')).hash.slice(1)).get('formula')
    }
    expect([formula('formula-timing-main'), formula('formula-timing-worker'), formula('change-detection')]).toEqual(['main', 'worker', null])
  })
})

describe('页面自检的结果有什么问题', () => {
  it('全部通过：没有问题', () => {
    expect(problemsOf(report())).toEqual([])
    expect(problemsOf(report({ scenario: 'read-only-formulas', formulaValues: EXPECTED_FORMULAS }))).toEqual([])
  })

  it('没跑完、不通过的检查、页面错误、console.error 都列出来', () => {
    expect(problemsOf(report({
      failure: '编辑器页没有就绪',
      checks: [{ id: 'shortcut.undo-redo', pass: false, detail: '没有等到 univer.command.undo 被取消', ms: 10_000 }],
      pageErrors: ['TypeError: x'],
      consoleErrors: ['出错了'],
    }))).toEqual(['没能跑完：编辑器页没有就绪', 'shortcut.undo-redo：没有等到 univer.command.undo 被取消', '页面错误：TypeError: x', 'console.error：出错了'])
  })

  it('公式的场景另核对样本里几个公式算出的值（与 read-only.spec.ts 同一组）', () => {
    const wrong = { ...EXPECTED_FORMULAS, 'sheet-1!B7': 71 }
    expect(problemsOf(report({ scenario: 'read-only-formulas', formulaValues: wrong }))).toEqual(['公式 B7（=SUM(B2:B6)）算出 71，应当是 70'])
    expect(problemsOf(report({ scenario: 'read-only-formulas' }))).toHaveLength(SAMPLE_FORMULAS.length)
  })

  it('一项检查都没有：算不通过', () => {
    expect(problemsOf(report({ checks: [] }))).toEqual(['没有通过（没有检查）'])
  })

  it('进入、退出编辑的场景另核对交回了两次切换的耗时（到 ready 与 steady 都有）', () => {
    const timing = (id: string, steady: number | null) => ({ id, ms: { ready: 400, steady } })
    expect(problemsOf(report({ scenario: 'enter-exit', timings: [timing('switch.enter', 3400), timing('switch.exit', 3500)] }))).toEqual([])
    expect(problemsOf(report({ scenario: 'enter-exit', timings: [timing('switch.enter', 3400), timing('switch.exit', null)] }))).toEqual(['没有交回 switch.exit 的耗时'])
    expect(problemsOf(report({ scenario: 'enter-exit' }))).toEqual(['没有交回 switch.enter 的耗时', '没有交回 switch.exit 的耗时'])
    // 没跑完时只说没跑完的原因
    expect(problemsOf(report({ scenario: 'enter-exit', failure: '自检中途出错' }))).toEqual(['没能跑完：自检中途出错'])
  })
})

describe('主线程模式在计算中重建（M3-P4 设计 §3.14：S5 的规避落地之后不再豁免）', () => {
  it('公式时序有主线程模式的一步；它的"计算中重建之后的公式"不对时照常算问题（以前的已知问题不再单独列出）', () => {
    expect(SELFTEST_STEPS.some(step => step.id === 'formula-timing-main' && step.scenario === 'formula-timing' && step.formula === 'main-thread')).toBe(true)
    const poisoned = { id: 'formula.rebuild-during-calc', pass: false, detail: '在计算中重建之后，新的编辑器里强制重算，350/811 个与定义不同（其中 #NAME? ×350）：重!C151（{}）', ms: 9000 }
    expect(problemsOf(report({ scenario: 'formula-timing', page: { state: 'ready', readOnly: false }, checks: [poisoned] }))).toEqual([`formula.rebuild-during-calc：${poisoned.detail}`])
  })
})

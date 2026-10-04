// 页面自检怎么跑（selftest-plan.ts）：入口页的地址（账户放在 # 片段里，不发给服务器）、三个场景的步骤、结果有什么问题。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from './database.ts'
import type { SelftestScene } from './selftest-plan.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { SAMPLE_FORMULAS } from './read-only-sample.ts'
import { problemsOf, SELFTEST_PAGE, selftestPageUrl, selftestSteps } from './selftest-plan.ts'

function user(username: string): TestUser {
  return { id: `${username}-id`, username, displayName: username, password: `${username} 的密码 &=#`, personalSpaceId: 'space' }
}

const SCENE: SelftestScene = { author: user('author'), viewer: user('viewer'), sampleId: 'sample-doc', formulasId: 'formulas-doc' }

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
  it('三个场景：查看者的只读入口与公式，作者的界面对照', () => {
    expect(selftestSteps(SCENE).map(step => [step.id, step.scenario, step.account.username, step.documentId])).toEqual([
      ['read-only', 'read-only', 'viewer', 'sample-doc'],
      ['read-only-formulas', 'read-only-formulas', 'viewer', 'formulas-doc'],
      ['edit-chrome', 'edit-chrome', 'author', 'sample-doc'],
    ])
  })

  it('入口页的地址：被测站点上的自检页，账户、文档、场景与结果交回的地址都在 # 片段里（查询里没有）', () => {
    const step = selftestSteps(SCENE).find(item => item.scenario === 'read-only')
    if (step === undefined)
      throw new Error('没有 read-only 这一步')
    const url = new URL(selftestPageUrl('http://127.0.0.1:4100', step, 'http://127.0.0.1:4200/report?step=0'))
    expect(`${url.origin}${url.pathname}`).toBe(`http://127.0.0.1:4100${SELFTEST_PAGE}`)
    expect(url.search).toBe('')
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(Object.fromEntries(fragment)).toEqual({ user: 'viewer', password: 'viewer 的密码 &=#', document: 'sample-doc', scenario: 'read-only', next: 'http://127.0.0.1:4200/report?step=0' })
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
})

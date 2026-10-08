// 页面自检怎么跑（selftest-plan.ts）：入口页的地址（账户放在 # 片段里，不发给服务器）、各场景的步骤、结果有什么问题。
import type { SelftestReport, SelftestScenario } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from './database.ts'
import type { SelftestStep, StoredDocument } from './selftest-plan.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { BIG_SHEET } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { CAPTURE_SCENARIOS, COMPOSITION_NOTE, ENTER_EXIT_EDIT, HANDOVER_SCENARIOS, HIDDEN_SAVE_EDITS, PAUSED_HOLDER_EDITS, REFRESH_SAVE_EDIT, REQUEST_SCENARIOS, REQUEST_WAITER_EDIT, SELFTEST_REPORT_FORMAT, SELFTEST_SCENARIOS, TAKEOVER_EDITS } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { bigSheetFor, formulaSampleFor } from './capture-samples.ts'
import { SAMPLE_FORMULAS } from './read-only-sample.ts'
import { problemsOf, SELFTEST_PAGE, SELFTEST_STEPS, selftestPageUrl, stepsOf, storedProblems } from './selftest-plan.ts'

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
  it('M3-P2 的四步（查看者的只读入口与公式，作者的界面对照、进入与退出编辑）之后是 M3-P4 的捕获时机复核（作者、编辑时），hidden-save 之后是 M3-P5 的交接复核，最后是 M3-P6 的请求编辑两条路（作者；路 2 盖屏，放在最后）', () => {
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
      ['takeover-holder', 'takeover-holder', 'author', '—'],
      ['takeover-taker', 'takeover-taker', 'author', '—'],
      ['takeover-deaf-holder', 'takeover-holder-deaf', 'author', '—'],
      ['takeover-deaf-taker', 'takeover-taker', 'author', '—'],
      ['refresh-save', 'refresh-save', 'author', '—'],
      ['request-waiter', 'request-waiter', 'author', '—'],
      ['paused-holder', 'paused-holder', 'author', '—'],
    ])
    expect(REQUEST_SCENARIOS.every(scenario => SELFTEST_STEPS.some(definition => definition.scenario === scenario && definition.role === 'author' && definition.sharesDocumentOf === undefined))).toBe(true)
  })

  it('每一步自己一份文档（有的步骤会保存），只有另开的 B 与它的 A 共用（A 正在编辑的那一份）；每个场景至少一步，公式时序两种模式各一步', () => {
    const shared = STEPS.filter(step => step.sharesDocumentOf !== undefined)
    expect(shared.map(step => [step.id, step.sharesDocumentOf, step.opens])).toEqual([['takeover-taker', 'takeover-holder', 'editor'], ['takeover-deaf-taker', 'takeover-deaf-holder', 'editor']])
    expect(STEPS.find(step => step.id === 'takeover-taker')?.documentId).toBe('takeover-holder-doc')
    expect(STEPS.find(step => step.id === 'takeover-deaf-taker')?.documentId).toBe('takeover-deaf-holder-doc')
    expect(new Set(STEPS.map(step => step.documentId)).size).toBe(STEPS.length - 2)
    expect(STEPS.filter(step => step.sharesDocumentOf === undefined).every(step => step.opens === 'entry')).toBe(true)
    expect(new Set(STEPS.map(step => step.id)).size).toBe(STEPS.length)
    expect([...new Set(STEPS.map(step => step.scenario))].sort()).toEqual([...SELFTEST_SCENARIOS].sort())
    expect(CAPTURE_SCENARIOS.every(scenario => SELFTEST_STEPS.some(definition => definition.scenario === scenario && definition.role === 'author'))).toBe(true)
    expect(HANDOVER_SCENARIOS.every(scenario => SELFTEST_STEPS.some(definition => definition.scenario === scenario && definition.role === 'author'))).toBe(true)
    expect(() => stepsOf(SELFTEST_STEPS, PEOPLE, ['one'])).toThrow('步却有 1 份文档')
    expect(() => stepsOf([{ id: 'b', scenario: 'takeover-taker', role: 'author', sample: 'template', sharesDocumentOf: 'a' }], PEOPLE, [''])).toThrow('b 共用的 a 不在步骤里')
  })

  it('直接打开编辑器页的那一步（B）：编辑器页的地址带着场景与 next，不带账户（同一个浏览器里已经登录）', () => {
    const step = STEPS.find(item => item.id === 'takeover-taker')
    if (step === undefined)
      throw new Error('没有 takeover-taker 这一步')
    const url = new URL(selftestPageUrl('http://127.0.0.1:4100', step, 'http://127.0.0.1:4200/report?step=13'))
    expect([url.pathname, url.searchParams.get('selftest'), url.searchParams.get('next'), url.hash]).toEqual(['/documents/takeover-holder-doc', 'takeover-taker', 'http://127.0.0.1:4200/report?step=13', ''])
    expect(url.href).not.toContain('author')
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

  it('交接的场景另核对交回了认得的路（M3-P5）：A handed-over 或 lost，B answered 或 silent，refresh-save committed 或 expired', () => {
    const base = { page: { state: 'ready', readOnly: false } } as const
    expect(problemsOf(report({ ...base, scenario: 'takeover-taker', path: 'silent' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'takeover-holder', path: 'lost' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'refresh-save', path: 'committed' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'takeover-taker' }))).toEqual(['交回的路是 没有（应当是 answered、silent 之一）'])
    expect(problemsOf(report({ ...base, scenario: 'takeover-holder', path: 'silent' }))).toEqual(['交回的路是 silent（应当是 handed-over、lost 之一）'])
    // 收不到交接频道消息的 A 只会失去编辑权
    expect(problemsOf(report({ ...base, scenario: 'takeover-holder-deaf', path: 'lost' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'takeover-holder-deaf', path: 'handed-over' }))).toEqual(['交回的路是 handed-over（应当是 lost 之一）'])
    // 没跑完时只说没跑完的原因
    expect(problemsOf(report({ ...base, scenario: 'refresh-save', failure: '自检中途出错' }))).toEqual(['没能跑完：自检中途出错'])
    // 请求编辑的两条路（M3-P6）：请求方只认设计的那一条；被盖屏的持有者被暂停（lost-after-pause）、没被暂停而自动交出（handed-over）两条都认
    expect(problemsOf(report({ ...base, scenario: 'request-waiter', path: 'entered-on-return' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'request-waiter', path: 'entered-while-hidden' }))).toEqual(['交回的路是 entered-while-hidden（应当是 entered-on-return 之一）'])
    expect(problemsOf(report({ ...base, scenario: 'paused-holder', path: 'lost-after-pause' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'paused-holder', path: 'handed-over' }))).toEqual([])
    expect(problemsOf(report({ ...base, scenario: 'paused-holder', path: 'lost-while-hidden' }))).toEqual(['交回的路是 lost-while-hidden（应当是 lost-after-pause、handed-over 之一）'])
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

describe('服务器上的核对（storedProblems；M3-P4 S7 起捕获时机的几步看真实的自动保存）', () => {
  function stored(overrides: Partial<StoredDocument> = {}): StoredDocument {
    return { revision: 1, revisions: 1, formulasPending: false, snapshot: sheetSnapshotFor('unit-1'), ...overrides }
  }
  const step = (scenario: SelftestScenario): Pick<SelftestStep, 'scenario' | 'documentId'> => ({ scenario, documentId: `${scenario}-doc` })
  /** 模板的 sheet-1 里写上几格的值 */
  function templateWith(cells: readonly { readonly row: number, readonly column: number, readonly value: string }[], resources: readonly { readonly name: string, readonly data: string }[] = []): string {
    const workbook = JSON.parse(sheetSnapshotFor('unit-1')) as { sheets: Record<string, { cellData: Record<number, Record<number, { v: string }>> }>, resources: { name: string, data: string }[] }
    const sheet = workbook.sheets['sheet-1']
    if (sheet === undefined)
      throw new Error('模板里没有 sheet-1')
    for (const cell of cells)
      sheet.cellData = { ...sheet.cellData, [cell.row]: { ...sheet.cellData[cell.row], [cell.column]: { v: cell.value } } }
    workbook.resources = [...workbook.resources.filter(resource => !resources.some(item => item.name === resource.name)), ...resources]
    return JSON.stringify(workbook)
  }

  it('没有这份文档：一条问题', () => {
    expect(storedProblems(step('read-only'), undefined)).toEqual(['服务器上没有文档 read-only-doc'])
  })

  it('只看不改的几步与 change-detection（暂停了定时的上传，内容带着样本的 data: 图片、服务端拒收）：修订号恰好 1', () => {
    for (const scenario of ['read-only', 'read-only-formulas', 'edit-chrome', 'environment', 'change-detection'] as const) {
      expect(storedProblems(step(scenario), stored())).toEqual([])
      expect(storedProblems(step(scenario), stored({ revision: 2, revisions: 2 }))).toEqual([`文档 ${scenario}-doc 的修订号是 2、修订记录 2 条（应当都是 1：没有保存过）`])
    }
  })

  it('enter-exit：恰好 2，内容里有改的那一格；hidden-save：恰好 3，内容里有两格', () => {
    const edited = templateWith([ENTER_EXIT_EDIT])
    expect(storedProblems(step('enter-exit'), stored({ revision: 2, revisions: 2, snapshot: edited }))).toEqual([])
    expect(storedProblems(step('enter-exit'), stored({ revision: 3, revisions: 3, snapshot: edited }))).toEqual(['文档 enter-exit-doc 的修订号是 3、修订记录 3 条（应当都是 2：退出编辑时保存了一次）'])
    const hidden = templateWith(HIDDEN_SAVE_EDITS)
    expect(storedProblems(step('hidden-save'), stored({ revision: 3, revisions: 3, snapshot: hidden }))).toEqual([])
    expect(storedProblems(step('hidden-save'), stored({ revision: 3, revisions: 3, snapshot: templateWith([HIDDEN_SAVE_EDITS[0]]) }))).toEqual([`服务器上 A2 是 空（应当是 "${HIDDEN_SAVE_EDITS[1].value}"）`])
    expect(storedProblems(step('hidden-save'), stored({ revision: 2, revisions: 2, snapshot: hidden }))[0]).toMatch(/修订号是 2.*应当都是 3/)
  })

  it('自动保存照常的几步：至少 2、修订记录条数与修订号相同，存下的内容另核对（这里是组合输入的批注）', () => {
    const note = { name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ [COMPOSITION_NOTE.sheetId]: { [COMPOSITION_NOTE.row]: { [COMPOSITION_NOTE.column]: { note: COMPOSITION_NOTE.text } } } }) }
    const composed = templateWith([], [note])
    expect(storedProblems(step('composition'), stored({ revision: 2, revisions: 2, snapshot: composed }))).toEqual([])
    expect(storedProblems(step('composition'), stored({ revision: 5, revisions: 5, snapshot: composed }))).toEqual([])
    expect(storedProblems(step('composition'), stored({ snapshot: composed }))).toEqual(['文档 composition-doc 的修订号是 1、修订记录 1 条（应当至少 2、两者相同：自动保存在组合结束之后上传）'])
    expect(storedProblems(step('composition'), stored({ revision: 3, revisions: 2, snapshot: composed }))).toHaveLength(1)
    expect(storedProblems(step('composition'), stored({ revision: 2, revisions: 2 }))).toEqual([`服务器上存下的内容：${COMPOSITION_NOTE.cell} 的批注是 空（应当是选定的"${COMPOSITION_NOTE.text}"）`])
  })

  it('公式时序：存下的公式按定义核对（没有结果的样本一律不对）；大表的两步按格数、字号与自动行高核对', () => {
    const [formulaProblem] = storedProblems(step('formula-timing'), stored({ revision: 4, revisions: 4, snapshot: formulaSampleFor('unit-1') }))
    expect(formulaProblem).toMatch(/^服务器上存下的内容：\d+\/\d+ 个公式与按定义算出的不同/)
    const big = bigSheetFor('unit-1')
    expect(storedProblems(step('large-copy'), stored({ revision: 2, revisions: 2, snapshot: big }))).toEqual([`服务器上存下的内容：工作表 ${BIG_SHEET.id} 各有 ${BIG_SHEET.rows} 格（应当是原表与复制品两张、各 ${BIG_SHEET.rows} 格）`])
    expect(storedProblems(step('auto-height'), stored({ revision: 2, revisions: 2, snapshot: big }))).toEqual([
      `服务器上存下的内容：大表 ${BIG_SHEET.rows} 行里字号是 28 的 0 行`,
      `服务器上存下的内容：大表 ${BIG_SHEET.rows} 行里有自动行高（ah）的 0 行（迟到的行高没有存上？）`,
    ])
  })

  it('"公式待更新"还在：算问题', () => {
    expect(storedProblems(step('read-only'), stored({ formulasPending: true }))).toEqual(['服务器上的文档是"公式待更新"'])
  })

  it('交接（M3-P5）随走的路：A 回应了（answered）三格、修订号 4；没有回应（silent）前两格、修订号 3、第三格不在；B 随 A 那一步核对；refresh-save 提交了（committed）修订号 2、有那一格；认不出路算问题', () => {
    const [first, second, third] = TAKEOVER_EDITS
    const all = templateWith(TAKEOVER_EDITS)
    const two = templateWith([first, second])
    expect(storedProblems(step('takeover-holder'), stored({ revision: 4, revisions: 4, snapshot: all }), 'answered')).toEqual([])
    expect(storedProblems(step('takeover-holder'), stored({ revision: 3, revisions: 3, snapshot: two }), 'silent')).toEqual([])
    expect(storedProblems(step('takeover-holder'), stored({ revision: 3, revisions: 3, snapshot: all }), 'silent')).toEqual([`服务器上 ${third.cell} 是 ${JSON.stringify(third.value)}（应当是空的）`])
    expect(storedProblems(step('takeover-holder'), stored({ revision: 3, revisions: 3, snapshot: two }), 'answered')[0]).toMatch(/修订号是 3.*应当都是 4/)
    expect(storedProblems(step('takeover-holder'), stored({ revision: 3, revisions: 3, snapshot: two }))).toEqual(['文档 takeover-holder-doc：不知道走了哪条路（没有交回），说不出服务器上该是什么样子（修订号 3）'])
    expect(storedProblems(step('takeover-taker'), undefined, 'silent')).toEqual([])
    expect(storedProblems(step('takeover-holder-deaf'), stored({ revision: 3, revisions: 3, snapshot: two }), 'silent')).toEqual([])
    expect(storedProblems(step('refresh-save'), stored({ revision: 2, revisions: 2, snapshot: templateWith([REFRESH_SAVE_EDIT]) }), 'committed')).toEqual([])
    expect(storedProblems(step('refresh-save'), stored(), 'committed')).toHaveLength(2)
    expect(storedProblems(step('refresh-save'), stored(), 'expired')).toHaveLength(1)
  })

  it('请求编辑的两条路（M3-P6）随走的路：请求方回到前台才进入（entered-on-return）修订号 2、有它写的那一格；被暂停的持有者（lost-after-pause）前两格、修订号 3、第三格不在，没被暂停而自动交出（handed-over）三格、修订号 4；别的路算问题', () => {
    expect(storedProblems(step('request-waiter'), stored({ revision: 2, revisions: 2, snapshot: templateWith([REQUEST_WAITER_EDIT]) }), 'entered-on-return')).toEqual([])
    expect(storedProblems(step('request-waiter'), stored(), 'entered-on-return')).toEqual([
      '文档 request-waiter-doc 的修订号是 1、修订记录 1 条（应当都是 2：回到前台、进入编辑之后存上一格（另一方没有保存过））',
      `服务器上 ${REQUEST_WAITER_EDIT.cell} 是 空（应当是 ${JSON.stringify(REQUEST_WAITER_EDIT.value)}）`,
    ])
    expect(storedProblems(step('request-waiter'), stored(), 'entered-while-hidden')).toEqual(['文档 request-waiter-doc：不知道走了哪条路（entered-while-hidden），说不出服务器上该是什么样子（修订号 1）'])
    const [first, second, third] = PAUSED_HOLDER_EDITS
    expect(storedProblems(step('paused-holder'), stored({ revision: 3, revisions: 3, snapshot: templateWith([first, second]) }), 'lost-after-pause')).toEqual([])
    expect(storedProblems(step('paused-holder'), stored({ revision: 4, revisions: 4, snapshot: templateWith(PAUSED_HOLDER_EDITS) }), 'lost-after-pause')).toEqual([
      '文档 paused-holder-doc 的修订号是 4、修订记录 4 条（应当都是 3：控制的 flush、盖屏（隐藏）的那一刻各上传一次，第三格没有存上）',
      `服务器上 ${third.cell} 是 ${JSON.stringify(third.value)}（应当是空的）`,
    ])
    expect(storedProblems(step('paused-holder'), stored({ revision: 4, revisions: 4, snapshot: templateWith(PAUSED_HOLDER_EDITS) }), 'handed-over')).toEqual([])
    expect(storedProblems(step('paused-holder'), stored({ revision: 3, revisions: 3, snapshot: templateWith([first, second]) }), 'handed-over')).toEqual([
      '文档 paused-holder-doc 的修订号是 3、修订记录 3 条（应当都是 4：控制的 flush、盖屏（隐藏）的那一刻、自动交出之前各上传一次）',
      `服务器上 ${third.cell} 是 空（应当是 ${JSON.stringify(third.value)}）`,
    ])
    expect(storedProblems(step('paused-holder'), stored({ revision: 4, revisions: 4 }), 'not-lost')).toHaveLength(1)
  })
})

describe('主线程模式在计算中重建（M3-P4 设计 §3.14：S5 的规避落地之后不再豁免）', () => {
  it('公式时序有主线程模式的一步；它的"计算中重建之后的公式"不对时照常算问题（以前的已知问题不再单独列出）', () => {
    expect(SELFTEST_STEPS.some(step => step.id === 'formula-timing-main' && step.scenario === 'formula-timing' && step.formula === 'main-thread')).toBe(true)
    const poisoned = { id: 'formula.rebuild-during-calc', pass: false, detail: '在计算中重建之后，新的编辑器里强制重算，350/811 个与定义不同（其中 #NAME? ×350）：重!C151（{}）', ms: 9000 }
    expect(problemsOf(report({ scenario: 'formula-timing', page: { state: 'ready', readOnly: false }, checks: [poisoned] }))).toEqual([`formula.rebuild-during-calc：${poisoned.detail}`])
  })
})

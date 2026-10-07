// 真实 Safari 的自检的驱动脚本里不碰进程与网络的部分（run-plan.ts）：一串步骤怎么接起来、收集端认哪些请求、每步的结论与退出码、
// 切换耗时的说明。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from '../support/database.ts'
import type { SelftestStep } from '../support/selftest-plan.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { SELFTEST_STEPS, stepsOf } from '../support/selftest-plan.ts'
import { chainOf, CLOSE_PATH, DONE_PATH, exitCodeOf, nextAfter, outcomeOf, parseReportRequest, REPORT_PATH, reportUrlOf, resultFileName, selectSteps, serverJudgedOutcome, timingLines } from './run-plan.ts'

const ORIGIN = 'http://127.0.0.1:4100'
const COLLECTOR = 'http://127.0.0.1:4200'

function user(username: string): TestUser {
  return { id: `${username}-id`, username, displayName: username, password: 'password', personalSpaceId: 'space' }
}

/** 全部步骤（共用文档的那一步取它共用的那一步的文档）；前四步是 M3-P2 的场景 */
const ALL_STEPS = stepsOf(SELFTEST_STEPS, { author: user('author'), viewer: user('viewer') }, SELFTEST_STEPS.map(definition => definition.id === 'read-only' ? 'sample-doc' : `${definition.id}-doc`))
const STEPS = ALL_STEPS.slice(0, 4)

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

describe('一串步骤怎么接起来', () => {
  it('每一步的结果交回收集端的 /report?step=<序号>，收下之后去下一步的入口页，最后一步之后去结束页', () => {
    const chain = chainOf(STEPS, ORIGIN, COLLECTOR)
    expect(chain.map(link => new URLSearchParams(new URL(link.url).hash.slice(1)).get('next'))).toEqual([0, 1, 2, 3].map(index => reportUrlOf(COLLECTOR, index)))
    expect(chain.every(link => link.url.startsWith(`${ORIGIN}/selftest.html#`))).toBe(true)
    expect(nextAfter(chain, 0, COLLECTOR)).toBe(chain[1]?.url)
    expect(nextAfter(chain, 2, COLLECTOR)).toBe(chain[3]?.url)
    expect(nextAfter(chain, 3, COLLECTOR)).toBe(`${COLLECTOR}${DONE_PATH}`)
  })

  it('全部步骤：上一步带过去的到 hidden-save 为止（它之后去结束页）；交接的几步由驱动脚本另开（A 与 refresh-save 交回之后去结束页，B 去关掉自己的页）', () => {
    const chain = chainOf(ALL_STEPS, ORIGIN, COLLECTOR)
    const hidden = ALL_STEPS.findIndex(step => step.scenario === 'hidden-save')
    expect(chain.map(link => [link.step.id, link.opened, link.after]).slice(hidden)).toEqual([
      ['hidden-save', false, 'done'],
      ['takeover-holder', true, 'done'],
      ['takeover-taker', true, 'close'],
      ['takeover-deaf-holder', true, 'done'],
      ['takeover-deaf-taker', true, 'close'],
      ['refresh-save', true, 'done'],
    ])
    expect(chain.slice(0, hidden).every(link => !link.opened && link.after === 'next')).toBe(true)
    expect(nextAfter(chain, hidden - 1, COLLECTOR)).toBe(chain[hidden]?.url)
    expect(nextAfter(chain, hidden, COLLECTOR)).toBe(`${COLLECTOR}${DONE_PATH}`)
    expect([1, 2, 3, 4, 5].map(offset => nextAfter(chain, hidden + offset, COLLECTOR))).toEqual([DONE_PATH, CLOSE_PATH, DONE_PATH, CLOSE_PATH, DONE_PATH].map(path => `${COLLECTOR}${path}`))
  })

  it('B（takeover-taker）直接打开编辑器页（同一个会话，不带账户），A 正在编辑的那一份文档；别的步骤经入口页', () => {
    const chain = chainOf(ALL_STEPS, ORIGIN, COLLECTOR)
    const holder = chain.find(link => link.step.scenario === 'takeover-holder')
    const takerIndex = chain.findIndex(link => link.step.scenario === 'takeover-taker')
    const url = new URL(chain[takerIndex]?.url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/documents/${holder?.step.documentId ?? '?'}`)
    expect([url.searchParams.get('selftest'), url.searchParams.get('next'), url.hash]).toEqual(['takeover-taker', reportUrlOf(COLLECTOR, takerIndex), ''])
    expect(holder?.url.startsWith(`${ORIGIN}/selftest.html#`)).toBe(true)
  })
})

describe('只跑其中几步（--steps）', () => {
  it('没有给时是全部；给了按全部步骤里的先后选出来；不认识的、只选了 B 没选 A 的交回原因', () => {
    expect(selectSteps(SELFTEST_STEPS, undefined)).toEqual({ definitions: SELFTEST_STEPS })
    const picked = selectSteps(SELFTEST_STEPS, 'refresh-save, takeover-taker,takeover-holder')
    expect('definitions' in picked ? picked.definitions.map(definition => definition.id) : picked).toEqual(['takeover-holder', 'takeover-taker', 'refresh-save'])
    expect(selectSteps(SELFTEST_STEPS, 'takeover-taker')).toEqual({ error: '--steps 选了 takeover-taker，它与 takeover-holder 共用文档，要一起选' })
    expect(selectSteps(SELFTEST_STEPS, 'read-only,nope')).toHaveProperty('error', expect.stringContaining('不认识的步骤：nope'))
    expect(selectSteps(SELFTEST_STEPS, ' , ')).toHaveProperty('error', expect.stringContaining('（空的）'))
  })

  it('只选了交接的几步：都由驱动脚本另开，没有由上一步带过去的', () => {
    const picked = selectSteps(SELFTEST_STEPS, 'takeover-holder,takeover-taker,takeover-deaf-holder,takeover-deaf-taker,refresh-save')
    const definitions = 'definitions' in picked ? picked.definitions : []
    const chain = chainOf(stepsOf(definitions, { author: user('author'), viewer: user('viewer') }, definitions.map(definition => `${definition.id}-doc`)), ORIGIN, COLLECTOR)
    expect(chain.map(link => [link.opened, link.after])).toEqual([[true, 'done'], [true, 'close'], [true, 'done'], [true, 'close'], [true, 'done']])
  })
})

describe('收集端认哪些请求', () => {
  it('/report?step=<序号>&result=<结果>：序号在步骤的范围里', () => {
    expect(parseReportRequest(new URL(`${COLLECTOR}${REPORT_PATH}?step=2&result=abc`), 3)).toEqual({ step: 2, encoded: 'abc' })
  })

  it.each([
    ['别的路径', `${COLLECTOR}/favicon.ico`],
    ['序号超出', `${COLLECTOR}${REPORT_PATH}?step=3&result=abc`],
    ['序号不是数字', `${COLLECTOR}${REPORT_PATH}?step=1e0&result=abc`],
    ['没有序号', `${COLLECTOR}${REPORT_PATH}?result=abc`],
    ['没有结果', `${COLLECTOR}${REPORT_PATH}?step=0`],
    ['结果是空的', `${COLLECTOR}${REPORT_PATH}?step=0&result=`],
  ])('不认：%s', (_case, url) => {
    expect(parseReportRequest(new URL(url), 3)).toHaveProperty('error')
  })
})

/** 第一步（查看者的只读入口） */
function firstStep(): SelftestStep {
  const [step] = STEPS
  if (step === undefined)
    throw new Error('没有步骤')
  return step
}

describe('每步的结论与退出码', () => {
  const step = firstStep()

  it('没有交回是 missing；解不开、交回的是别的一步、有问题是 failed；全部通过是 passed', () => {
    expect(outcomeOf(step, undefined)).toMatchObject({ status: 'missing' })
    expect(outcomeOf(step, { undecodable: '结果不是 JSON' })).toMatchObject({ status: 'failed', problems: ['交回的结果解不开：结果不是 JSON'] })
    expect(outcomeOf(step, report({ scenario: 'edit-chrome' }))).toMatchObject({ status: 'failed' })
    expect(outcomeOf(step, report({ documentId: 'other' }))).toMatchObject({ status: 'failed' })
    expect(outcomeOf(step, report({ pageErrors: ['TypeError: x'] }))).toMatchObject({ status: 'failed', problems: ['页面错误：TypeError: x'] })
    expect(outcomeOf(step, report())).toMatchObject({ id: 'read-only', status: 'passed', problems: [] })
  })

  it('退出码：有没有交回的是 2（超时），有不通过或服务器上的问题是 1，全部通过是 0', () => {
    const passed = outcomeOf(step, report())
    const failed = outcomeOf(step, report({ consoleErrors: ['x'] }))
    const missing = outcomeOf(step, undefined)
    expect(exitCodeOf([passed, passed], [])).toBe(0)
    expect(exitCodeOf([passed], ['修订号变了'])).toBe(1)
    expect(exitCodeOf([passed, failed], [])).toBe(1)
    expect(exitCodeOf([failed, missing], [])).toBe(2)
  })

  it('hidden-save 按库里的证据判定：库里对、没交回结果也算通过（说明写着证据）；库里不对或交回的结果有问题都算不通过', () => {
    const hidden = ALL_STEPS.find(step => step.scenario === 'hidden-save')
    if (hidden === undefined)
      throw new Error('没有 hidden-save 这一步')
    const hiddenReport = report({ scenario: 'hidden-save', documentId: hidden.documentId, page: { state: 'ready', readOnly: false } })
    expect(serverJudgedOutcome(hidden, undefined, [], '隐藏之后 0.8 秒存下')).toMatchObject({ status: 'passed', problems: [], evidence: '隐藏之后 0.8 秒存下' })
    expect(serverJudgedOutcome(hidden, hiddenReport, [], '证据')).toMatchObject({ status: 'passed', report: hiddenReport })
    expect(serverJudgedOutcome(hidden, undefined, ['修订号是 2'], '证据')).toMatchObject({ status: 'failed', problems: ['修订号是 2'] })
    expect(serverJudgedOutcome(hidden, report({ ...hiddenReport, consoleErrors: ['x'] }), [], '证据')).toMatchObject({ status: 'failed', problems: ['console.error：x'] })
    expect(exitCodeOf([serverJudgedOutcome(hidden, undefined, [], '证据')], [])).toBe(0)
  })

  it('主线程模式在计算中重建之后公式不对（M3-P4 S5 规避之前的已知问题）：不再豁免，算不通过', () => {
    const main = ALL_STEPS.find(item => item.id === 'formula-timing-main')
    if (main === undefined)
      throw new Error('没有 formula-timing-main 这一步')
    const poisoned = { id: 'formula.rebuild-during-calc', pass: false, detail: '在计算中重建之后，新的编辑器里强制重算，170/811 个与定义不同（其中 #NAME? ×170）：重!C331', ms: 9000 }
    const base = { scenario: 'formula-timing', documentId: main.documentId, page: { state: 'ready', readOnly: false } } as const
    expect(outcomeOf(main, report({ ...base, checks: [poisoned] }))).toEqual(expect.objectContaining({ status: 'failed', problems: [`formula.rebuild-during-calc：${poisoned.detail}`] }))
    expect(outcomeOf(main, report({ ...base, checks: [poisoned] }))).not.toHaveProperty('known')
  })

  it('结果文件按开始的时刻命名（UTC，没有冒号与毫秒）', () => {
    expect(resultFileName(new Date('2026-10-04T02:31:05.123Z'))).toBe('2026-10-04T02-31-05Z.json')
  })
})

describe('切换耗时的说明', () => {
  it('每次切换一行：点击到可以操作、到 steady，其中页头、网络与重建（毫秒取整，缺的写成"—"）', () => {
    expect(timingLines([
      { id: 'switch.enter', ms: { ready: 431.4, steady: 3390.6, header: 431.6, network: 21.2, rebuild: 397 } },
      { id: 'switch.exit', ms: { ready: 512, steady: null, header: 512, network: null } },
    ])).toEqual([
      'switch.enter：点击到可以操作 431 ms、到 steady 3391 ms（页头 432 ms，网络 21 ms，重建 397 ms）',
      'switch.exit：点击到可以操作 512 ms、到 steady —（页头 512 ms，网络 —，重建 —）',
    ])
    expect(timingLines([])).toEqual([])
  })

  it('捕获时机的时间线：逐段列出（毫秒取整，缺的写成"—"）', () => {
    expect(timingLines([{ id: 'formula.chain', ms: { firstStart: 11.6, lastResult: null, capture: 1013.2 } }])).toEqual(['formula.chain：firstStart 12 ms、lastResult —、capture 1013 ms'])
  })
})

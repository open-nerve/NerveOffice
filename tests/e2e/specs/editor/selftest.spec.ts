// 页面自检在 Playwright 的浏览器里（M3-P2 设计 §3.5，US-M2-11；M3-P4 设计 §3.15 的捕获时机复核）：真实 Safari 的复核用的是编辑器页里
// 编译进测试构建的自检（apps/web/src/editor/testing/selftest.ts 与 selftest-capture.ts，驱动脚本 tests/e2e/safari/selftest.ts 在本机按需运行，
// 不进 CI）。这里在三个浏览器里跑同样的自检、同样的入口页与结果的交回，核对每项检查都通过：
// - 自检本身是对的——它与 read-only.spec.ts 共用入口清单与预期，合成的事件与按角色找元素的办法、捕获规则的参考实现与按定义的公式核对
//   在这里校准过，真实 Safari 上的不通过才说明 Safari 不同，而不是自检写错了；
// - 自检不会悄悄地坏掉：CI 每次都跑（驱动脚本只在本机按需运行）；
// - 真实 Safari 的复核报告与 Playwright 的 WebKit 对照时，用的就是这里的结果（附件 selftest-report）。
// 每一步一份文档；服务器上另核对：只看不改与捕获时机的几步没有保存过，enter-exit 恰好保存了一次、内容里有自检改的那一格；
// hidden-save 保存了两次（Playwright 的页面不会真的隐藏：这里在第一次保存之后模拟可见性变成 hidden，与 reading-updates.spec.ts 同一个办法；
// 真的隐藏由驱动脚本在真实 Safari 上另开标签页做到）。
// 结果的交回与驱动脚本相同（整页跳到 next，结果在查询参数里）：next 是本机的地址（自检只把结果交给本机，M3-P2 复核 B7），
// 用被测站点自己的源加一个没有的路径，这里拦下那次导航、读出结果。
// 用到测试构建（自检的入口页与编辑器页里的自检）：标签 @test-build，外部模式测生产镜像时排除
import type { Page } from '@playwright/test'
import type { SelftestReport } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SelftestStep, SelftestStepDefinition } from '../../support/selftest-plan.ts'
import { decodeSelftestReport, RESULT_PARAM } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { revisionOf } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { KNOWN_PROBLEMS, problemsOf, SELFTEST_STEPS, selftestPageUrl, selftestScene, serverProblemsOf, splitKnown } from '../../support/selftest-plan.ts'
import { EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 结果交回的地址：本机的源（被测站点自己的源）加一个没有的路径，导航由这里拦下、不会发到后端 */
function collector(): string {
  return `${e2eOrigin()}/selftest-collector`
}

/** 自检要等编辑器到 steady（渲染完成后 3 秒）再逐项检查，场景的总时限 180 秒：给足时限，失败时看附件里的页面 */
const REPORT_TIMEOUT_MS = 200_000

/** 打开入口页，交回的结果由这里拦下：返回已经交回的地址（解开用 reportOf） */
async function startSelftest(page: Page, step: SelftestStep): Promise<string[]> {
  const delivered: string[] = []
  await page.route(`${collector()}/**`, async (route) => {
    delivered.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '自检的结果已收到' })
  })
  await page.goto(selftestPageUrl(e2eOrigin(), step, `${collector()}/report?step=${step.id}`))
  return delivered
}

/** 等结果交回，解开 */
async function reportOf(delivered: readonly string[]): Promise<SelftestReport> {
  await expect.poll(() => delivered.length, { message: '等自检把结果交回', timeout: REPORT_TIMEOUT_MS }).toBe(1)
  const encoded = new URL(delivered[0] ?? '').searchParams.get(RESULT_PARAM)
  expect(encoded, '交回的地址里有结果').not.toBeNull()
  return decodeSelftestReport(encoded ?? '')
}

/** 造这一步的样本与账户（账户名前缀：用户名最长 32 个字符，后面还要加角色与随机后缀） */
async function stepOf(definition: SelftestStepDefinition): Promise<SelftestStep> {
  const [step] = (await selftestScene(`st${SELFTEST_STEPS.indexOf(definition)}`, [definition])).steps
  if (step === undefined)
    throw new Error(`没有 ${definition.id} 这一步`)
  return step
}

/**
 * 结果的要点：场景、页面怎么打开的、有没有检查、问题（页面上的检查之外，驱动脚本另外核对的）、已知的问题（KNOWN_PROBLEMS，
 * 恰好那几条：规避落地、它不再出现时这里跟着要求通过）与服务器上的文档
 */
async function summaryOf(report: SelftestReport, step: SelftestStep): Promise<unknown> {
  const { problems, known } = splitKnown(step.id, problemsOf(report))
  return {
    scenario: report.scenario,
    page: report.page,
    hasChecks: report.checks.length > 0,
    problems,
    known: known.length,
    server: (await serverProblemsOf(step)).problems,
  }
}

/** 只读打开的场景（查看者，与作者的 enter-exit：它从阅读开始，自己点"编辑""退出编辑"） */
const READ_ONLY_SCENARIOS: ReadonlySet<string> = new Set(['read-only', 'read-only-formulas', 'enter-exit'])

function passed(step: SelftestStep): unknown {
  return { scenario: step.scenario, page: { state: 'ready', readOnly: READ_ONLY_SCENARIOS.has(step.scenario) }, hasChecks: true, problems: [], known: KNOWN_PROBLEMS[step.id]?.length ?? 0, server: [] }
}

/** hidden-save（Playwright 里模拟隐藏，单独一条用例） */
const HIDDEN_SAVE = SELFTEST_STEPS.filter(item => item.scenario === 'hidden-save')

test.describe('US-M2-11 页面自检（真实 Safari 复核用）在 Playwright 的浏览器里每项都通过', { tag: '@test-build' }, () => {
  for (const definition of SELFTEST_STEPS.filter(item => item.scenario !== 'hidden-save')) {
    test(`步骤 ${definition.id}`, async ({ page }, testInfo) => {
      const step = await stepOf(definition)
      const report = await reportOf(await startSelftest(page, step))
      await testInfo.attach('selftest-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
      expect(await summaryOf(report, step)).toEqual(passed(step))
    })
  }

  for (const definition of HIDDEN_SAVE) {
    test(`步骤 ${definition.id}：第一次保存之后页面变成隐藏（这里模拟），隐藏的那一刻改一格并保存，服务器上有两次保存`, async ({ page }, testInfo) => {
      const step = await stepOf(definition)
      const delivered = await startSelftest(page, step)
      await expect.poll(async () => revisionOf(step.documentId), { message: '等第一次保存', timeout: REPORT_TIMEOUT_MS }).toBe(2)
      // Playwright 的页面一直可见（无头浏览器另开标签页也不变）：与 reading-updates.spec.ts 同一个办法模拟可见性变成 hidden
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const report = await reportOf(delivered)
      await testInfo.attach('selftest-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
      expect(await summaryOf(report, step)).toEqual(passed(step))
    })
  }
})

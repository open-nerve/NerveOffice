// 页面自检在 Playwright 的浏览器里（M3-P2 设计 §3.5，US-M2-11）：真实 Safari 的复核用的是编辑器页里编译进测试构建的自检
// （apps/web/src/editor/testing/selftest.ts，驱动脚本 tests/e2e/safari/selftest.ts 在本机按需运行，不进 CI）。
// 这里在三个浏览器里跑同样的自检、同样的入口页与结果的交回，核对每项检查都通过：
// - 自检本身是对的——它与 read-only.spec.ts 共用入口清单与预期，合成的事件与按角色找元素的办法在这里校准过，
//   真实 Safari 上的不通过才说明 Safari 不同，而不是自检写错了；
// - 自检不会悄悄地坏掉：CI 每次都跑（驱动脚本只在本机按需运行）；
// - 真实 Safari 的复核报告与 Playwright 的 WebKit 对照时，用的就是这里的结果（附件 selftest-report）。
// enter-exit（M3-P2 S5）另核对服务器上：那份文档恰好保存了一次（修订号 2），内容里有自检在编辑时改的那一格；别的场景没有保存过。
// 结果的交回与驱动脚本相同（整页跳到 next，结果在查询参数里）：next 是本机的地址（自检只把结果交给本机，M3-P2 复核 B7），
// 用被测站点自己的源加一个没有的路径，这里拦下那次导航、读出结果。
// 用到测试构建（自检的入口页与编辑器页里的自检）：标签 @test-build，外部模式测生产镜像时排除
import type { Page } from '@playwright/test'
import type { SelftestReport, SelftestScenario } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SelftestStep } from '../../support/selftest-plan.ts'
import { decodeSelftestReport, RESULT_PARAM, SELFTEST_SCENARIOS } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { problemsOf, selftestPageUrl, selftestScene, selftestSteps, serverProblemsOf } from '../../support/selftest-plan.ts'
import { EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 结果交回的地址：本机的源（被测站点自己的源）加一个没有的路径，导航由这里拦下、不会发到后端 */
function collector(): string {
  return `${e2eOrigin()}/selftest-collector`
}

/** 跑一步自检：打开入口页，等结果交回，解开 */
async function runSelftest(page: Page, step: SelftestStep): Promise<SelftestReport> {
  const delivered: string[] = []
  await page.route(`${collector()}/**`, async (route) => {
    delivered.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '自检的结果已收到' })
  })
  await page.goto(selftestPageUrl(e2eOrigin(), step, `${collector()}/report?step=${step.id}`))
  // 自检要等编辑器到 steady（渲染完成后 3 秒）再逐项检查：给足时限，失败时看附件里的页面
  await expect.poll(() => delivered.length, { message: '等自检把结果交回', timeout: 180_000 }).toBe(1)
  const encoded = new URL(delivered[0] ?? '').searchParams.get(RESULT_PARAM)
  expect(encoded, '交回的地址里有结果').not.toBeNull()
  return decodeSelftestReport(encoded ?? '')
}

/** 各场景的账户名前缀（用户名最长 32 个字符，后面还要加角色与随机后缀） */
const PREFIXES: Readonly<Record<SelftestScenario, string>> = { 'read-only': 'st-ro', 'read-only-formulas': 'st-fx', 'edit-chrome': 'st-ed', 'enter-exit': 'st-ee' }

/** 造这个场景的样本与账户，取出它那一步（与驱动脚本同样的步骤） */
async function stepOf(scenario: SelftestScenario): Promise<SelftestStep> {
  const step = selftestSteps(await selftestScene(PREFIXES[scenario])).find(item => item.scenario === scenario)
  if (step === undefined)
    throw new Error(`没有 ${scenario} 这一步`)
  return step
}

test.describe('US-M2-11 页面自检（真实 Safari 复核用）在 Playwright 的浏览器里每项都通过', { tag: '@test-build' }, () => {
  for (const scenario of SELFTEST_SCENARIOS) {
    test(`场景 ${scenario}`, async ({ page }, testInfo) => {
      const step = await stepOf(scenario)
      const report = await runSelftest(page, step)
      await testInfo.attach('selftest-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
      expect(report.scenario).toBe(scenario)
      expect(report.page).toMatchObject({ state: 'ready', readOnly: scenario !== 'edit-chrome' })
      expect(report.checks.length, '有检查').toBeGreaterThan(0)
      expect(problemsOf(report)).toEqual([])
      expect((await serverProblemsOf(step)).problems, '服务器上的文档').toEqual([])
    })
  }
})

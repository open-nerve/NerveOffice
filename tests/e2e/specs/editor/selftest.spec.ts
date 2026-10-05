// 页面自检在 Playwright 的浏览器里（M3-P2 设计 §3.5，US-M2-11；M3-P4 设计 §3.15 的捕获时机复核）：真实 Safari 的复核用的是编辑器页里
// 编译进测试构建的自检（apps/web/src/editor/testing/selftest.ts 与 selftest-capture.ts，驱动脚本 tests/e2e/safari/selftest.ts 在本机按需运行，
// 不进 CI）。这里在三个浏览器里跑同样的自检、同样的入口页与结果的交回，核对每项检查都通过：
// - 自检本身是对的——它与 read-only.spec.ts 共用入口清单与预期，合成的事件与按角色找元素的办法、观察真实的自动保存（M3-P4 S7）与
//   按定义的公式核对在这里校准过，真实 Safari 上的不通过才说明 Safari 不同，而不是自检写错了；
// - 自检不会悄悄地坏掉：CI 每次都跑（驱动脚本只在本机按需运行）；
// - 真实 Safari 的复核报告与 Playwright 的 WebKit 对照时，用的就是这里的结果（附件 selftest-report）。
// 每一步一份文档；服务器上另核对（support/selftest-plan.ts 的 storedProblems）：只看不改的几步没有保存过，enter-exit 恰好保存了一次、
// 内容里有自检改的那一格；自动保存照常运行的几步至少保存了一次、存下的内容按定义核对；hidden-save 保存了两次（Playwright 的页面不会真的
// 隐藏：这里在第一次上传之后模拟可见性变成 hidden，与 reading-updates.spec.ts 同一个办法；真的隐藏由驱动脚本在真实 Safari 上另开标签页做到）。
// 自动保存（M3-P4 S7 审查 B1）：入口页在打开编辑器页之前写下"暂停定时的上传"（真实 Safari 里也是这样），自检开始时再暂停一次、
// 捕获时机的场景按自己的需要放开——结果不依赖打开时的状态。这里显式写明打开时暂停（与入口页一致，不靠夹具的默认值）；
// E2E_AUTOSAVE=running 时打开即照常（夹具在每个文档载入之前去掉入口页写的那一项），用来核对两种打开时的状态都通过
// 结果的交回与驱动脚本相同（整页跳到 next，结果在查询参数里）：next 是本机的地址（自检只把结果交给本机，M3-P2 复核 B7），
// 用被测站点自己的源加一个没有的路径，这里拦下那次导航、读出结果。
// 用到测试构建（自检的入口页与编辑器页里的自检）：标签 @test-build，外部模式测生产镜像时排除
import type { Page } from '@playwright/test'
import type { SelftestReport } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SelftestStep, SelftestStepDefinition } from '../../support/selftest-plan.ts'
import process from 'node:process'
import { decodeSelftestReport, RESULT_PARAM } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { revisionOf } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { problemsOf, SELFTEST_STEPS, selftestPageUrl, selftestScene, serverProblemsOf } from '../../support/selftest-plan.ts'
import { EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

// 打开编辑器页时暂停定时的自动保存（与入口页写的相同）；E2E_AUTOSAVE=running 时照常，核对自检不依赖打开时的状态（见文件开头）
test.use({ autosave: process.env.E2E_AUTOSAVE === 'running' ? 'running' : 'held' })

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
 * 结果的要点：场景、页面怎么打开的、有没有检查、问题（页面上的检查之外，驱动脚本另外核对的）与服务器上的文档。
 * 没有豁免的问题：主线程模式在计算中重建（formula-timing-main 的 formula.rebuild-during-calc）在 M3-P4 S5 规避之后同样要求通过
 */
async function summaryOf(report: SelftestReport, step: SelftestStep): Promise<unknown> {
  return {
    scenario: report.scenario,
    page: report.page,
    hasChecks: report.checks.length > 0,
    problems: problemsOf(report),
    server: (await serverProblemsOf(step)).problems,
  }
}

/** 只读打开的场景（查看者，与作者的 enter-exit：它从阅读开始，自己点"编辑""退出编辑"） */
const READ_ONLY_SCENARIOS: ReadonlySet<string> = new Set(['read-only', 'read-only-formulas', 'enter-exit'])

function passed(step: SelftestStep): unknown {
  return { scenario: step.scenario, page: { state: 'ready', readOnly: READ_ONLY_SCENARIOS.has(step.scenario) }, hasChecks: true, problems: [], server: [] }
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
    test(`步骤 ${definition.id}：第一次上传之后页面变成隐藏（这里模拟），自动保存在隐藏的那一刻捕获、上传留着的第二格，服务器上有两次保存`, async ({ page }, testInfo) => {
      const step = await stepOf(definition)
      const delivered = await startSelftest(page, step)
      await expect.poll(async () => revisionOf(step.documentId), { message: '等第一次上传', timeout: REPORT_TIMEOUT_MS }).toBe(2)
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

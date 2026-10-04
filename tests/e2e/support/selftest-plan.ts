// 页面自检怎么跑（M3-P2 设计 §3.5）：真实 Safari 的驱动脚本（safari/selftest.ts）与 Playwright 里的自检用例（specs/editor/selftest.spec.ts）共用。
// - 场景的样本与账户（selftestScene）：系统管理员建团队空间，作者是空间管理员，查看者是查看者；两份文档：只读样本，
//   与去掉公式缓存值的同一份样本（公式要在 Worker 里算出结果）；
// - 每一步的地址（selftestPageUrl）：自检的入口页（测试构建的 selftest.html）带上 # 片段——账户、文档、场景与结果交回的地址；
// - 结果的核对（problemsOf）：页面上的检查之外，驱动脚本与用例另外核对的（公式算出的值与样本的预期相同）。
// 这里只有纯函数与写库的辅助，不起浏览器
import type { SelftestReport, SelftestScenario } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from './database.ts'
import { NEXT_PARAM, selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createDocumentIn, createTeamSpace, createUser } from './database.ts'
import { readOnlySampleFor, SAMPLE_FORMULAS, sampleWithoutFormulaValuesFor } from './read-only-sample.ts'

/** 自检的入口页（只在测试构建里，vite.config.ts 的 TEST_ONLY_INPUTS） */
export const SELFTEST_PAGE = '/selftest.html'

/** 跑一步自检要的：用谁登录、打开哪份文档、跑哪个场景 */
export interface SelftestStep {
  /** 这一步的标识（结果交回时带着，按它对上） */
  readonly id: string
  readonly scenario: SelftestScenario
  readonly account: { readonly username: string, readonly password: string }
  readonly documentId: string
}

/** 自检的样本与账户 */
export interface SelftestScene {
  readonly author: TestUser
  readonly viewer: TestUser
  /** 只读样本（read-only、edit-chrome） */
  readonly sampleId: string
  /** 去掉公式缓存值的样本（read-only-formulas） */
  readonly formulasId: string
}

/** 写库造场景（与 support/read-only.ts 的 scene 相同的空间与角色，另加一份去掉公式缓存值的样本） */
export async function selftestScene(prefix: string): Promise<SelftestScene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const space = await createTeamSpace('页面自检', admin, [[author, 'admin'], [viewer, 'viewer']])
  const sampleId = await createDocumentIn(space.id, author, '只读样本', { snapshotFor: readOnlySampleFor })
  const formulasId = await createDocumentIn(space.id, author, '公式样本', { snapshotFor: sampleWithoutFormulaValuesFor })
  return { author, viewer, sampleId, formulasId }
}

/** 三个场景各一步：查看者的只读入口与公式，作者的界面对照（能编辑时界面都在） */
export function selftestSteps(scene: SelftestScene): SelftestStep[] {
  return [
    { id: 'read-only', scenario: 'read-only', account: scene.viewer, documentId: scene.sampleId },
    { id: 'read-only-formulas', scenario: 'read-only-formulas', account: scene.viewer, documentId: scene.formulasId },
    { id: 'edit-chrome', scenario: 'edit-chrome', account: scene.author, documentId: scene.sampleId },
  ]
}

/**
 * 一步自检的入口地址：origin 是被测站点的源，next 是结果交回的地址（收集端）。账户放在 # 片段里：片段不发给服务器，
 * 入口页读完马上从地址里去掉（apps/web/src/entries/selftest/sign-in.ts）
 */
export function selftestPageUrl(origin: string, step: SelftestStep, next: string): string {
  const fragment = new URLSearchParams({ user: step.account.username, password: step.account.password, document: step.documentId, scenario: step.scenario, [NEXT_PARAM]: next })
  return `${new URL(SELFTEST_PAGE, origin).href}#${fragment.toString()}`
}

/** 公式算出的值的键（与自检的 formulaValues 相同："工作表 id!A1"） */
function formulaKey(sheetId: string, cell: string): string {
  return `${sheetId}!${cell}`
}

/**
 * 一步的结果有什么问题（空数组就是通过）：页面上的检查（selftestPassed 的口径）之外，read-only-formulas 另核对样本里的几个公式
 * 算出了预期的值（与 read-only.spec.ts"公式在 Worker 里算出结果"同一组）
 */
export function problemsOf(report: SelftestReport): string[] {
  const problems: string[] = []
  if (report.failure !== undefined)
    problems.push(`没能跑完：${report.failure}`)
  for (const check of report.checks.filter(item => !item.pass))
    problems.push(`${check.id}：${check.detail}`)
  for (const error of report.pageErrors)
    problems.push(`页面错误：${error}`)
  for (const error of report.consoleErrors)
    problems.push(`console.error：${error}`)
  if (report.scenario === 'read-only-formulas' && report.failure === undefined) {
    for (const formula of SAMPLE_FORMULAS) {
      const actual = report.formulaValues?.[formulaKey(formula.sheetId, formula.cell)]
      if (actual !== formula.value)
        problems.push(`公式 ${formula.cell}（${formula.formula}）算出 ${JSON.stringify(actual)}，应当是 ${JSON.stringify(formula.value)}`)
    }
  }
  if (problems.length === 0 && !selftestPassed(report))
    problems.push('没有通过（没有检查）')
  return problems
}

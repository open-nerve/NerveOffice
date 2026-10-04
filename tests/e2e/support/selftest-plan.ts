// 页面自检怎么跑（M3-P2 设计 §3.5）：真实 Safari 的驱动脚本（safari/selftest.ts）与 Playwright 里的自检用例（specs/editor/selftest.spec.ts）共用。
// - 场景的样本与账户（selftestScene）：系统管理员建团队空间，作者是空间管理员，查看者是查看者；三份文档：只读样本、
//   去掉公式缓存值的同一份样本（公式要在 Worker 里算出结果），与作者进入、退出编辑用的另一份只读样本（enter-exit 保存一次）；
// - 每一步的地址（selftestPageUrl）：自检的入口页（测试构建的 selftest.html）带上 # 片段——账户、文档、场景与结果交回的地址；
// - 结果的核对（problemsOf）：页面上的检查之外，驱动脚本与用例另外核对的（公式算出的值与样本的预期相同；enter-exit 交回了两次切换的耗时）；
// - 服务器上的核对（serverProblemsOf，直接查库）：只读的几步没有保存过；enter-exit 恰好多了一个修订、内容里有改的那一格。
// 这里只有纯函数与读写库的辅助，不起浏览器
import type { SelftestReport, SelftestScenario } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from './database.ts'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { ENTER_EXIT_EDIT, NEXT_PARAM, selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createDocumentIn, createTeamSpace, createUser, withDatabase } from './database.ts'
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
  /** 作者进入、退出编辑用的样本（enter-exit：改一格、保存一次；与别的步骤分开，它们核对没有保存过） */
  readonly enterExitId: string
}

/** 写库造场景（与 support/read-only.ts 的 scene 相同的空间与角色，另加一份去掉公式缓存值的样本） */
export async function selftestScene(prefix: string): Promise<SelftestScene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const space = await createTeamSpace('页面自检', admin, [[author, 'admin'], [viewer, 'viewer']])
  const sampleId = await createDocumentIn(space.id, author, '只读样本', { snapshotFor: readOnlySampleFor })
  const formulasId = await createDocumentIn(space.id, author, '公式样本', { snapshotFor: sampleWithoutFormulaValuesFor })
  const enterExitId = await createDocumentIn(space.id, author, '进入退出样本', { snapshotFor: readOnlySampleFor })
  return { author, viewer, sampleId, formulasId, enterExitId }
}

/** 四个场景各一步：查看者的只读入口与公式，作者的界面对照（能编辑时界面都在），作者进入、退出编辑 */
export function selftestSteps(scene: SelftestScene): SelftestStep[] {
  return [
    { id: 'read-only', scenario: 'read-only', account: scene.viewer, documentId: scene.sampleId },
    { id: 'read-only-formulas', scenario: 'read-only-formulas', account: scene.viewer, documentId: scene.formulasId },
    { id: 'edit-chrome', scenario: 'edit-chrome', account: scene.author, documentId: scene.sampleId },
    { id: 'enter-exit', scenario: 'enter-exit', account: scene.author, documentId: scene.enterExitId },
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

/** enter-exit 交回的两次切换的耗时（进入、退出），各自到 steady 的时刻都要有 */
const SWITCH_TIMINGS = ['switch.enter', 'switch.exit'] as const

/**
 * 一步的结果有什么问题（空数组就是通过）：页面上的检查（selftestPassed 的口径）之外，read-only-formulas 另核对样本里的几个公式
 * 算出了预期的值（与 read-only.spec.ts"公式在 Worker 里算出结果"同一组）；enter-exit 另核对交回了两次切换的耗时
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
  if (report.scenario === 'enter-exit' && report.failure === undefined) {
    for (const id of SWITCH_TIMINGS) {
      const timing = report.timings?.find(item => item.id === id)
      if (timing === undefined || typeof timing.ms.ready !== 'number' || typeof timing.ms.steady !== 'number')
        problems.push(`没有交回 ${id} 的耗时`)
    }
  }
  if (problems.length === 0 && !selftestPassed(report))
    problems.push('没有通过（没有检查）')
  return problems
}

/** 服务器上这份文档的修订号、修订记录的条数与内容（直接查库，快照是 gzip 压缩的 JSON）；没有这份文档时为 undefined */
async function storedDocument(documentId: string): Promise<{ readonly revision: number, readonly revisions: number, readonly snapshot: string } | undefined> {
  const row = await withDatabase(async client => (await client.query<{ revision: number, revisions: string, snapshot: Buffer }>(
    `SELECT d.revision, (SELECT count(*) FROM document_revisions r WHERE r.document_id = d.id) AS revisions, c.snapshot
     FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1`,
    [documentId],
  )).rows[0])
  return row === undefined ? undefined : { revision: row.revision, revisions: Number(row.revisions), snapshot: zlib.gunzipSync(Buffer.from(row.snapshot)).toString('utf8') }
}

/** 快照里一格的值 */
function cellValueOf(snapshot: string, sheetId: string, row: number, column: number): unknown {
  const workbook = JSON.parse(snapshot) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly v?: unknown }>>>> }>> }
  return workbook.sheets[sheetId]?.cellData?.[row]?.[column]?.v
}

/**
 * 一步在服务器上该有的样子（空数组就是对的）：自检只看不改的几步，文档还是修订号 1（没有保存过）；enter-exit 恰好保存了一次
 * （修订号 2），内容里有它改的那一格（ENTER_EXIT_EDIT）。返回修订号与问题
 */
export async function serverProblemsOf(step: SelftestStep): Promise<{ readonly revision: number | undefined, readonly problems: string[] }> {
  const stored = await storedDocument(step.documentId)
  if (stored === undefined)
    return { revision: undefined, problems: [`服务器上没有文档 ${step.documentId}`] }
  const problems: string[] = []
  const expected = step.scenario === 'enter-exit' ? 2 : 1
  if (stored.revision !== expected || stored.revisions !== expected)
    problems.push(`文档 ${step.documentId} 的修订号是 ${stored.revision}、修订记录 ${stored.revisions} 条（应当都是 ${expected}：${expected === 1 ? '没有保存过' : '退出编辑时保存了一次'}）`)
  if (step.scenario === 'enter-exit') {
    const value = cellValueOf(stored.snapshot, ENTER_EXIT_EDIT.sheetId, ENTER_EXIT_EDIT.row, ENTER_EXIT_EDIT.column)
    if (value !== ENTER_EXIT_EDIT.value)
      problems.push(`服务器上"${ENTER_EXIT_EDIT.sheetName}"表 ${ENTER_EXIT_EDIT.cell} 是 ${JSON.stringify(value)}（应当是 ${JSON.stringify(ENTER_EXIT_EDIT.value)}）`)
  }
  return { revision: stored.revision, problems }
}

// 页面自检怎么跑（M3-P2 设计 §3.5，M3-P4 设计 §3.15）：真实 Safari 的驱动脚本（safari/selftest.ts）与 Playwright 里的自检用例（specs/editor/selftest.spec.ts）共用。
// - 步骤（SELFTEST_STEPS）：每一步一个场景、一个账户、一份样本（每一步自己一份文档：有的步骤会保存，与别的分开），可选的公式模式；
// - 场景的样本与账户（selftestScene）：系统管理员建团队空间，作者是空间管理员，查看者是查看者；按步骤写库造文档：只读样本、
//   去掉公式缓存值的同一份样本（公式要在 Worker 里算出结果）、去掉图片的样本（enter-exit 保存一次：样本的 data: 图片 M3-P3 起服务端拒绝保存，
//   read-only-sample.ts 的 sampleWithoutImagesFor）、新建的模板、捕获时机复核的公式样本与 5 万行的大表（capture-samples.ts）；
// - 每一步的地址（selftestPageUrl）：自检的入口页（测试构建的 selftest.html）带上 # 片段——账户、文档、场景、公式模式与结果交回的地址；
// - 结果的核对（problemsOf）：页面上的检查之外，驱动脚本与用例另外核对的（公式算出的值与样本的预期相同；enter-exit 交回了两次切换的耗时）；
// - 服务器上的核对（serverProblemsOf，直接查库）：只看不改的步骤没有保存过；enter-exit 恰好多了一个修订、内容里有改的那一格；
//   formula-timing 最后退出编辑时保存了一次；hidden-save 保存了两次、内容里有隐藏之前与隐藏的那一刻写的两格。
// 这里只有纯函数与读写库的辅助，不起浏览器
import type { SelftestFormulaMode, SelftestReport, SelftestScenario } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SnapshotFor, TestUser } from './database.ts'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { ENTER_EXIT_EDIT, FORMULA_MODE_PARAM, FORMULA_MODE_VALUES, HIDDEN_SAVE_EDITS, NEXT_PARAM, selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { bigSheetFor, formulaSampleFor } from './capture-samples.ts'
import { createDocumentIn, createTeamSpace, createUser, withDatabase } from './database.ts'
import { readOnlySampleFor, SAMPLE_FORMULAS, sampleWithoutFormulaValuesFor, sampleWithoutImagesFor } from './read-only-sample.ts'

/** 自检的入口页（只在测试构建里，vite.config.ts 的 TEST_ONLY_INPUTS） */
export const SELFTEST_PAGE = '/selftest.html'

/** 一步用哪份样本 */
export type SelftestSample = 'read-only' | 'read-only-formulas' | 'without-images' | 'template' | 'formulas' | 'big-sheet'

/** 样本怎么生成（写库时换上文档自己的 unitId） */
const SAMPLES: Readonly<Record<SelftestSample, SnapshotFor>> = {
  'read-only': readOnlySampleFor,
  'read-only-formulas': sampleWithoutFormulaValuesFor,
  'without-images': sampleWithoutImagesFor,
  'template': sheetSnapshotFor,
  'formulas': formulaSampleFor,
  'big-sheet': bigSheetFor,
}

/** 一步的定义：标识（结果交回时按它对上）、场景、谁（作者能编辑，查看者只能看）、样本，可选的公式模式（测试构建的开关） */
export interface SelftestStepDefinition {
  readonly id: string
  readonly scenario: SelftestScenario
  readonly role: 'author' | 'viewer'
  readonly sample: SelftestSample
  readonly formula?: SelftestFormulaMode
}

/**
 * 全部步骤，按这个顺序跑：
 * - M3-P2：查看者的只读入口与公式，作者的界面对照（能编辑时界面都在），作者进入、退出编辑（保存一次）；
 * - M3-P4 S1（捕获时机的复核，都在编辑时）：环境、变更检测（只读样本）、公式时序（Worker 与主线程各一步）、自动行高与大表复制（大表）、
 *   组合输入；最后是 hidden-save（驱动脚本在它第一次保存之后另开标签页让它隐藏，按库里的证据判定，所以放在最后）
 */
export const SELFTEST_STEPS: readonly SelftestStepDefinition[] = [
  { id: 'read-only', scenario: 'read-only', role: 'viewer', sample: 'read-only' },
  { id: 'read-only-formulas', scenario: 'read-only-formulas', role: 'viewer', sample: 'read-only-formulas' },
  { id: 'edit-chrome', scenario: 'edit-chrome', role: 'author', sample: 'read-only' },
  { id: 'enter-exit', scenario: 'enter-exit', role: 'author', sample: 'without-images' },
  { id: 'environment', scenario: 'environment', role: 'author', sample: 'template' },
  { id: 'change-detection', scenario: 'change-detection', role: 'author', sample: 'read-only' },
  { id: 'formula-timing-worker', scenario: 'formula-timing', role: 'author', sample: 'formulas', formula: 'worker' },
  { id: 'formula-timing-main', scenario: 'formula-timing', role: 'author', sample: 'formulas', formula: 'main-thread' },
  { id: 'auto-height', scenario: 'auto-height', role: 'author', sample: 'big-sheet' },
  { id: 'large-copy', scenario: 'large-copy', role: 'author', sample: 'big-sheet' },
  { id: 'composition', scenario: 'composition', role: 'author', sample: 'template' },
  { id: 'hidden-save', scenario: 'hidden-save', role: 'author', sample: 'template' },
]

/** 跑一步自检要的：用谁登录、打开哪份文档、跑哪个场景（与公式模式） */
export interface SelftestStep {
  /** 这一步的标识（结果交回时带着，按它对上） */
  readonly id: string
  readonly scenario: SelftestScenario
  readonly account: { readonly username: string, readonly password: string }
  readonly documentId: string
  readonly formula?: SelftestFormulaMode | undefined
}

/** 自检的账户与步骤 */
export interface SelftestScene {
  readonly author: TestUser
  readonly viewer: TestUser
  readonly steps: readonly SelftestStep[]
}

/** 定义与造好的文档拼成步骤（documentIds 与 definitions 一一对应） */
export function stepsOf(definitions: readonly SelftestStepDefinition[], people: { readonly author: TestUser, readonly viewer: TestUser }, documentIds: readonly string[]): SelftestStep[] {
  if (documentIds.length !== definitions.length)
    throw new Error(`${definitions.length} 步却有 ${documentIds.length} 份文档`)
  return definitions.map((definition, index) => ({
    id: definition.id,
    scenario: definition.scenario,
    account: definition.role === 'author' ? people.author : people.viewer,
    documentId: documentIds[index] ?? '',
    ...(definition.formula === undefined ? {} : { formula: definition.formula }),
  }))
}

/** 写库造场景：团队空间与账户（与 support/read-only.ts 的 scene 相同的空间与角色），每一步一份文档（作者建的） */
export async function selftestScene(prefix: string, definitions: readonly SelftestStepDefinition[] = SELFTEST_STEPS): Promise<SelftestScene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const space = await createTeamSpace('页面自检', admin, [[author, 'admin'], [viewer, 'viewer']])
  const documentIds: string[] = []
  for (const definition of definitions)
    documentIds.push(await createDocumentIn(space.id, author, `自检 ${definition.id}`, { snapshotFor: SAMPLES[definition.sample] }))
  return { author, viewer, steps: stepsOf(definitions, { author, viewer }, documentIds) }
}

/**
 * 一步自检的入口地址：origin 是被测站点的源，next 是结果交回的地址（收集端）。账户放在 # 片段里：片段不发给服务器，
 * 入口页读完马上从地址里去掉（apps/web/src/entries/selftest/sign-in.ts）
 */
export function selftestPageUrl(origin: string, step: SelftestStep, next: string): string {
  const fragment = new URLSearchParams({ user: step.account.username, password: step.account.password, document: step.documentId, scenario: step.scenario, [NEXT_PARAM]: next })
  if (step.formula !== undefined)
    fragment.set(FORMULA_MODE_PARAM, FORMULA_MODE_VALUES[step.formula])
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

/** 一步在服务器上该有的修订号与内容：只看不改的步骤没有保存过；enter-exit 退出编辑时保存了一次；hidden-save 保存了两次 */
interface ServerExpectation {
  readonly revision: number
  readonly why: string
  readonly cells: readonly { readonly sheetId: string, readonly cell: string, readonly row: number, readonly column: number, readonly value: string }[]
}

function serverExpectation(step: SelftestStep): ServerExpectation {
  if (step.scenario === 'enter-exit')
    return { revision: 2, why: '退出编辑时保存了一次', cells: [ENTER_EXIT_EDIT] }
  if (step.scenario === 'formula-timing')
    return { revision: 2, why: '最后的"计算进行中重建"退出编辑时保存了一次', cells: [] }
  if (step.scenario === 'hidden-save')
    return { revision: 3, why: '隐藏之前保存一次、隐藏的那一刻又保存一次', cells: HIDDEN_SAVE_EDITS }
  return { revision: 1, why: '没有保存过', cells: [] }
}

/**
 * 一步在服务器上该有的样子（空数组就是对的）：自检只看不改的几步，文档还是修订号 1（没有保存过）；enter-exit 恰好保存了一次
 * （修订号 2），内容里有它改的那一格（ENTER_EXIT_EDIT）；formula-timing 最后退出编辑时保存了一次（修订号 2）；hidden-save 保存了两次
 * （修订号 3），内容里有它写的两格（HIDDEN_SAVE_EDITS）。
 * 返回修订号与问题
 */
export async function serverProblemsOf(step: SelftestStep): Promise<{ readonly revision: number | undefined, readonly problems: string[] }> {
  const stored = await storedDocument(step.documentId)
  if (stored === undefined)
    return { revision: undefined, problems: [`服务器上没有文档 ${step.documentId}`] }
  const problems: string[] = []
  const expected = serverExpectation(step)
  if (stored.revision !== expected.revision || stored.revisions !== expected.revision)
    problems.push(`文档 ${step.documentId} 的修订号是 ${stored.revision}、修订记录 ${stored.revisions} 条（应当都是 ${expected.revision}：${expected.why}）`)
  for (const cell of expected.cells) {
    const value = cellValueOf(stored.snapshot, cell.sheetId, cell.row, cell.column)
    if (value !== cell.value)
      problems.push(`服务器上 ${cell.cell} 是 ${JSON.stringify(value)}（应当是 ${JSON.stringify(cell.value)}）`)
  }
  return { revision: stored.revision, problems }
}

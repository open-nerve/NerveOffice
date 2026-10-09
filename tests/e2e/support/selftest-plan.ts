// 页面自检怎么跑（M3-P2 设计 §3.5，M3-P4 设计 §3.15）：真实 Safari 的驱动脚本（safari/selftest.ts）与 Playwright 里的自检用例（specs/editor/selftest.spec.ts）共用。
// - 步骤（SELFTEST_STEPS）：每一步一个场景、一个账户、一份样本（每一步自己一份文档：有的步骤会保存，与别的分开），可选的公式模式；
// - 场景的样本与账户（selftestScene）：系统管理员建团队空间，作者是空间管理员，查看者是查看者；按步骤写库造文档：只读样本、
//   去掉公式缓存值的同一份样本（公式要在 Worker 里算出结果）、去掉图片的样本（enter-exit 保存一次：样本的 data: 图片 M3-P3 起服务端拒绝保存，
//   read-only-sample.ts 的 sampleWithoutImagesFor）、新建的模板、捕获时机复核的公式样本与 5 万行的大表（capture-samples.ts）；
// - 每一步的地址（selftestPageUrl）：自检的入口页（测试构建的 selftest.html）带上 # 片段——账户、文档、场景、公式模式与结果交回的地址；
// - 结果的核对（problemsOf）：页面上的检查之外，驱动脚本与用例另外核对的（公式算出的值与样本的预期相同；enter-exit 交回了两次切换的耗时）；
// - 服务器上的核对（serverProblemsOf，直接查库；storedProblems 是纯函数）：只看不改的步骤与 change-detection 没有保存过；enter-exit 恰好
//   多了一个修订、内容里有改的那一格；自动保存照常运行的几步（M3-P4 S7：formula-timing、auto-height、large-copy、composition）至少保存了
//   一次，存下的内容另按定义核对（公式、字号与自动行高、复制品、批注）；hidden-save 恰好保存了两次、内容里有隐藏之前与隐藏的那一刻写的两格；
//   交接的几步（M3-P5 S8）随走的路（A 回应了没有、刷新时停住的那次保存提交了没有）；请求编辑的两条路（M3-P6）同样随走的路。交接的编排与库里的
//   时间线在 ./selftest-handover.ts，请求编辑的编排（另一方由驱动脚本经接口扮演）与判定在 ./selftest-request.ts；
// - 真实浏览器的前置复核（M4-P1 S1，设计 §3.6）：首屏与公式冻结、捕获成本、存储、密钥交给 Worker、Worker 的停顿，各一步或几步（运行次数 runs 由
//   驱动脚本给，进地址）；页面只交回事实与计时，判定在 ./probe-verdicts.ts。写满（storage-quota）不在步骤里：只在 Playwright 的 Chromium 系经 CDP 覆盖配额时做。
// 这里只有纯函数与读写库的辅助，不起浏览器
import type { HandoverScenario, ProbeScenario, RequestScenario, SelftestFormulaMode, SelftestReport, SelftestScenario } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SnapshotFor, TestUser } from './database.ts'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { BIG_SHEET, BULK_SAMPLE_BYTES, cellCount, verifyFormulaSnapshot } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { COMPOSITION_NOTE, ENTER_EXIT_EDIT, FORMULA_MODE_PARAM, FORMULA_MODE_VALUES, HIDDEN_SAVE_EDITS, isProbeScenario, NEXT_PARAM, PAUSED_HOLDER_EDITS, REFRESH_SAVE_EDIT, REQUEST_WAITER_EDIT, RUNS_PARAM, selftestEditorUrl, selftestPassed, TAKEOVER_EDITS } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { bigSheetFor, bulkSampleFor, formulaSampleFor, perfSampleFor } from './capture-samples.ts'
import { createDocumentIn, createTeamSpace, createUser, withDatabase } from './database.ts'
import { readOnlySampleFor, SAMPLE_FORMULAS, sampleWithoutFormulaValuesFor, sampleWithoutImagesFor } from './read-only-sample.ts'

/** 自检的入口页（只在测试构建里，vite.config.ts 的 TEST_ONLY_INPUTS） */
export const SELFTEST_PAGE = '/selftest.html'

/** 一步用哪份样本（M4-P1 S1 另有按字节数生成的明细表 bulk-1m、bulk-5m 与性能基线的 perf-50k） */
export type SelftestSample = 'read-only' | 'read-only-formulas' | 'without-images' | 'template' | 'formulas' | 'big-sheet' | 'bulk-1m' | 'bulk-5m' | 'perf-50k'

/** 样本怎么生成（写库时换上文档自己的 unitId） */
const SAMPLES: Readonly<Record<SelftestSample, SnapshotFor>> = {
  'read-only': readOnlySampleFor,
  'read-only-formulas': sampleWithoutFormulaValuesFor,
  'without-images': sampleWithoutImagesFor,
  'template': sheetSnapshotFor,
  'formulas': formulaSampleFor,
  'big-sheet': bigSheetFor,
  'bulk-1m': bulkSampleFor(BULK_SAMPLE_BYTES.small),
  'bulk-5m': bulkSampleFor(BULK_SAMPLE_BYTES.large),
  'perf-50k': perfSampleFor,
}

/**
 * 一步的定义：标识（结果交回时按它对上）、场景、谁（作者能编辑，查看者只能看）、样本，可选的公式模式（测试构建的开关）。
 * 交接的复核（M3-P5）另有：sharesDocumentOf——与那一步用同一份文档（另开的 B 打开 A 正在编辑的那一份）；opens——怎样打开：entry 是自检的
 * 入口页（登录之后跳到编辑器页，默认），editor 是直接打开编辑器页（同一个浏览器里已经登录：B 再登录一次会换掉会话的 Cookie，A 的编辑权
 * 绑定的那次登录随之对不上）
 */
export interface SelftestStepDefinition {
  readonly id: string
  readonly scenario: SelftestScenario
  readonly role: 'author' | 'viewer'
  readonly sample: SelftestSample
  readonly formula?: SelftestFormulaMode
  readonly sharesDocumentOf?: string
  readonly opens?: 'entry' | 'editor'
}

/**
 * 全部步骤，按这个顺序跑：
 * - M3-P2：查看者的只读入口与公式，作者的界面对照（能编辑时界面都在），作者进入、退出编辑（保存一次）；
 * - M3-P4 S1（捕获时机的复核，都在编辑时）：环境、变更检测（只读样本）、公式时序（Worker 与主线程各一步）、自动行高与大表复制（大表）、
 *   组合输入；hidden-save（驱动脚本在它第一次保存之后另开标签页让它隐藏，按库里的证据判定）是由上一步带过去的最后一步；
 * - M3-P5 S8（交接的复核，驱动脚本各开一个新的标签页）：两个标签页的本人接管（A 与 B，同一份文档；再一对里的 A 收不到交接频道的消息）、
 *   刷新时在途的保存；
 * - M3-P6 S5（请求编辑的两条路，DEF-062，驱动脚本各开一个新的标签页、经接口扮演另一方——场景的协作者）：请求方在后台停在交给了我、回到前台才进入
 *   （request-waiter）；持有者被暂停时自动交出走到到期（paused-holder，盖屏，放在最后）；
 * - M4-P1 S1（真实浏览器的前置复核，设计 §3.6，都由上一步带过去，放在 hidden-save 之前）：首屏与公式冻结（作者，perf-50k，Worker、主线程、
 *   再一次 Worker——只选这几步时第一步是这次运行里第一次打开编辑器页，冷的；之后的热），捕获成本（作者，约 1 MiB 与约 5 MiB），存储、密钥交给 Worker、
 *   Worker 的停顿（查看者，阅读时跑；密钥单独一步：万一停在钥匙串的提示上，别的几项已经交回）
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
  { id: 'perf-worker', scenario: 'perf-baseline', role: 'author', sample: 'perf-50k', formula: 'worker' },
  { id: 'perf-main', scenario: 'perf-baseline', role: 'author', sample: 'perf-50k', formula: 'main-thread' },
  { id: 'perf-worker-warm', scenario: 'perf-baseline', role: 'author', sample: 'perf-50k', formula: 'worker' },
  { id: 'capture-1m', scenario: 'capture-cost', role: 'author', sample: 'bulk-1m' },
  { id: 'capture-5m', scenario: 'capture-cost', role: 'author', sample: 'bulk-5m' },
  { id: 'storage', scenario: 'storage', role: 'viewer', sample: 'template' },
  { id: 'key-transfer', scenario: 'key-transfer', role: 'viewer', sample: 'template' },
  { id: 'worker-stall', scenario: 'worker-stall', role: 'viewer', sample: 'template' },
  { id: 'hidden-save', scenario: 'hidden-save', role: 'author', sample: 'template' },
  { id: 'takeover-holder', scenario: 'takeover-holder', role: 'author', sample: 'template' },
  { id: 'takeover-taker', scenario: 'takeover-taker', role: 'author', sample: 'template', sharesDocumentOf: 'takeover-holder', opens: 'editor' },
  { id: 'takeover-deaf-holder', scenario: 'takeover-holder-deaf', role: 'author', sample: 'template' },
  { id: 'takeover-deaf-taker', scenario: 'takeover-taker', role: 'author', sample: 'template', sharesDocumentOf: 'takeover-deaf-holder', opens: 'editor' },
  { id: 'refresh-save', scenario: 'refresh-save', role: 'author', sample: 'template' },
  { id: 'request-waiter', scenario: 'request-waiter', role: 'author', sample: 'template' },
  { id: 'paused-holder', scenario: 'paused-holder', role: 'author', sample: 'template' },
]

/** 跑一步自检要的：用谁登录、打开哪份文档、跑哪个场景（与公式模式）、怎样打开（入口页或者直接打开编辑器页） */
export interface SelftestStep {
  /** 这一步的标识（结果交回时带着，按它对上） */
  readonly id: string
  readonly scenario: SelftestScenario
  readonly account: { readonly username: string, readonly password: string }
  readonly documentId: string
  readonly formula?: SelftestFormulaMode | undefined
  /** 怎样打开：没有时是入口页 */
  readonly opens?: 'entry' | 'editor' | undefined
  /** 与哪一步共用文档（那一步的 id）；没有时 undefined */
  readonly sharesDocumentOf?: string | undefined
  /** 运行次数（RUNS_PARAM，M4-P1）：只给真实浏览器的复核（PROBE_SCENARIOS）的步骤；没有时页面用各场景最少的次数 */
  readonly runs?: number | undefined
}

/**
 * 自检的账户与步骤。peer（协作者，空间的编辑者）是请求编辑的两条路（M3-P6）里由驱动脚本经接口扮演的另一方：路 1 里他在编辑、交出，路 2 里他请求编辑、
 * 到期之后接手
 */
export interface SelftestScene {
  readonly author: TestUser
  readonly viewer: TestUser
  readonly peer: TestUser
  readonly steps: readonly SelftestStep[]
}

/**
 * 定义与造好的文档拼成步骤（documentIds 与 definitions 一一对应；共用文档的那一步在 documentIds 里随便填，取它共用的那一步的文档）。
 * runs 只交给真实浏览器的复核的步骤（别的场景不看它，地址里也不带）
 */
export function stepsOf(definitions: readonly SelftestStepDefinition[], people: { readonly author: TestUser, readonly viewer: TestUser }, documentIds: readonly string[], runs?: number): SelftestStep[] {
  if (documentIds.length !== definitions.length)
    throw new Error(`${definitions.length} 步却有 ${documentIds.length} 份文档`)
  const documentOf = (definition: SelftestStepDefinition, index: number): string => {
    if (definition.sharesDocumentOf === undefined)
      return documentIds[index] ?? ''
    const shared = definitions.findIndex(item => item.id === definition.sharesDocumentOf)
    if (shared < 0 || definitions[shared]?.sharesDocumentOf !== undefined)
      throw new Error(`${definition.id} 共用的 ${definition.sharesDocumentOf} 不在步骤里（或者它自己也是共用的）`)
    return documentIds[shared] ?? ''
  }
  return definitions.map((definition, index) => ({
    id: definition.id,
    scenario: definition.scenario,
    account: definition.role === 'author' ? people.author : people.viewer,
    documentId: documentOf(definition, index),
    opens: definition.opens ?? 'entry',
    ...(definition.formula === undefined ? {} : { formula: definition.formula }),
    ...(definition.sharesDocumentOf === undefined ? {} : { sharesDocumentOf: definition.sharesDocumentOf }),
    ...(runs === undefined || !isProbeScenario(definition.scenario) ? {} : { runs }),
  }))
}

/**
 * 写库造场景：团队空间与账户（与 support/read-only.ts 的 scene 相同的空间与角色，另加协作者：编辑者，请求编辑的两条路里经接口扮演另一方），
 * 每一步一份文档（作者建的；共用文档的那一步不另建）。runs：真实浏览器的复核的运行次数（驱动脚本给；Playwright 的校准不给）
 */
export async function selftestScene(prefix: string, definitions: readonly SelftestStepDefinition[] = SELFTEST_STEPS, runs?: number): Promise<SelftestScene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const peer = await createUser(`${prefix}-peer`, '协作者')
  const space = await createTeamSpace('页面自检', admin, [[author, 'admin'], [viewer, 'viewer'], [peer, 'editor']])
  const documentIds: string[] = []
  for (const definition of definitions)
    documentIds.push(definition.sharesDocumentOf === undefined ? await createDocumentIn(space.id, author, `自检 ${definition.id}`, { snapshotFor: SAMPLES[definition.sample] }) : '')
  return { author, viewer, peer, steps: stepsOf(definitions, { author, viewer }, documentIds, runs) }
}

/**
 * 一步自检的入口地址：origin 是被测站点的源，next 是结果交回的地址（收集端）。账户放在 # 片段里：片段不发给服务器，
 * 入口页读完马上从地址里去掉（apps/web/src/entries/selftest/sign-in.ts）。直接打开编辑器页的那一步（opens 是 editor：同一个浏览器里已经登录）
 * 是编辑器页的地址，带着场景与 next（不带账户）
 */
export function selftestPageUrl(origin: string, step: SelftestStep, next: string): string {
  if (step.opens === 'editor')
    return selftestEditorUrl(origin, step.documentId, step.scenario, next, step.formula, step.runs)
  const fragment = new URLSearchParams({ user: step.account.username, password: step.account.password, document: step.documentId, scenario: step.scenario, [NEXT_PARAM]: next })
  if (step.formula !== undefined)
    fragment.set(FORMULA_MODE_PARAM, FORMULA_MODE_VALUES[step.formula])
  if (step.runs !== undefined)
    fragment.set(RUNS_PARAM, String(step.runs))
  return `${new URL(SELFTEST_PAGE, origin).href}#${fragment.toString()}`
}

/** 公式算出的值的键（与自检的 formulaValues 相同："工作表 id!A1"） */
function formulaKey(sheetId: string, cell: string): string {
  return `${sheetId}!${cell}`
}

/** enter-exit 交回的两次切换的耗时（进入、退出），各自到 steady 的时刻都要有 */
const SWITCH_TIMINGS = ['switch.enter', 'switch.exit'] as const

/**
 * 交接的场景（M3-P5）交回的路：每个场景认得的几种（selftest-report.ts 的 path）。请求编辑的两条路（M3-P6）：请求方只认设计的那一条；被盖屏的持有者
 * 两条都认——被暂停了走到到期（lost-after-pause），或者没被暂停、空闲满 2 分钟自动交出（handed-over：真实 Safari 怎样对待被挡住的编辑器页正是要复核的）。
 * 页面自己判读出别的路时说明哪里不对（apps/web/src/editor/testing/selftest-request.ts 的 WaiterPath、PausedHolderPath）
 */
export const HANDOVER_PATHS: Readonly<Partial<Record<SelftestScenario, readonly string[]>>> = {
  'takeover-holder': ['handed-over', 'lost'],
  // 收不到交接频道的消息：只会失去编辑权
  'takeover-holder-deaf': ['lost'],
  'takeover-taker': ['answered', 'silent'],
  'refresh-save': ['committed', 'expired'],
  'request-waiter': ['entered-on-return'],
  'paused-holder': ['lost-after-pause', 'handed-over'],
}

/**
 * 一步的结果有什么问题（空数组就是通过）：页面上的检查（selftestPassed 的口径）之外，read-only-formulas 另核对样本里的几个公式
 * 算出了预期的值（与 read-only.spec.ts"公式在 Worker 里算出结果"同一组）；enter-exit 另核对交回了两次切换的耗时；交接的场景另核对交回了
 * 认得的路（HANDOVER_PATHS）
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
  const paths = HANDOVER_PATHS[report.scenario as SelftestScenario]
  if (paths !== undefined && report.failure === undefined && !paths.includes(report.path ?? ''))
    problems.push(`交回的路是 ${report.path ?? '没有'}（应当是 ${paths.join('、')} 之一）`)
  if (problems.length === 0 && !selftestPassed(report))
    problems.push('没有通过（没有检查）')
  return problems
}

/** 服务器上的一份文档：修订号、修订记录的条数、"公式待更新"与内容（快照的原文） */
export interface StoredDocument {
  readonly revision: number
  readonly revisions: number
  readonly formulasPending: boolean
  readonly snapshot: string
}

/** 服务器上这份文档（直接查库，快照是 gzip 压缩的 JSON）；没有这份文档时为 undefined */
async function storedDocument(documentId: string): Promise<StoredDocument | undefined> {
  const row = await withDatabase(async client => (await client.query<{ revision: number, revisions: string, formulas_pending: boolean, snapshot: Buffer }>(
    `SELECT d.revision, (SELECT count(*) FROM document_revisions r WHERE r.document_id = d.id) AS revisions, d.formulas_pending, c.snapshot
     FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1`,
    [documentId],
  )).rows[0])
  return row === undefined ? undefined : { revision: row.revision, revisions: Number(row.revisions), formulasPending: row.formulas_pending, snapshot: zlib.gunzipSync(Buffer.from(row.snapshot)).toString('utf8') }
}

interface StoredCell {
  readonly v?: unknown
  readonly s?: unknown
}

interface StoredWorkbook {
  readonly sheetOrder?: readonly string[]
  readonly styles?: Readonly<Record<string, { readonly fs?: unknown } | null>>
  readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, StoredCell>>>>, readonly rowData?: Readonly<Record<string, { readonly ah?: unknown } | null>> }>>
  readonly resources?: readonly { readonly name: string, readonly data: string }[]
}

/** 快照里一格的值 */
function cellValueOf(snapshot: string, sheetId: string, row: number, column: number): unknown {
  return (JSON.parse(snapshot) as StoredWorkbook).sheets[sheetId]?.cellData?.[row]?.[column]?.v
}

/** 快照里一格的批注（SHEET_NOTE_PLUGIN 的资源） */
function noteOf(snapshot: string, sheetId: string, row: number, column: number): unknown {
  const data = (JSON.parse(snapshot) as StoredWorkbook).resources?.find(resource => resource.name === 'SHEET_NOTE_PLUGIN')?.data
  if (data === undefined || data === '')
    return undefined
  return (JSON.parse(data) as Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { readonly note?: unknown }>>>>>>)[sheetId]?.[row]?.[column]?.note
}

/** 自动行高：大表每一行的字号都是 auto-height 改的 28，每一行都有算出的自动行高（ah）——迟到的行高也存上了 */
const AUTO_HEIGHT_FONT_SIZE = 28

function autoHeightProblems(snapshot: string): string[] {
  const workbook = JSON.parse(snapshot) as StoredWorkbook
  const sheet = workbook.sheets[BIG_SHEET.id]
  const styleOf = (cell: StoredCell | undefined): { readonly fs?: unknown } | null | undefined =>
    typeof cell?.s === 'string' ? workbook.styles?.[cell.s] : (cell?.s as { readonly fs?: unknown } | null | undefined)
  let resized = 0
  let measured = 0
  for (let row = 0; row < BIG_SHEET.rows; row += 1) {
    if (styleOf(sheet?.cellData?.[row]?.[0])?.fs === AUTO_HEIGHT_FONT_SIZE)
      resized += 1
    const height = sheet?.rowData?.[row]?.ah
    if (typeof height === 'number' && height > 0)
      measured += 1
  }
  const problems: string[] = []
  if (resized !== BIG_SHEET.rows)
    problems.push(`大表 ${BIG_SHEET.rows} 行里字号是 ${AUTO_HEIGHT_FONT_SIZE} 的 ${resized} 行`)
  if (measured !== BIG_SHEET.rows)
    problems.push(`大表 ${BIG_SHEET.rows} 行里有自动行高（ah）的 ${measured} 行（迟到的行高没有存上？）`)
  return problems
}

/** 大表复制：两张表各 5 万格（原表与复制品） */
function largeCopyProblems(snapshot: string): string[] {
  const order = (JSON.parse(snapshot) as StoredWorkbook).sheetOrder ?? []
  const counts = order.map(id => cellCount(snapshot, id))
  return order.length === 2 && counts.every(count => count === BIG_SHEET.rows) ? [] : [`工作表 ${order.join('、')} 各有 ${counts.join('、')} 格（应当是原表与复制品两张、各 ${BIG_SHEET.rows} 格）`]
}

/** 公式时序：全部公式与按定义算出的一致 */
function formulaProblems(snapshot: string): string[] {
  const verdict = verifyFormulaSnapshot(snapshot)
  return verdict.staleCount === 0 ? [] : [`${verdict.staleCount}/${verdict.checked} 个公式与按定义算出的不同：${verdict.stale.join('、')}（${JSON.stringify(verdict.byKind)}）`]
}

/** 组合输入：批注是选定的文字 */
function compositionProblems(snapshot: string): string[] {
  const note = noteOf(snapshot, COMPOSITION_NOTE.sheetId, COMPOSITION_NOTE.row, COMPOSITION_NOTE.column)
  return note === COMPOSITION_NOTE.text ? [] : [`${COMPOSITION_NOTE.cell} 的批注是 ${JSON.stringify(note) ?? '空'}（应当是选定的"${COMPOSITION_NOTE.text}"）`]
}

interface ExpectedCell {
  readonly sheetId: string
  readonly cell: string
  readonly row: number
  readonly column: number
  readonly value: string
}

/**
 * 一步在服务器上该有的样子：修订号（恰好几，或者至少几：自动保存照常运行的场景上传几次随时序而定）与为什么、内容里该有的格（与不该有的）、
 * 对存下的内容的另外的核对，以及"公式待更新"（都该是 false）
 */
interface ServerExpectation {
  readonly revision: number | { readonly atLeast: number }
  readonly why: string
  readonly cells: readonly ExpectedCell[]
  readonly absent?: readonly ExpectedCell[]
  readonly content?: (snapshot: string) => string[]
}

/**
 * 交接的复核（M3-P5）在服务器上该有的样子，随走的路而定（path 是 B 的 answered、silent，refresh-save 的 committed、expired）：
 * - takeover-holder 与 takeover-holder-deaf（A 的文档）：A 回应了（answered）——第一格、隐藏时上传的第二格、交出之前存上的第三格，修订号 4；
 *   没有回应（silent）——前两格，修订号 3，第三格不在（只在 A 另存的副本里）；
 * - takeover-taker：与 A 同一份文档，随 A 那一步核对（这里没有要求）；
 * - refresh-save：刷新时停在服务端的那一次保存提交了，修订号 2、内容里有那一格（committed）；等满 30 秒（expired）说明那次保存没有提交，算问题。
 * 认不出路的交回 undefined（算问题：不知道该是什么样子）
 */
function handoverExpectation(scenario: HandoverScenario, path: string | undefined): ServerExpectation | 'none' | undefined {
  switch (scenario) {
    case 'takeover-holder':
    case 'takeover-holder-deaf':
      if (path === 'answered')
        return { revision: 4, why: 'A 回应了：控制的 flush、隐藏的那一刻、交出之前各上传一次', cells: TAKEOVER_EDITS }
      if (path === 'silent')
        return { revision: 3, why: 'A 没有回应：控制的 flush、隐藏的那一刻各上传一次，第三格没有存上', cells: TAKEOVER_EDITS.slice(0, 2), absent: TAKEOVER_EDITS.slice(2) }
      return undefined
    case 'takeover-taker':
      return 'none'
    case 'refresh-save':
      return path === 'committed' ? { revision: 2, why: '刷新时停在服务端的那一次保存提交了', cells: [REFRESH_SAVE_EDIT] } : undefined
  }
}

/**
 * 请求编辑的两条路（M3-P6）在服务器上该有的样子，随走的路：
 * - request-waiter（entered-on-return）：另一方（经接口）没有保存过，这一页回到前台、进入编辑之后存上那一格——修订号 2、内容里有它；
 * - paused-holder：被暂停了（lost-after-pause）——第一格（控制的 flush）、隐藏的那一刻上传的第二格，修订号 3，第三格不在（编辑权到期，只在副本里）；
 *   没被暂停（handed-over）——空闲满 2 分钟先保存再交出，三格都在，修订号 4。
 * 走了别的路时交回 undefined（算问题：页面已经说明哪里不对）
 */
function requestExpectation(scenario: RequestScenario, path: string | undefined): ServerExpectation | undefined {
  switch (scenario) {
    case 'request-waiter':
      return path === 'entered-on-return' ? { revision: 2, why: '回到前台、进入编辑之后存上一格（另一方没有保存过）', cells: [REQUEST_WAITER_EDIT] } : undefined
    case 'paused-holder':
      if (path === 'lost-after-pause')
        return { revision: 3, why: '控制的 flush、盖屏（隐藏）的那一刻各上传一次，第三格没有存上', cells: PAUSED_HOLDER_EDITS.slice(0, 2), absent: PAUSED_HOLDER_EDITS.slice(2) }
      if (path === 'handed-over')
        return { revision: 4, why: '控制的 flush、盖屏（隐藏）的那一刻、自动交出之前各上传一次', cells: PAUSED_HOLDER_EDITS }
      return undefined
  }
}

/**
 * 真实浏览器的前置复核（M4-P1 S1）在服务器上该有的样子：只看不改的（存储、密钥、停顿、捕获成本：捕获只读内存里的快照）还是修订号 1；
 * 首屏与公式冻结改了数据表的几格、暂停定时的上传——交回结果整页跳走时页面隐藏，自动保存在那一刻上传（发得出去、提交了才多一个修订），所以至少 1
 */
function probeExpectation(scenario: ProbeScenario): ServerExpectation {
  switch (scenario) {
    case 'perf-baseline':
      return { revision: { atLeast: 1 }, why: '改了数据表的几格、暂停定时的上传；整页跳走交回结果时页面隐藏，自动保存可能在那一刻上传', cells: [] }
    case 'storage':
    case 'key-transfer':
    case 'storage-quota':
    case 'worker-stall':
    case 'capture-cost':
      return { revision: 1, why: '没有保存过', cells: [] }
  }
}

function serverExpectation(scenario: SelftestScenario, path: string | undefined): ServerExpectation | 'none' | undefined {
  if (isProbeScenario(scenario))
    return probeExpectation(scenario)
  switch (scenario) {
    case 'takeover-holder':
    case 'takeover-holder-deaf':
    case 'takeover-taker':
    case 'refresh-save':
      return handoverExpectation(scenario, path)
    case 'request-waiter':
    case 'paused-holder':
      return requestExpectation(scenario, path)
    case 'enter-exit':
      return { revision: 2, why: '退出编辑时保存了一次', cells: [ENTER_EXIT_EDIT] }
    case 'formula-timing':
      return { revision: { atLeast: 2 }, why: '自动保存在各项修改之后上传', cells: [], content: formulaProblems }
    case 'auto-height':
      return { revision: { atLeast: 2 }, why: '自动保存上传了改过字号与行高的大表', cells: [], content: autoHeightProblems }
    case 'large-copy':
      return { revision: { atLeast: 2 }, why: '自动保存上传了复制之后的大表', cells: [], content: largeCopyProblems }
    case 'composition':
      return { revision: { atLeast: 2 }, why: '自动保存在组合结束之后上传', cells: [], content: compositionProblems }
    case 'hidden-save':
      return { revision: 3, why: '第一格经控制立即上传一次、隐藏的那一刻自动保存又上传一次', cells: HIDDEN_SAVE_EDITS }
    case 'read-only':
    case 'read-only-formulas':
    case 'edit-chrome':
    case 'environment':
    case 'change-detection':
      // 只看不改的几步；change-detection 暂停了定时的上传，它的内容带着只读样本单元格里的 data: 图片——交回结果时切到后台的上传被服务端拒收
      return { revision: 1, why: '没有保存过', cells: [] }
  }
}

/**
 * 一步在服务器上该有的样子（空数组就是对的，纯函数）：只看不改的几步与 change-detection（暂停定时的上传；内容带着样本的 data: 图片，
 * 服务端拒收）文档还是修订号 1；enter-exit 恰好保存了一次（修订号 2），内容里有它改的那一格（ENTER_EXIT_EDIT）；自动保存照常运行的几步（formula-timing、auto-height、
 * large-copy、composition）至少保存了一次，存下的内容另核对（全部公式按定义、大表每一行的字号与自动行高、复制品的格数、批注的文字）；
 * hidden-save 恰好两次（修订号 3），内容里有它写的两格（HIDDEN_SAVE_EDITS）；交接的几步随走的路（path，handoverExpectation）。
 * 修订记录的条数都与修订号相同，"公式待更新"都不在
 */
export function storedProblems(step: Pick<SelftestStep, 'scenario' | 'documentId'>, stored: StoredDocument | undefined, path?: string): string[] {
  const expected = serverExpectation(step.scenario, path)
  if (expected === 'none')
    return []
  if (stored === undefined)
    return [`服务器上没有文档 ${step.documentId}`]
  if (expected === undefined)
    return [`文档 ${step.documentId}：不知道走了哪条路（${path ?? '没有交回'}），说不出服务器上该是什么样子（修订号 ${stored.revision}）`]
  const problems: string[] = []
  const revisionOk = typeof expected.revision === 'number' ? stored.revision === expected.revision : stored.revision >= expected.revision.atLeast
  if (!revisionOk || stored.revisions !== stored.revision) {
    const wanted = typeof expected.revision === 'number' ? `应当都是 ${expected.revision}` : `应当至少 ${expected.revision.atLeast}、两者相同`
    problems.push(`文档 ${step.documentId} 的修订号是 ${stored.revision}、修订记录 ${stored.revisions} 条（${wanted}：${expected.why}）`)
  }
  for (const cell of expected.cells) {
    const value = cellValueOf(stored.snapshot, cell.sheetId, cell.row, cell.column)
    if (value !== cell.value)
      problems.push(`服务器上 ${cell.cell} 是 ${JSON.stringify(value) ?? '空'}（应当是 ${JSON.stringify(cell.value)}）`)
  }
  for (const cell of expected.absent ?? []) {
    const value = cellValueOf(stored.snapshot, cell.sheetId, cell.row, cell.column)
    if (value !== undefined)
      problems.push(`服务器上 ${cell.cell} 是 ${JSON.stringify(value)}（应当是空的）`)
  }
  problems.push(...(expected.content?.(stored.snapshot) ?? []).map(problem => `服务器上存下的内容：${problem}`))
  if (stored.formulasPending)
    problems.push('服务器上的文档是"公式待更新"')
  return problems
}

/** 服务器上这一步的文档的修订号与问题（storedProblems 的口径；交接的几步带上走的路） */
export async function serverProblemsOf(step: SelftestStep, path?: string): Promise<{ readonly revision: number | undefined, readonly problems: string[] }> {
  const stored = await storedDocument(step.documentId)
  return { revision: stored?.revision, problems: storedProblems(step, stored, path) }
}

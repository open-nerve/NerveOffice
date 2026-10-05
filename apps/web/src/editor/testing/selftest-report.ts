// 页面自检的结果（M3-P2 设计 §3.5）：编辑器页的自检（./selftest.ts）写出，驱动脚本（tests/e2e/safari/selftest.ts）
// 与 E2E（tests/e2e/specs/editor/selftest.spec.ts）读回。
// 结果怎么带出页面：页面的 CSP 只许同源连接（connect-src 'self'），E2E 的后端是生产的后端、没有收集结果的接口；顶层跳转不受 CSP 限制，
// 所以自检结束时整页跳到 next（驱动脚本起的收集端），结果压缩之后放在查询参数 result 里（gzip、base64url），收集端解开。
// 这个文件不引用任何模块：浏览器与 Node（驱动脚本、E2E）都用它（CompressionStream、atob、btoa 两边都有），
// E2E 经模块边界的例外引用它（eslint.config.ts）。

/** 结果的格式标识：门禁 artifacts 也按它核对生产构建里没有自检（tools/src/gates/policy.ts 的禁用关键字） */
export const SELFTEST_REPORT_FORMAT = 'nerve-office.editor-selftest.v1'

/** 编辑器页的地址带它时跑自检（值是场景） */
export const SELFTEST_PARAM = 'selftest'

/** 自检结束之后整页跳到的地址（驱动脚本起的收集端）：结果加在它的查询参数 RESULT_PARAM 上 */
export const NEXT_PARAM = 'next'

/** 收集端从这个查询参数读结果 */
export const RESULT_PARAM = 'result'

/**
 * 测试构建里选公式模式的地址参数（M3-P4 设计 §3.14，US-M3-03 的两种模式）：编辑器页的地址带 formula=main 时编辑器以主线程模式创建
 * （编辑器的开关 ./formula-mode.ts 读它），不带或者 formula=worker 时用公式 Worker。页面自检的入口页按步骤带上它（selftestEditorUrl）；
 * E2E 打开编辑器页时同样可以带。生产构建里没有这个开关
 */
export const FORMULA_MODE_PARAM = 'formula'

/** 两种公式模式在地址里的写法（键与编辑器的 FormulaMode 相同） */
export const FORMULA_MODE_VALUES = { 'worker': 'worker', 'main-thread': 'main' } as const

/**
 * 打开编辑器页时暂停定时的自动保存（M3-P4 S7，审查 B1）：入口页登录之后、跳到编辑器页之前在 sessionStorage 里写下它（同一个标签页里跳转，
 * sessionStorage 跟着走），测试构建的自动保存控制（./autosave-control.ts 的 AUTOSAVE_HOLD_STORAGE_KEY、AUTOSAVE_HELD）据此打开即暂停——
 * 真实 Safari 与 Playwright 的夹具（默认暂停）从打开起是同一个状态。自检开始时还会再暂停一次、各场景按需要放开（selftest-autosave.ts），
 * 结果不依赖打开时的状态。这个文件不引用任何模块，在这里另写一份，单元测试核对两边一致
 */
export const SELFTEST_AUTOSAVE_HOLD = { key: 'nerve-office.autosave-hold', value: 'held' } as const

/** 公式在哪里计算（与编辑器的 FormulaMode 相同；这个文件不引用任何模块，在这里另写一份，单元测试核对两边一致） */
export type SelftestFormulaMode = keyof typeof FORMULA_MODE_VALUES

/**
 * 自检的场景：
 * - read-only：查看者打开只读样本，逐项试只读入口（Facade、撤销与重做、合成的快捷键、界面）；
 * - read-only-formulas：查看者打开去掉公式缓存值的样本，公式在 Worker 里算出结果、没有被防火墙取消；
 * - edit-chrome：能编辑的人打开同一份样本，界面检查的对照（工具栏、右键菜单、底栏在能编辑时都在，合成的右键与按键确实有效）；
 * - enter-exit：作者打开自己的一份样本（M3-P2 S5）：阅读 → 点页头的"编辑"→ 经 Facade 改一格（ENTER_EXIT_EDIT）→ 点"退出编辑"
 *   （先保存）→ 回到阅读之后再试 Facade 的只读入口、撤销与重做（撤销栈已清空）与界面；两次切换的耗时记进 timings；
 * - 捕获时机的复核（CAPTURE_SCENARIOS，M3-P4 S1，DEF-003 的其余部分；都在编辑时跑，见 ./selftest-capture.ts）
 */
export const CAPTURE_SCENARIOS = ['environment', 'change-detection', 'formula-timing', 'auto-height', 'large-copy', 'composition', 'hidden-save'] as const

export type CaptureScenario = (typeof CAPTURE_SCENARIOS)[number]

export const SELFTEST_SCENARIOS = ['read-only', 'read-only-formulas', 'edit-chrome', 'enter-exit', ...CAPTURE_SCENARIOS] as const

export type SelftestScenario = (typeof SELFTEST_SCENARIOS)[number]

export function isSelftestScenario(value: string): value is SelftestScenario {
  return (SELFTEST_SCENARIOS as readonly string[]).includes(value)
}

/**
 * enter-exit 在编辑时改的那一格（"数据"表 K45，从 0 开始是第 44 行、第 10 列；只读入口的清单不碰它）与写进去的值：
 * 驱动脚本与 E2E 核对服务器上的那份文档恰好多了一个修订、内容里有它
 */
export const ENTER_EXIT_EDIT = { sheetName: '数据', sheetId: 'sheet-1', cell: 'K45', row: 44, column: 10, value: '进入、退出编辑的自检' } as const

/**
 * hidden-save（M3-P4 S1；S7 起由自动保存上传）在编辑时写的两格（模板的第一张表 sheet-1）：写第一格，经测试构建的控制立即上传它，
 * 上传的同时写第二格——第二格留着没捕获、没上传（定时的上传暂停、捕获的静默与上限调到一小时），页面变成隐藏的那一刻由自动保存自己捕获、上传。
 * 驱动脚本与 E2E 核对服务器上的那份文档：第一次上传之后修订号 2；隐藏之后修订号 3、内容里有两格
 */
export const HIDDEN_SAVE_EDITS = [
  { sheetId: 'sheet-1', cell: 'A1', row: 0, column: 0, value: '隐藏之前保存的' },
  { sheetId: 'sheet-1', cell: 'A2', row: 1, column: 0, value: '隐藏的那一刻保存的' },
] as const

/**
 * composition（M3-P4 S1）组字写进的批注：模板的第一张表 sheet-1 的 B2，选定的文字。S7 起驱动脚本与 E2E 另核对服务器上的那份文档里
 * 有它（自动保存在组合结束之后存下）
 */
export const COMPOSITION_NOTE = { sheetId: 'sheet-1', cell: 'B2', row: 1, column: 1, text: '你好' } as const

/** 一项计时（例如 switch.enter：一次切换的各段耗时，毫秒；缺的是 null）。各段的含义见 ./switch-timing.ts 的 switchDurations */
export interface SelftestTiming {
  readonly id: string
  readonly ms: Readonly<Record<string, number | null>>
}

/** 一项检查的结果 */
export interface SelftestCheck {
  /** 稳定的标识（例如 facade.筛选、shortcut.undo）：驱动脚本与报告按它对照不同浏览器的结果 */
  readonly id: string
  readonly pass: boolean
  /** 看到了什么（等到的信号、提示的说法、出错的原因），给人看 */
  readonly detail: string
  /** 用了多少毫秒 */
  readonly ms: number
}

/** 自检开始时页面的状态 */
export interface SelftestPage {
  /** ready：就绪到 steady；failed：载入失败（detail 说明）；timeout：等不到就绪；hidden：页面在后台，浏览器暂停了它（自检做不了） */
  readonly state: 'ready' | 'failed' | 'timeout' | 'hidden'
  /** 按只读打开（就绪时才有） */
  readonly readOnly?: boolean | undefined
  readonly detail?: string | undefined
}

export interface SelftestReport {
  readonly format: typeof SELFTEST_REPORT_FORMAT
  readonly scenario: string
  readonly documentId: string
  readonly userAgent: string
  /** 编辑器页开始载入、自检结束的时刻（ISO 8601） */
  readonly startedAt: string
  readonly finishedAt: string
  readonly page: SelftestPage
  /** 页面的可见性：开始时的，以及之间的每次变化（"时刻 状态"）。页面隐藏时浏览器暂停动画帧，Univer 画不出来 */
  readonly visibility: readonly string[]
  readonly checks: readonly SelftestCheck[]
  /** 没接住的异常与没处理的拒绝（"名称: 说明"） */
  readonly pageErrors: readonly string[]
  /** 页面里 console.error 的调用 */
  readonly consoleErrors: readonly string[]
  /** 浏览器的通知（ResizeObserver 没送达的通知，与 E2E 的 support/page-errors.ts 同一个判断），不算错误 */
  readonly ignoredNotices: readonly string[]
  /** read-only-formulas：打开之后公式算出的值（"工作表 id!A1" → 值），驱动脚本与 E2E 对照样本 */
  readonly formulaValues?: Readonly<Record<string, unknown>> | undefined
  /** enter-exit：每次切换的各段耗时 */
  readonly timings?: readonly SelftestTiming[] | undefined
  /** 自检本身没能跑完的原因（编辑器没就绪、自检抛错）；跑完时没有 */
  readonly failure?: string | undefined
}

/** 自检通过：页面就绪、每项检查都通过、没有页面错误与 console.error */
export function selftestPassed(report: SelftestReport): boolean {
  return report.failure === undefined && report.page.state === 'ready' && report.checks.length > 0
    && report.checks.every(check => check.pass) && report.pageErrors.length === 0 && report.consoleErrors.length === 0
}

// ---- 编码：gzip 之后 base64url（地址里不用再转义）----

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]*$/.test(text))
    throw new SelftestReportError('结果不是 base64url')
  const padded = text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer())
}

export class SelftestReportError extends Error {
  override readonly name = 'SelftestReportError'
}

/** 结果写成查询参数的值 */
export async function encodeSelftestReport(report: SelftestReport): Promise<string> {
  return toBase64Url(await transform(new TextEncoder().encode(JSON.stringify(report)), new CompressionStream('gzip')))
}

/** 收集端解开查询参数里的结果；不是这个格式时抛出 SelftestReportError */
export async function decodeSelftestReport(encoded: string): Promise<SelftestReport> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await transform(fromBase64Url(encoded), new DecompressionStream('gzip')))
  }
  catch (error) {
    throw error instanceof SelftestReportError ? error : new SelftestReportError('结果解不开（不是 gzip 压缩的 UTF-8 文本）', { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch (error) {
    throw new SelftestReportError('结果不是 JSON', { cause: error })
  }
  return parseSelftestReport(value)
}

/** next 可以用的主机：本机（M3-P2 复核 B7） */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])

/**
 * next（自检的结果交给谁）只能是本机的源（M3-P2 复核 B7）：http、主机是 127.0.0.1 或 localhost，端口不限，地址里不带账户。
 * 驱动脚本起的收集端与 E2E 拦下的地址都在本机；结果里有文档 id、检查的结果、页面错误与公式算出的值，测试构建的页面不能被一个
 * 带着任意 next 的地址把它们整页带到别处。合格时返回 undefined，否则返回原因：入口页与编辑器页把它写在页面上，不登录、不跑、不跳转
 */
export function nextProblem(next: string): string | undefined {
  let url: URL
  try {
    url = new URL(next)
  }
  catch {
    return 'next 不是一个完整的地址'
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '')
    return `next 只能是本机的地址（http://127.0.0.1:<端口> 或 http://localhost:<端口>），这里是 ${url.origin === 'null' ? url.protocol : url.origin}`
  return undefined
}

/** 自检结束之后跳去的地址：next 加上结果。next 不是本机的地址时抛出 SelftestReportError（调用方先用 nextProblem 核对，原因写在页面上） */
export function reportUrl(next: string, encoded: string): string {
  const problem = nextProblem(next)
  if (problem !== undefined)
    throw new SelftestReportError(problem)
  const url = new URL(next)
  url.searchParams.set(RESULT_PARAM, encoded)
  return url.href
}

/**
 * 入口页登录之后整页跳去的编辑器页：/documents/<文档 id>?selftest=<场景>&next=<…>，给了公式模式时另带 formula=<…>。
 * 路径与 contracts 的 documentPagePath 相同（单元测试对照）：入口页不引用 contracts 与平台页面、编辑器页共用的任何模块
 * （M3-P2 复核 B4），所以在这里就地写
 */
export function selftestEditorUrl(origin: string, documentId: string, scenario: string, next: string, formula?: SelftestFormulaMode): string {
  const url = new URL(`/documents/${encodeURIComponent(documentId)}`, origin)
  url.searchParams.set(SELFTEST_PARAM, scenario)
  url.searchParams.set(NEXT_PARAM, next)
  if (formula !== undefined)
    url.searchParams.set(FORMULA_MODE_PARAM, FORMULA_MODE_VALUES[formula])
  return url.href
}

/** 地址里的公式模式（入口页从 # 片段读）：认识的写法交回模式，没有时是 undefined，不认识时是 null（入口页按登录失败一样交回原因） */
export function formulaModeOfValue(value: string | null): SelftestFormulaMode | undefined | null {
  if (value === null)
    return undefined
  const found = (Object.keys(FORMULA_MODE_VALUES) as SelftestFormulaMode[]).find(mode => FORMULA_MODE_VALUES[mode] === value)
  return found ?? null
}

// ---- 读回时的校验：字段与类型都对才算这个格式（收集端收到的是地址里的任意文字）----

type Json = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isCheck(value: unknown): value is SelftestCheck {
  return isObject(value) && typeof value.id === 'string' && typeof value.pass === 'boolean' && typeof value.detail === 'string' && typeof value.ms === 'number'
}

function isTiming(value: unknown): value is SelftestTiming {
  return isObject(value) && typeof value.id === 'string' && isObject(value.ms)
    && Object.values(value.ms).every(item => item === null || (typeof item === 'number' && Number.isFinite(item)))
}

function isPage(value: unknown): value is SelftestPage {
  return isObject(value) && (value.state === 'ready' || value.state === 'failed' || value.state === 'timeout' || value.state === 'hidden')
    && (value.readOnly === undefined || typeof value.readOnly === 'boolean')
    && (value.detail === undefined || typeof value.detail === 'string')
}

const REQUIRED_STRINGS = ['scenario', 'documentId', 'userAgent', 'startedAt', 'finishedAt'] as const
const REQUIRED_STRING_ARRAYS = ['visibility', 'pageErrors', 'consoleErrors', 'ignoredNotices'] as const

/** 按格式校验读回的值；不对时抛出 SelftestReportError，说明哪一项不对 */
export function parseSelftestReport(value: unknown): SelftestReport {
  if (!isObject(value) || value.format !== SELFTEST_REPORT_FORMAT)
    throw new SelftestReportError(`不是 ${SELFTEST_REPORT_FORMAT} 的结果`)
  for (const key of REQUIRED_STRINGS) {
    if (typeof value[key] !== 'string')
      throw new SelftestReportError(`结果的 ${key} 不是字符串`)
  }
  for (const key of REQUIRED_STRING_ARRAYS) {
    if (!isStringArray(value[key]))
      throw new SelftestReportError(`结果的 ${key} 不是字符串的数组`)
  }
  if (!isPage(value.page))
    throw new SelftestReportError('结果的 page 不对')
  if (!Array.isArray(value.checks) || !value.checks.every(isCheck))
    throw new SelftestReportError('结果的 checks 不对')
  if (value.formulaValues !== undefined && !isObject(value.formulaValues))
    throw new SelftestReportError('结果的 formulaValues 不对')
  if (value.timings !== undefined && (!Array.isArray(value.timings) || !value.timings.every(isTiming)))
    throw new SelftestReportError('结果的 timings 不对')
  if (value.failure !== undefined && typeof value.failure !== 'string')
    throw new SelftestReportError('结果的 failure 不是字符串')
  return value as unknown as SelftestReport
}

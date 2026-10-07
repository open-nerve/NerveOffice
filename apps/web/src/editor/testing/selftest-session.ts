// 页面自检的一次运行（M3-P2 设计 §3.5；M3-P4 S1 从 ./selftest.ts 拆出来，两组场景共用）：编辑器页交给自检的（host）、一项检查怎么记、
// 命令日志的几个查询、内容的差别与页头的按钮。场景在 ./selftest.ts（只读与进入、退出编辑）与 ./selftest-capture.ts（捕获时机的复核）。
// 只在测试构建里（editor/testing/，随自检的分块动态引入）
import type { EditorProbe, ProbeCommand } from './e2e-probe.ts'
import type { EntryApi, EntryRange, EntrySheet, EntryWorkbook } from './read-only-entries.ts'
import type { SelftestCheck, SelftestPage, SelftestTimelineEntry, SelftestTiming } from './selftest-report.ts'
import { canonicalJson, contentOf } from './content-compare.ts'
import { byRole, isVisible, waitFor } from './selftest-dom.ts'

/**
 * 编辑器页现在的样子：阅读还是编辑（edit-mode.ts 的状态，例如 reading、entering、editing、exiting）、编辑器容器的状态（loading、ready、
 * steady、failed）与编辑时的保存状态（save-coordinator.ts 的 status，例如 clean、dirty、saving；不在编辑时没有）
 */
export interface SelftestPageView {
  readonly mode: string | undefined
  readonly surface: string
  readonly save?: string | undefined
  /**
   * 交接的复核（M3-P5，./selftest-handover.ts）用到的：阅读时"在此编辑"的进展（preparing、asking、waiting-save、failed）、持有者是自己时
   * 那个页面在哪里（this-browser、elsewhere）、上一次操作留下的说明（例如 handed-over-tab）；没有时 undefined
   */
  readonly takeover?: string | undefined
  readonly selfHolder?: string | undefined
  readonly notice?: string | undefined
  /**
   * 失去编辑权时（losing、lost）：原因（种类，被接管的另带在哪里，例如 taken-over:this-browser）、本页有没有服务端没确认的内容、
   * 另存为副本的进展（idle、saving、failed、refused、done）与建好的副本
   */
  readonly loss?: string | undefined
  readonly unsaved?: boolean | undefined
  readonly copy?: string | undefined
  readonly copyDocumentId?: string | undefined
}

/** 编辑器页交给自检的（挂接在页面开始载入时就收集页面错误与可见性，到 steady 之后才引入自检） */
export interface SelftestHost {
  readonly documentId: string
  readonly surface: HTMLElement
  readonly chrome: HTMLElement
  /** 编辑器页开始载入的时刻（ISO 8601） */
  readonly startedAt: string
  readonly page: SelftestPage
  /** 编辑器页现在的样子：场景里点了"编辑""退出编辑""保存"之后按它等 */
  readonly view: () => SelftestPageView
  readonly visibility: () => readonly string[]
  /** 自检要整页跳走交回结果了：之后编辑器页的离开提示不拦（编辑时改过内容的场景留着没保存的修改） */
  readonly allowLeave: () => void
  readonly pageErrors: () => readonly string[]
  readonly consoleErrors: () => readonly string[]
  readonly ignoredNotices: () => readonly string[]
}

/**
 * 等一个信号（命令被取消、被拦下、执行完，提示出现或关掉）最多等多久：Playwright 的三个浏览器里这些信号都在 250 毫秒以内到达，
 * 留出二十倍的余量（与 E2E 的 expect.poll 同一个量级）
 */
export const SIGNAL_TIMEOUT_MS = 5_000

/** 一项检查最多用多久：超时记为不通过（它的后续可能还在进行，下一项照常开始）。一项里最多等两三个信号 */
export const CHECK_TIMEOUT_MS = 15_000

/**
 * 一个场景的检查一共最多用多久：超过之后余下的检查不再做、记为不通过，结果照样交回（真实 Safari 里一项接一项地超时，
 * 也要在驱动脚本的时限之内交回结果，看得到卡在哪里）。Playwright 的三个浏览器里一个场景十几秒到三十秒（捕获时机的几个场景）
 */
export const SCENARIO_BUDGET_MS = 180_000

/** 每项的说明最多留多长：结果放在地址里 */
const DETAIL_LIMIT = 600

// ---- Facade：入口清单的声明之外，自检另外用到的几样（sheets 与 sheets-ui 的 Facade 都有） ----

export interface CellRect {
  readonly startX: number
  readonly startY: number
  readonly endX: number
  readonly endY: number
}

export interface SelftestRange extends EntryRange {
  /** 单元格在画布上的范围（相对画布的左上角，含行列表头；sheets-ui 的 Facade） */
  readonly getCell: () => CellRect
  readonly getA1Notation: () => string
  /** 写入一个值（sheet.command.set-range-values） */
  readonly setValue: (value: string | number) => unknown
}

export interface SelftestSheet extends EntrySheet {
  readonly getRange: (a1: string) => SelftestRange
}

export interface SelftestWorkbook extends EntryWorkbook {
  readonly getActiveSheet: () => SelftestSheet
  readonly getSheetByName: (name: string) => SelftestSheet
  /** 选区的主单元格；没有选区时是 null */
  readonly getActiveCell: () => SelftestRange | null
}

export interface SelftestApi extends EntryApi {
  readonly getActiveWorkbook: () => SelftestWorkbook
  readonly undo: () => Promise<boolean>
  readonly redo: () => Promise<boolean>
}

/** 检查不通过：detail 说明看到了什么 */
export class CheckFailure extends Error {
  override readonly name = 'CheckFailure'
}

export function fail(detail: string): never {
  throw new CheckFailure(detail)
}

export function describe(error: unknown): string {
  if (error instanceof CheckFailure)
    return error.message
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function truncate(text: string, limit = DETAIL_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CheckFailure(`${timeoutMs / 1000} 秒内没有做完`)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

/** 一次自检：探针、Facade、打开时的快照与记下的检查结果 */
export interface Session {
  readonly host: SelftestHost
  /** 当前的编辑器（探针与它的 Facade）：enter-exit 每次切换之后换上新的那一个（adoptEditor） */
  probe: EditorProbe
  api: SelftestApi
  unitId: string
  /** 比较的基准：打开时（自检开始时）的内存快照；enter-exit 退出编辑之后换成那时的 */
  opened: string
  readonly checks: SelftestCheck[]
  /** 计时（enter-exit 的切换；捕获时机的场景里每次捕获的时间线） */
  readonly timings: SelftestTiming[]
  /** 场景的检查最晚做到什么时候（performance.now()）：之后的检查不再做 */
  readonly deadline: number
  /** 页面被隐藏的时刻（自检开始之后第一次）：之后的检查不再做 */
  hiddenAt?: string
  formulaValues?: Record<string, unknown>
  /** 交接的场景走了哪条路与时间线（M3-P5，selftest-report.ts 的 path、timeline） */
  path?: string
  timeline?: SelftestTimelineEntry[]
}

export async function check(session: Session, id: string, run: () => Promise<string>, timeoutMs = CHECK_TIMEOUT_MS): Promise<boolean> {
  const started = performance.now()
  if (started > session.deadline) {
    session.checks.push({ id, pass: false, detail: `没有做：这个场景的检查超过了总时限（${SCENARIO_BUDGET_MS / 1000} 秒）`, ms: 0 })
    return false
  }
  if (session.hiddenAt !== undefined) {
    session.checks.push({ id, pass: false, detail: `没有做：页面在 ${session.hiddenAt} 被隐藏（浏览器暂停隐藏页面的动画帧与计时器），之后的结果不可信，让浏览器的窗口露出来再跑`, ms: 0 })
    return false
  }
  let pass = true
  let detail: string
  try {
    detail = await withTimeout(run(), timeoutMs)
  }
  catch (error) {
    pass = false
    detail = describe(error)
  }
  session.checks.push({ id, pass, detail: truncate(detail), ms: Math.round(performance.now() - started) })
  return pass
}

// ---- 命令日志 ----

export function lastSeq(probe: EditorProbe): number {
  return probe.commands().at(-1)?.seq ?? 0
}

export function describeCommand(command: ProbeCommand): string {
  const phase = command.phase === 'executed' ? '执行' : command.canceled ? '取消' : '尝试'
  return `${phase} ${command.id}`
}

/** mark 之后的命令（给不通过时的说明：最多 12 条） */
export function seenSince(probe: EditorProbe, mark: number): string {
  const commands = probe.commands(mark)
  return commands.length === 0 ? '之后没有命令' : `之后的命令：${commands.slice(0, 12).map(describeCommand).join('、')}${commands.length > 12 ? '…' : ''}`
}

export function has(probe: EditorProbe, mark: number, phase: ProbeCommand['phase'], id: string, canceled?: boolean): boolean {
  return probe.commands(mark).some(command => command.phase === phase && command.id === id && (canceled === undefined || command.canceled === canceled))
}

// ---- 服务器上的文档（同源的接口：页面的 CSP 只许同源连接） ----

/** 服务器上这份文档的内容（快照的原文：服务端原样存下上传的 gzip 字节，读回来就是上传的那一份） */
export async function fetchServerContent(documentId: string): Promise<string> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/content`, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok)
    fail(`读服务器上的内容：${response.status}`)
  return response.text()
}

/** 服务器上这份文档的修订号与"公式待更新"（GET /api/documents/<id> 的元数据里的两项） */
export async function fetchServerDocument(documentId: string): Promise<{ readonly revision: number, readonly formulasPending: boolean }> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!response.ok)
    fail(`读服务器上的文档：${response.status}`)
  const detail = await response.json() as { readonly revision?: unknown, readonly formulasPending?: unknown }
  if (typeof detail.revision !== 'number' || typeof detail.formulasPending !== 'boolean')
    fail('服务器上的文档没有修订号或"公式待更新"')
  return { revision: detail.revision, formulasPending: detail.formulasPending }
}

// ---- 内容与页头 ----

/** 内容与 baseline 不同的部分（给不通过时的说明）：顶层的键，工作表按 id */
export function differences(baseline: string, current: string): string {
  const before = contentOf(baseline) as Record<string, unknown>
  const after = contentOf(current) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const changed = keys.filter(key => canonicalJson(before[key]) !== canonicalJson(after[key]))
  const sheetsBefore = (before.sheets ?? {}) as Record<string, unknown>
  const sheetsAfter = (after.sheets ?? {}) as Record<string, unknown>
  const sheets = [...new Set([...Object.keys(sheetsBefore), ...Object.keys(sheetsAfter)])]
    .filter(id => canonicalJson(sheetsBefore[id]) !== canonicalJson(sheetsAfter[id]))
  return `${changed.join('、')}${sheets.length > 0 ? `（工作表 ${sheets.join('、')}）` : ''}`
}

/** 页头里看得见的、名称恰好是 name 的按钮 */
export function chromeButton(session: Session, name: string): HTMLElement | undefined {
  return byRole('button', { name, root: session.host.chrome }).find(isVisible)
}

export function describeView(session: Session): string {
  const view = session.host.view()
  return `页面 ${view.mode ?? '没有状态'}，编辑器 ${view.surface}，容器上是 ${session.host.surface.getAttribute('data-editor-access') ?? '没有编辑器'}`
}

// ---- 进入、退出编辑（M3-P2 S5；M3-P4 S1 的公式时序也用）----

/** 一次切换最多等多久：申请编辑权或保存、释放，重建，再到 steady（渲染完成之后 3 秒）。Playwright 的三个浏览器里 4 秒上下 */
export const SWITCH_TIMEOUT_MS = 60_000

/**
 * 点了"编辑""退出编辑"之后等页面到 target（editing 或 reading）的 steady，而且容器上是那一种编辑器（edit、read）。
 * 先等切换开始（页面进入过程中的状态 passing：entering、exiting；页头的处理是异步的，退出编辑先确认会话，点下去的那一刻还没开始）；
 * 之后离开了过程中的状态却没有到 target 时不再等：进入没有成功、退出时保存失败、失去编辑权
 */
export async function untilSwitched(session: Session, target: 'editing' | 'reading', passing: 'entering' | 'exiting'): Promise<void> {
  const access = target === 'editing' ? 'edit' : 'read'
  const mode = (): string | undefined => session.host.view().mode
  if (!await waitFor(() => mode() === passing || mode() === target, SIGNAL_TIMEOUT_MS))
    fail(`点了之后没有开始切换（${describeView(session)}）`)
  const settled = (): boolean => {
    const view = session.host.view()
    if (view.mode === target)
      return view.surface === 'steady' && session.host.surface.getAttribute('data-editor-access') === access
    return view.mode !== passing
  }
  if (!await waitFor(settled, SWITCH_TIMEOUT_MS, 50))
    fail(`${SWITCH_TIMEOUT_MS / 1000} 秒内没有到 steady（${describeView(session)}）`)
  if (mode() !== target)
    fail(`没有到${target === 'editing' ? '编辑' : '阅读'}（${describeView(session)}）`)
}

/** 切换之后换上新的编辑器：探针随编辑器重建（旧的销毁时撤掉，新的就绪时装上） */
export function adoptEditor(session: Session, previous: EditorProbe): void {
  const probe = window.__nerveEditorProbe
  if (probe === undefined || probe === previous)
    fail('页面里没有换上新的编辑器的探针')
  session.probe = probe
  session.api = probe.univerAPI as unknown as SelftestApi
  session.unitId = session.api.getActiveWorkbook().getId()
}

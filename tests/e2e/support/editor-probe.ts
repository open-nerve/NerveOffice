// 编辑器的探针（M2-P3 设计 §3.7；apps/web/src/editor/testing/e2e-probe.ts）：只在测试构建里，E2E 这边看不到 web 的类型，这里声明用到的部分。
// - 内存里的快照：画布上的内容读不出来，"改动被拦住"比较内存里的快照（比较的口径与页面自检共用，contentOf）；
// - 命令日志：每条命令执行前（带是否被取消）与执行后各一条。用例按"某条命令已经被尝试、已被取消或已执行完"等到这次操作处理完，
//   不用固定时长的等待（规范 §8.1）；
// - Facade：M0 的 Facade 入口经它逐项调用；单元格在画布上的位置也经它取（只读样本的列宽、隐藏的列与行高不是模板的默认值）。
//   入口用到的部分与测试构建的页面自检共用一份声明（editor/testing/read-only-entries.ts 的 Entry*），这里在它上面加 E2E 另外用到的。
// - 页面里打包的链接地址判定（M3-P3 S2）：跨引擎的同一组用例在三个浏览器里经它核对。
// - 公式在哪里计算（M3-P4 设计 §3.14）：测试构建经地址参数选主线程模式，用例据此核对开关确实生效；
// - 编辑器的变更检测与公式收齐（M3-P4 设计 §3.15，与保存、自动保存读的是同一个跟踪器）：自动保存的用例在停住的时间里等这一轮算完再往前拨，
//   上限到时的捕获才不会因为公式没收齐而带上标记（US-M3-02、03 的 E2E，S6）。
// 用到探针的用例打上 @test-build：外部模式测生产镜像，里面没有探针，按标签排除（playwright.config.ts）
import type { CanonicalLink, OpenCheckFailure } from '@nerve-office/contracts'
import type { Locator, Page } from '@playwright/test'
import type { LoggedCommand } from '../../../apps/web/src/editor/testing/content-compare.ts'
import type { EntryApi, EntryImage, EntryRange, EntryScope, EntrySheet, EntryWorkbook } from '../../../apps/web/src/editor/testing/read-only-entries.ts'
import type { SelftestFormulaMode } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { Workbook } from './sheet.ts'
import { expect } from './fixtures.ts'
import { cellOf, sheetCanvas } from './sheet.ts'

export { contentOf } from '../../../apps/web/src/editor/testing/content-compare.ts'

/** 命令日志里的一条（与 e2e-probe.ts 的 ProbeCommand 相同；判断改动用到的字段与页面自检共用一份声明） */
export interface ProbeCommand extends LoggedCommand {
  /** 从 1 开始的序号，按发生的顺序 */
  readonly seq: number
  /** 记下的时刻（页面里的 performance.now()） */
  readonly at: number
}

/** 单元格在画布上的范围（FRange.getCell，相对画布的左上角，含行列表头） */
interface CellRect {
  readonly startX: number
  readonly startY: number
  readonly endX: number
  readonly endY: number
}

// Facade 里 M0 入口用到的部分（各插件的 Facade 由探针补上，apps/web/src/editor/testing/probe-facades.ts）。
// 返回值 E2E 不用，写成 unknown；入口在页面里执行，这些类型只用来在编写时检查调用的写法

export interface FacadeRange extends EntryRange {
  readonly getCell: () => CellRect
  /** 写一格的值（SetRangeValuesCommand，同步执行） */
  readonly setValue: (value: string | number) => unknown
  /** 单元格的自定义数据（Univer 的 cell.custom） */
  readonly setCustomMetaData: (data: unknown) => unknown
  /** A1 写法（单个单元格时就是它的地址） */
  readonly getA1Notation: () => string
  /** 设为当前选区（选区的操作，只读时照常） */
  readonly activate: () => unknown
}

export type FacadeImage = EntryImage

/** 工作表的选区（sheets 的 Facade 的 FSelection） */
export interface FacadeSelection {
  /** 选区里的活动区域（整行选中时 A1 写法是 "20:20"，整列是 "K:K"） */
  readonly getActiveRange: () => FacadeRange | null
  /** 选区的主单元格：编辑栏显示的就是它（从 0 开始的行号与列号） */
  readonly getCurrentCell: () => { readonly actualRow: number, readonly actualColumn: number } | null
}

export interface FacadeSheet extends EntrySheet {
  readonly getRange: (a1: string) => FacadeRange
  readonly getSheetName: () => string
  /** 当前的选区；没有时是 null */
  readonly getSelection: () => FacadeSelection | null
  /** 缩放比例（sheets-ui 的 Facade） */
  readonly getZoom: () => number
  readonly zoom: (ratio: number) => unknown
  /** 滚到这一格在左上角（从 0 开始的行号与列号；sheets-ui 的 Facade） */
  readonly scrollToCell: (row: number, column: number) => unknown
  /** 滚动的位置：左上角是第几行、第几列 */
  readonly getScrollState: () => { readonly sheetViewStartRow: number, readonly sheetViewStartColumn: number }
  /** 选中的图片 */
  readonly getActiveImages: () => readonly FacadeImage[]
}

export interface FacadeWorkbook extends EntryWorkbook {
  readonly getActiveSheet: () => FacadeSheet
  /** 当前单元格（选区的主单元格）；没有选区时是 null */
  readonly getActiveCell: () => FacadeRange | null
  /** 找不到时是 null：入口里按样本的名称取，取不到就让调用抛错（接住后用例失败） */
  readonly getSheetByName: (name: string) => FacadeSheet
}

export interface FacadeApi extends EntryApi {
  readonly getActiveWorkbook: () => FacadeWorkbook
}

/** SDK 注册的一个快捷键（与 e2e-probe.ts 的 ProbeShortcut 相同）：各平台的绑定，按页面的平台取其一（support/keyboard.ts） */
export interface ProbeShortcut {
  /** 按下时执行的命令 */
  readonly id: string
  readonly binding?: number | undefined
  readonly mac?: number | undefined
  readonly win?: number | undefined
  readonly linux?: number | undefined
  readonly priority: number
  /** 有没有前提条件：有的话只在满足时派发 */
  readonly conditional: boolean
}

/** 这个编辑器的打开自检的结果（与 web 的 editor/profile/open-check.ts 的 OpenCheck 相同，M3-P4 设计 §3.11） */
export type ProbeOpenCheck
  = | { readonly ok: true }
    | { readonly ok: false, readonly failures: readonly OpenCheckFailure[] }

/** 公式计算的进度（web 的 formula-settle-tracker.ts 的 FormulaProgress，只写用到的部分） */
export interface ProbeFormulaProgress {
  /** 见过的轮数（开始一轮加一） */
  readonly round: number
  readonly started: boolean
  readonly stopped: boolean
  readonly completed: boolean
}

interface EditorProbe {
  readonly univerAPI: FacadeApi
  readonly snapshot: () => string
  readonly commands: (after?: number) => readonly ProbeCommand[]
  readonly shortcuts: () => readonly ProbeShortcut[]
  readonly formulaBarText: () => string
  readonly canonicalLink: (url: string) => CanonicalLink
  readonly openCheck: ProbeOpenCheck
  /** 公式在哪里计算（worker 或 main-thread） */
  readonly formulaMode: SelftestFormulaMode
  /** 编辑器的本地修改序号（变更检测） */
  readonly changeSeq: () => number
  /** 公式收齐了没有（与保存、自动保存等的是同一个判断） */
  readonly formulasSettled: () => boolean
  readonly formulaProgress: () => ProbeFormulaProgress
}

declare global {
  interface Window {
    /** 只在测试构建里有 */
    __nerveEditorProbe?: EditorProbe
  }
}

/** Facade 入口拿到的：Facade、当前工作簿与当前工作表（与页面自检共用的声明） */
export type FacadeScope = EntryScope

/** 入口在页面里的执行结果：调用抛出的错误被接住，写在 error 里 */
export interface FacadeOutcome {
  readonly error?: string
}

/** 页面里的探针；没有时（不是测试构建）直接失败 */
async function probeIn(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe !== undefined), { message: '页面里没有编辑器的探针：要跑测试构建（web 的 build:e2e），而且编辑器已经就绪' }).toBe(true)
}

/** 内存里的快照（与编辑器的捕获相同：JSON.stringify(save())） */
export async function probeSnapshot(page: Page): Promise<string> {
  await probeIn(page)
  return page.evaluate(() => window.__nerveEditorProbe?.snapshot() ?? '')
}

/** SDK 当前注册的全部快捷键（M2-P6 复核 F1、F2 之后） */
export async function probeShortcuts(page: Page): Promise<readonly ProbeShortcut[]> {
  await probeIn(page)
  return page.evaluate(() => window.__nerveEditorProbe?.shortcuts() ?? [])
}

/**
 * 编辑栏现在显示的文字（画在画布上，经探针读它的内部文档；M2-P6 复核 F2）。
 * 读不出来时失败，不返回空串（M2-P6 复验 N3）：探针取不到编辑栏的编辑器时抛错，页面里没有探针时同样抛错
 */
export async function formulaBarText(page: Page): Promise<string> {
  await probeIn(page)
  return page.evaluate(() => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    return probe.formulaBarText()
  })
}

/**
 * 页面里打包的链接地址判定（contracts 的 canonicalLink，与链接的改写器用的同一份代码；M3-P3 S2）：按顺序给出每个地址的结果。
 * 规范写法依赖浏览器的 WHATWG URL，跨引擎的用例经它在每个浏览器里核对
 */
export async function probeCanonicalLinks(page: Page, urls: readonly string[]): Promise<readonly CanonicalLink[]> {
  await probeIn(page)
  return page.evaluate((inputs) => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    return inputs.map(url => probe.canonicalLink(url))
  }, [...urls])
}

/** 现在这个编辑器的打开自检的结果（M3-P4 设计 §3.11）：页面里没有探针时失败 */
export async function probeOpenCheck(page: Page): Promise<ProbeOpenCheck> {
  await probeIn(page)
  return page.evaluate(() => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    return probe.openCheck
  })
}

/** 现在这个编辑器的公式在哪里计算（M3-P4 设计 §3.14）：页面里没有探针时失败 */
export async function probeFormulaMode(page: Page): Promise<SelftestFormulaMode> {
  await probeIn(page)
  return page.evaluate(() => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    return probe.formulaMode
  })
}

/** 公式收齐了没有（与保存、自动保存等的是同一个判断）：页面里没有探针时失败 */
export async function probeFormulasSettled(page: Page): Promise<boolean> {
  await probeIn(page)
  return page.evaluate(() => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    return probe.formulasSettled()
  })
}

/** 编辑器的本地修改序号（变更检测）：页面里没有探针时失败 */
export async function probeChangeSeq(page: Page): Promise<number> {
  await probeIn(page)
  return page.evaluate(() => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    return probe.changeSeq()
  })
}

/**
 * 经 Facade 写一格的值（SetRangeValuesCommand，与键入、回车之后写进模型的是同一条命令；同步执行）：sheet 是工作表的名称，默认当前的表。
 * 不经界面：停住的时间里也不用点画布、等编辑框，节奏类的用例一步一处修改
 */
export async function setCellValue(page: Page, a1: string, value: string | number, sheet?: string): Promise<void> {
  await probeIn(page)
  await page.evaluate(({ a1, value, sheet }) => {
    const workbook = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook()
    if (workbook === undefined)
      throw new Error('页面里没有编辑器的探针')
    const target = sheet === undefined ? workbook.getActiveSheet() : workbook.getSheetByName(sheet)
    target.getRange(a1).setValue(value)
  }, { a1, value, sheet })
}

/** 命令日志：序号大于 after 的各条 */
export async function probeCommands(page: Page, after = 0): Promise<readonly ProbeCommand[]> {
  return page.evaluate(since => window.__nerveEditorProbe?.commands(since) ?? [], after)
}

/** 命令日志当前的最后一个序号：之后的操作从这里开始看 */
export async function commandMark(page: Page): Promise<number> {
  await probeIn(page)
  return page.evaluate(() => window.__nerveEditorProbe?.commands().at(-1)?.seq ?? 0)
}

/** 等到 mark 之后的命令日志里出现符合 expected 的一条（例如某条命令已被尝试、已被取消、已执行完） */
export async function waitForCommand(page: Page, mark: number, expected: Partial<ProbeCommand>): Promise<void> {
  await expect.poll(async () => probeCommands(page, mark), { message: `等命令日志里出现 ${JSON.stringify(expected)}` }).toContainEqual(expect.objectContaining(expected))
}

/**
 * 在页面里执行一段 Facade 调用（M0 的 Facade 入口）。entry 会被序列化到页面里执行（Playwright 经调试协议求值，不受页面 CSP 的限制），
 * 不能引用外面的变量。调用抛出的错误在页面里接住并返回：取消之后仍去取结果的 Facade 方法会在调用方抛错
 * （例如 insertSheet 的 TypeError，M2-P3 设计 §3.3），这不是页面错误，用例据此区分
 */
export async function runFacade(page: Page, entry: (scope: FacadeScope) => unknown): Promise<FacadeOutcome> {
  await probeIn(page)
  const run = async (fn: (scope: FacadeScope) => unknown): Promise<FacadeOutcome> => {
    const api = window.__nerveEditorProbe?.univerAPI
    if (api === undefined)
      return { error: '页面里没有编辑器的探针' }
    try {
      const workbook = api.getActiveWorkbook()
      await fn({ api, workbook, sheet: workbook.getActiveSheet() })
      return {}
    }
    catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    }
  }
  return page.evaluate<FacadeOutcome>(`(${run.toString()})(${entry.toString()})`)
}

/** 当前工作表里一个单元格的中心在画布上的位置（经 Facade 取，与 SDK 的布局一致） */
export async function cellCenter(page: Page, a1: string): Promise<{ x: number, y: number }> {
  await probeIn(page)
  const rect = await page.evaluate(address => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getRange(address).getCell(), a1)
  if (rect === undefined)
    throw new Error(`取不到单元格 ${a1} 的位置`)
  return { x: (rect.startX + rect.endX) / 2, y: (rect.startY + rect.endY) / 2 }
}

/** 当前工作表里一个单元格在画布上的范围 */
export async function cellRect(page: Page, a1: string): Promise<CellRect> {
  await probeIn(page)
  const rect = await page.evaluate(address => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getRange(address).getCell(), a1)
  if (rect === undefined)
    throw new Error(`取不到单元格 ${a1} 的位置`)
  return { startX: rect.startX, startY: rect.startY, endX: rect.endX, endY: rect.endY }
}

/** 当前工作表里选中的图片有几张 */
export async function activeImageCount(page: Page): Promise<number> {
  await probeIn(page)
  return page.evaluate(() => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getActiveImages().length ?? 0)
}

/** 编辑器现在的视图：当前工作表、左上角可见的行列、选区与主单元格（M3-P2 设计 §3.3：模式切换、"有更新"的重建前后保留它） */
export interface EditorView {
  readonly sheet: string
  readonly top: number
  readonly left: number
  readonly range: string | undefined
  readonly current: string | undefined
}

/** 经探针的 Facade 读出编辑器现在的视图（探针随编辑器重建，读的是现在的那一个） */
export async function editorView(page: Page): Promise<EditorView> {
  await probeIn(page)
  return page.evaluate(() => {
    const api = window.__nerveEditorProbe?.univerAPI
    if (api === undefined)
      throw new Error('页面里没有编辑器的探针')
    const workbook = api.getActiveWorkbook()
    const sheet = workbook.getActiveSheet()
    const scroll = sheet.getScrollState()
    return {
      sheet: sheet.getSheetName(),
      top: scroll.sheetViewStartRow,
      left: scroll.sheetViewStartColumn,
      range: sheet.getSelection()?.getActiveRange()?.getA1Notation(),
      current: workbook.getActiveCell()?.getA1Notation(),
    }
  })
}

/**
 * 页面里现在显示的一格的值（探针给出的内存快照；sheetId 默认是第一张表）：没有这一格时为 null。重建期间旧的编辑器已经销毁、
 * 新的还没就绪，页面里没有探针，这时为 undefined：调用方用 expect.poll 等到新的编辑器
 */
export async function shownCell(page: Page, a1: string, sheetId?: string): Promise<unknown> {
  const text = await page.evaluate(() => window.__nerveEditorProbe?.snapshot() ?? '')
  if (text === '')
    return undefined
  return cellOf(JSON.parse(text) as Workbook, a1, sheetId)?.v ?? null
}

/**
 * 经探针在当前工作表上滚到第 row 行、第 column 列（从 0 开始）在左上角，选中 range（A1 写法）：滚动与选区是视图的操作，只读时照常。
 * 列数不多时往右滚到头，SDK 按能滚到的最远处停
 */
export async function scrollAndSelect(page: Page, row: number, column: number, range: string): Promise<void> {
  await probeIn(page)
  await page.evaluate(({ row, column, range }) => {
    const sheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
    if (sheet === undefined)
      throw new Error('页面里没有编辑器的探针')
    sheet.scrollToCell(row, column)
    sheet.getRange(range).activate()
  }, { row, column, range })
}

/** 编辑栏左边的名称框：显示当前单元格的地址（只读时编辑栏照常显示） */
export function nameBox(page: Page): Locator {
  return page.locator('[data-u-comp="defined-name"]').getByRole('textbox')
}

/** 点击当前工作表的一个单元格，等到名称框显示它的地址（选区已经移过去） */
export async function clickCell(page: Page, a1: string): Promise<void> {
  await sheetCanvas(page).click({ position: await cellCenter(page, a1) })
  await expect(nameBox(page)).toHaveValue(a1)
}

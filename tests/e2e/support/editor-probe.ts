// 编辑器的探针（M2-P3 设计 §3.7；apps/web/src/editor/testing/e2e-probe.ts）：只在测试构建里，E2E 这边看不到 web 的类型，这里声明用到的部分。
// - 内存里的快照：画布上的内容读不出来，"改动被拦住"比较内存里的快照；
// - 命令日志：每条命令执行前（带是否被取消）与执行后各一条。用例按"某条命令已经被尝试、已被取消或已执行完"等到这次操作处理完，
//   不用固定时长的等待（规范 §8.1）；
// - Facade：M0 的 Facade 入口经它逐项调用；单元格在画布上的位置也经它取（只读样本的列宽、隐藏的列与行高不是模板的默认值）。
// 用到探针的用例打上 @test-build：外部模式测生产镜像，里面没有探针，按标签排除（playwright.config.ts）
import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'
import { sheetCanvas } from './sheet.ts'

/** 命令日志里的一条（与 e2e-probe.ts 的 ProbeCommand 相同） */
export interface ProbeCommand {
  /** 从 1 开始的序号，按发生的顺序 */
  readonly seq: number
  /** before：执行前（canceled 是入口守卫、只读守卫给出的结果）；executed：执行完。被 SDK 的权限检查拦下的命令只有 before */
  readonly phase: 'before' | 'executed'
  readonly id: string
  readonly kind: 'command' | 'operation' | 'mutation'
  readonly canceled: boolean
  /** 参数里的 unitId */
  readonly unitId?: string | undefined
  /** 执行选项里为真的标记（onlyLocal、fromFormula 等） */
  readonly flags: readonly string[]
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

export interface FacadeRange {
  readonly getRange: () => unknown
  readonly getCell: () => CellRect
  /** A1 写法（单个单元格时就是它的地址） */
  readonly getA1Notation: () => string
  /** 设为当前选区（选区的操作，只读时照常） */
  readonly activate: () => unknown
  readonly createFilter: () => unknown
  readonly sort: (column: { readonly column: number, readonly ascending: boolean }) => unknown
  readonly merge: () => unknown
  readonly setFontWeight: (weight: 'bold') => unknown
  readonly setDataValidation: (rule: unknown) => unknown
  readonly setHyperLink: (url: string, label: string) => Promise<boolean>
  /** 取消左上角单元格里的超链接 */
  readonly cancelHyperLink: () => boolean
  readonly createOrUpdateNote: (note: { readonly note: string, readonly width: number, readonly height: number }) => unknown
}

export interface FacadeImage {
  readonly setPositionAsync: (row: number, column: number) => Promise<boolean>
  readonly setSizeAsync: (width: number, height: number) => Promise<boolean>
  readonly remove: () => boolean
}

interface ConditionalFormattingBuilder {
  readonly whenCellNotEmpty: () => ConditionalFormattingBuilder
  readonly setRanges: (ranges: readonly unknown[]) => ConditionalFormattingBuilder
  readonly setBackground: (color: string) => ConditionalFormattingBuilder
  readonly build: () => unknown
}

interface DataValidationBuilder {
  readonly requireNumberBetween: (from: number, to: number) => DataValidationBuilder
  readonly build: () => unknown
}

export interface FacadeSheet {
  readonly getRange: (a1: string) => FacadeRange
  readonly getSheetId: () => string
  readonly getSheetName: () => string
  /** 缩放比例（sheets-ui 的 Facade） */
  readonly getZoom: () => number
  readonly zoom: (ratio: number) => unknown
  /** 滚到这一格在左上角（从 0 开始的行号与列号；sheets-ui 的 Facade） */
  readonly scrollToCell: (row: number, column: number) => unknown
  /** 滚动的位置：左上角是第几行、第几列 */
  readonly getScrollState: () => { readonly sheetViewStartRow: number, readonly sheetViewStartColumn: number }
  readonly setName: (name: string) => unknown
  readonly hideSheet: () => unknown
  readonly setRowHeight: (row: number, height: number) => unknown
  readonly insertRowAfter: (row: number) => unknown
  readonly deleteRows: (row: number, count: number) => unknown
  readonly getImages: () => readonly FacadeImage[]
  /** 选中的图片 */
  readonly getActiveImages: () => readonly FacadeImage[]
  readonly newConditionalFormattingRule: () => ConditionalFormattingBuilder
  readonly addConditionalFormattingRule: (rule: unknown) => unknown
}

export interface FacadeWorkbook {
  readonly getId: () => string
  readonly getActiveSheet: () => FacadeSheet
  /** 当前单元格（选区的主单元格）；没有选区时是 null */
  readonly getActiveCell: () => FacadeRange | null
  /** 找不到时是 null：入口里按样本的名称取，取不到就让调用抛错（接住后用例失败） */
  readonly getSheetByName: (name: string) => FacadeSheet
  readonly insertSheet: (name: string) => unknown
  readonly deleteSheet: (sheet: FacadeSheet) => unknown
  readonly duplicateSheet: (sheet: FacadeSheet) => unknown
  readonly moveSheet: (sheet: FacadeSheet, index: number) => unknown
}

interface TextFinder {
  readonly replaceAllWithAsync: (text: string) => Promise<number>
}

export interface FacadeApi {
  readonly getActiveWorkbook: () => FacadeWorkbook
  /** 直接执行一条命令或 mutation（经命令服务，执行前的事件照常送出） */
  readonly executeCommand: (id: string, params?: object, options?: object) => Promise<boolean>
  readonly newDataValidation: () => DataValidationBuilder
  readonly createTextFinderAsync: (text: string) => Promise<TextFinder>
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

interface EditorProbe {
  readonly univerAPI: FacadeApi
  readonly snapshot: () => string
  readonly commands: (after?: number) => readonly ProbeCommand[]
  readonly shortcuts: () => readonly ProbeShortcut[]
  readonly formulaBarText: () => string
}

declare global {
  interface Window {
    /** 只在测试构建里有 */
    __nerveEditorProbe?: EditorProbe
  }
}

/** Facade 入口拿到的：Facade、当前工作簿与当前工作表 */
export interface FacadeScope {
  readonly api: FacadeApi
  readonly workbook: FacadeWorkbook
  readonly sheet: FacadeSheet
}

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

/** 编辑栏现在显示的文字（画在画布上，经探针读它的内部文档；M2-P6 复核 F2） */
export async function formulaBarText(page: Page): Promise<string> {
  await probeIn(page)
  return page.evaluate(() => window.__nerveEditorProbe?.formulaBarText() ?? '')
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

/** 编辑栏左边的名称框：显示当前单元格的地址（只读时编辑栏照常显示） */
export function nameBox(page: Page): Locator {
  return page.locator('[data-u-comp="defined-name"]').getByRole('textbox')
}

/** 点击当前工作表的一个单元格，等到名称框显示它的地址（选区已经移过去） */
export async function clickCell(page: Page, a1: string): Promise<void> {
  await sheetCanvas(page).click({ position: await cellCenter(page, a1) })
  await expect(nameBox(page)).toHaveValue(a1)
}

/**
 * 快照的内容（比较用，M0-P3 报告 §3.4 的口径，spikes/m0/src/harness/content-compare.ts）：
 * - 资源的 data 解析成对象，去掉取值为空的键（空数组、空对象、null、空串）：SDK 的读取会给模型补上空的规则表
 *   （观察者效应，M0-P3 报告 §2.3 第 4 条），复制单元格、删除工作表的命令即使被取消也会读一次数据验证的规则表，这类差别不是改动；
 * - 去掉工作表的视图状态 zoomRatio、scrollTop、scrollLeft：缩放与滚动不产生 mutation，只读时照常可用（M0-P3 报告 §2.3 第 6 条）；
 * - 资源按名称排序；对象键的顺序不影响 toEqual 的比较。
 * 单元格、样式、工作表的结构与顺序原样比较
 */
export function contentOf(snapshotText: string): unknown {
  const snapshot = JSON.parse(snapshotText) as { sheets?: Record<string, Record<string, unknown>>, resources?: readonly { name: string, data: string }[] }
  for (const sheet of Object.values(snapshot.sheets ?? {})) {
    delete sheet.zoomRatio
    delete sheet.scrollTop
    delete sheet.scrollLeft
  }
  const resources = [...snapshot.resources ?? []]
    .map(resource => ({ name: resource.name, data: pruneEmpty(resource.data === '' ? null : JSON.parse(resource.data) as unknown) }))
    .filter(resource => !isEmptyValue(resource.data))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ...snapshot, resources }
}

/** 结构上为空：null、空串、空数组、空对象，或者各层都为空 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '')
    return true
  if (Array.isArray(value))
    return value.every(isEmptyValue)
  if (typeof value === 'object')
    return Object.values(value).every(isEmptyValue)
  return false
}

/** 去掉取值为空的键（例如某张工作表对应的空规则表），它们与"没有这个键"在内容上等价 */
function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(pruneEmpty)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmptyValue(item)).map(([key, item]) => [key, pruneEmpty(item)]))
  return value
}

// 写入之前改写单元格里的链接（M3-P3 设计 §3.6，DEF-021；00 号计划书 §11.3）。
// SDK 自动识别出的链接（键入、编辑栏里键入与粘贴、表格上与单元格编辑器里粘贴纯文本、粘贴带链接的 HTML）与 HYPERLINK() 的结果，
// 都经写单元格的 mutation（sheet.mutation.set-range-values）写进单元格：参数 cellValue[行][列] 是单元格，链接在富文本 p.body.customRanges 里。
// 写出的地址多数不是规范写法（邮箱写成 mailto://、ftp:// 照样识别、粘贴的 example.org 原样、HTML 的相对地址原样……），
// 服务端只接受规范写法（contracts 的 checkCellLinks）。所以改写器订阅 Facade 的执行前事件（BeforeCommandExecute），只处理这一条 mutation：
// 参数里每个带 p.body.customRanges 的单元格交给 contracts 的 normalizeCellLinks（与服务端同一套判定），就地改成规范写法，不合法的去掉链接、
// 保留文字。就地改写依赖一条内部约定：执行前事件交出的 params 就是处理器执行、命令放进撤销栈的同一个对象（internal-api 的
// CELL_LINK_PROTOCOL 登记证据与回归），所以改写不多产生 mutation、不单独进撤销栈——它就是这次编辑的一部分，撤销、重做出来的都是改写之后的。
//
// 公式的结果（执行选项带 fromFormula）另做一步：HYPERLINK() 的结果每次计算都由 SDK 重新生成富文本，链接的 rangeId 与段落的 paragraphId
// 都是随机的；HYPERLINK() 的格子又没有 v，每次打开文档都要重算（初次计算只算没有值的公式格）。不处理的话同一份表格每重算、每打开一次内容就变一次，
// "内容相同不递增"（M3-P3 设计 §3.7）对含 HYPERLINK() 的表格不成立。所以带 fromFormula 的写入里，每个有富文本的单元格在 normalizeCellLinks 之后：
// - 第 k 个链接（按 customRanges 里的顺序、只数链接，从 0 起）的 rangeId 换成 formula-<行>-<列>-<k>（formulaRangeId）；
// - 第 j 个段落（paragraphs 里的下标）原有的 paragraphId 换成 para_formula-<行>-<列>-<j>（formulaParagraphId；SDK 认的段落 id 以 para_ 开头）。
// 行、列是这次写入的 cellValue 里的行号与列号（单元格在工作表里的位置，从 0 开始），值只由位置与序号决定，与 SDK 给的随机值无关：
// 重算多少次都一样，同一个单元格里互不相同，也合 rangeId 的写法（contracts 的 RANGE_ID，服务端的 link-range-id）。
// 与 normalizeCellLinks 的 rangeId 处理的关系：它只换下不合写法的 rangeId（link-<下标>，同一个单元格里重复时再加序号），合写法的随机值原样保留——
// 对用户写进来的链接这就够了（存下的就是那一份），对公式的结果不够；这里在它之后对公式结果的每个链接一律换上确定的值（不管原来合不合写法），
// 覆盖它可能给出的 link-<下标>。公式的结果里没有用户写的链接，不会撞上；别的种类的区间公式的结果里没有，不动。
// 代价：单元格挪了位置（插入行列等）而没有重算时，存下的仍是原来位置的值，等下一次重算（最迟下一次打开）换成新位置的值，内容随之变一次。
//
// 绝不抛出：Facade 派发执行前事件没有 try/catch（core 的 f-event-registry.ts 的 fireEvent），订阅者抛出会让这条命令失败（键入、粘贴都会坏），
// 还会跳过排在后面的订阅者。normalizeCellLinks 对任何 JSON 的值都不抛出，看不懂的结构按不合法处理；参数里万一有它处理不了的东西（冻结的对象、
// 读取时抛错的属性），这个单元格去掉链接（去不掉就算了），错误交给浏览器的错误报告，命令照常执行——服务端的核对是最后一道防线（存不进去，
// 而不是存下不规范的地址）。参数可能很大（大范围的粘贴），每个单元格只看一眼有没有富文本，只改写带链接的（公式的结果：带富文本的）。
// 装在入口守卫之后、创建工作簿之前，阅读与编辑都装（sheet-editor.ts）：阅读时只会碰到公式的结果，显示的与编辑时一致；
// 只读的防火墙照旧取消用户的写入（Facade 先调完全部订阅者再看取消，先后不影响）
import type { IDisposable } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { HYPERLINK_RANGE_TYPE, normalizeCellLinks } from '@nerve-office/contracts'
import { CELL_LINK_PROTOCOL } from '../internal-api/index.ts'

/** 执行前事件里改写器用到的部分（Facade 的 BeforeCommandExecute：{ id, type, params, options }） */
export interface CellWriteEvent {
  readonly id: string
  readonly params?: unknown
  readonly options?: Readonly<Record<string, unknown>> | undefined
}

type JsonObject = Record<string, unknown>

/** 普通对象（不是 null、不是数组），与 contracts 的 isJsonObject 同一个口径 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** cellValue 与它的每一行：按行号、列号作键的对象（ObjectMatrix 的原始形式；数组也按下标作键遍历） */
function isMatrix(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

/** 行号、列号：非负整数的写法（SDK 写出的都是）。别的写法拼不出合规的 rangeId，这样的单元格不换标识（链接照样改写） */
const POSITION = /^\d{1,9}$/

/** 公式结果里第 ordinal 个链接的 rangeId（见文件开头） */
export function formulaRangeId(row: string, column: string, ordinal: number): string {
  return `formula-${row}-${column}-${ordinal}`
}

/** 公式结果里第 ordinal 个段落的 paragraphId（见文件开头） */
export function formulaParagraphId(row: string, column: string, ordinal: number): string {
  return `para_formula-${row}-${column}-${ordinal}`
}

/** 单元格的富文本与它的正文：cell、cell.p 与 p.body 都是对象时给出 */
function richTextOf(cell: unknown): { readonly p: JsonObject, readonly body: JsonObject } | undefined {
  if (!isObject(cell))
    return undefined
  const { p } = cell
  if (!isObject(p))
    return undefined
  const { body } = p
  return isObject(body) ? { p, body } : undefined
}

/** 数组的每一项换成 next 给出的值；有一项换了就给出新数组，都没换时是 undefined（原来的数组与对象都不改，同 normalizeCellLinks） */
function remapped(items: readonly unknown[], next: (item: unknown, index: number) => unknown): unknown[] | undefined {
  const mapped = items.map(next)
  return mapped.some((item, index) => item !== items[index]) ? mapped : undefined
}

/**
 * 公式结果的富文本：链接的 rangeId 与段落原有的 paragraphId 换成由位置与序号确定的值（见文件开头）。返回改动过没有；
 * 改动时换上新的数组与新的区间、段落对象
 */
function settleFormulaRichText(body: JsonObject, row: string, column: string): boolean {
  let changed = false
  if (Array.isArray(body.customRanges)) {
    let ordinal = 0
    const ranges = remapped(body.customRanges as readonly unknown[], (range) => {
      if (!isObject(range) || range.rangeType !== HYPERLINK_RANGE_TYPE)
        return range
      const rangeId = formulaRangeId(row, column, ordinal)
      ordinal += 1
      return range.rangeId === rangeId ? range : { ...range, rangeId }
    })
    if (ranges !== undefined) {
      body.customRanges = ranges
      changed = true
    }
  }
  if (Array.isArray(body.paragraphs)) {
    const paragraphs = remapped(body.paragraphs as readonly unknown[], (paragraph, index) => {
      if (!isObject(paragraph) || paragraph.paragraphId === undefined)
        return paragraph
      const paragraphId = formulaParagraphId(row, column, index)
      return paragraph.paragraphId === paragraphId ? paragraph : { ...paragraph, paragraphId }
    })
    if (paragraphs !== undefined) {
      body.paragraphs = paragraphs
      changed = true
    }
  }
  return changed
}

/**
 * 改写一个单元格（就地）：返回改动过没有。用户写进来的只看带 customRanges 的；公式的结果看每个带富文本的，
 * 改写链接之后再换上确定的标识
 */
function rewriteCell(cell: unknown, row: string, column: string, fromFormula: boolean): boolean {
  const richText = richTextOf(cell)
  if (richText === undefined)
    return false
  const { p, body } = richText
  const hasRanges = body.customRanges !== undefined && body.customRanges !== null
  if (!hasRanges && !fromFormula)
    return false
  const linksChanged = hasRanges && normalizeCellLinks(p)
  const settled = fromFormula && POSITION.test(row) && POSITION.test(column) && settleFormulaRichText(body, row, column)
  return linksChanged || settled
}

/** 改写出了意外时：去掉这个单元格的链接（别的种类的区间留着）；去不掉就算了，服务端的核对兜底 */
function dropLinks(cell: unknown): void {
  try {
    const body = richTextOf(cell)?.body
    if (body === undefined)
      return
    const ranges = body.customRanges
    body.customRanges = Array.isArray(ranges) ? (ranges as readonly unknown[]).filter(range => isObject(range) && range.rangeType !== HYPERLINK_RANGE_TYPE) : []
  }
  catch {
    // 连去掉也做不到（例如冻结的对象）：这次写入照常执行，保存时被服务端拒绝（link-*），而不是存下不规范的地址
  }
}

/** 报告错误也不能抛出 */
function reportSafely(report: (error: unknown) => void, error: unknown): void {
  try {
    report(error)
  }
  catch {
    // 报告的通道本身出错：没有别的办法，至少不让这条命令失败
  }
}

/**
 * 改写一条命令的参数（就地）：只处理写单元格的 mutation，别的命令、没有 cellValue 的写入什么也不做。返回改写过的单元格数。
 * 绝不抛出：单元格级的意外去掉这个单元格的链接，错误交给 report
 */
export function rewriteCellWrite(event: CellWriteEvent, report: (error: unknown) => void): number {
  try {
    if (event.id !== CELL_LINK_PROTOCOL.setRangeValuesMutationId)
      return 0
    const cellValue = isObject(event.params) ? event.params.cellValue : undefined
    if (!isMatrix(cellValue))
      return 0
    const fromFormula = Boolean(event.options?.[CELL_LINK_PROTOCOL.fromFormulaOption])
    let rewritten = 0
    for (const row of Object.keys(cellValue)) {
      const columns = cellValue[row]
      if (!isMatrix(columns))
        continue
      for (const column of Object.keys(columns)) {
        const cell = columns[column]
        try {
          if (rewriteCell(cell, row, column, fromFormula))
            rewritten += 1
        }
        catch (error) {
          dropLinks(cell)
          reportSafely(report, new Error(`改写单元格（${row}，${column}）里的链接时出错，已去掉这个单元格的链接`, { cause: error }))
        }
      }
    }
    return rewritten
  }
  catch (error) {
    reportSafely(report, new Error('改写写入单元格的链接时出错，这次写入没有改完', { cause: error }))
    return 0
  }
}

/** 装上改写器（创建工作簿之前、入口守卫之后，见 sheet-editor.ts）：返回卸下它的句柄 */
export function installLinkPolicy(univerAPI: FUniver, report: (error: unknown) => void = error => reportError(error)): IDisposable {
  return univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
    rewriteCellWrite(event, report)
  })
}

// 视图状态（M3-P2 设计 §3.3）：模式切换一律重建编辑器（§3.1），重建前取出、重建后恢复当前工作表、左上角可见的行列（滚动位置）与主选区，
// 用户换了编辑器还在原来的地方。全部经公开的 Facade（sheets 与 sheets-ui 的 FWorkbook、FWorksheet、FRange），不用内部 API：
// - 当前工作表：getActiveSheet / getSheetBySheetId / setActiveSheet（SetWorksheetActiveOperation，是操作不是 mutation，只读时照常）；
// - 滚动：getScrollState 给的 sheetViewStartRow 不含冻结的行（有冻结时它比主视口里看到的第一行小 ySplit），scrollToCell 反过来减去冻结
//   （sheets-ui 的 services/scroll-manager.service.ts 的 IScrollState、scroll.render-controller.ts 的 scrollToCell）：
//   这里记下主视口里看到的第一行、第一列（sheetViewStartRow + ySplit），恢复时按它滚动，冻结没变时分毫不差；行内的偏移不保留；
// - 主选区：getActiveRange 的 IRange（含整行、整列的类型）与当前单元格（getActiveCell，合并单元格时是整个合并区），
//   恢复用 getRange(IRange).activate() 与 activateAsCurrentCell（都是 SetSelectionsOperation，只读时照常）。
//   按新内容重建时（"有更新"、进入编辑时本页落后、放弃本页的修改、副本建好之后），合并的布局可能变了：activateAsCurrentCell 只接受
//   一个没有合并的单元格或者恰好一个合并区，否则抛错（M3-P2 复核 B1），所以设之前先按新表的合并信息核对（canBeCurrentCell），
//   不符合就不设当前单元格，它落在选区的左上角（activate 给的）；
// 只取一个选区（主选区），多选区的其余部分不保留。取出与恢复都不抛出：取不出来时没有视图状态；工作表已经不在、被隐藏了，
// 选区超出了现在的行列、当前单元格的合并布局变了，就跳过那一项（这是预期之内的，不报告）；Facade 意外出错时报告（浏览器的 reportError），
// 编辑器照常可用。恢复分三步，选区与滚动各自接住自己的错误：选区那一步出错不影响滚动，可见区域照样回到原处
import type { IRange } from '@univerjs/core'
// 滚动的两个方法由 sheets-ui 的 Facade 补进 FWorksheet（声明合并）；那两个 Facade 的副作用导入在 sheet-editor.ts，这里只用类型
import type { FRange, FWorkbook, FWorksheet } from '@univerjs/sheets/facade'

/** 一个矩形区域（从 0 开始的行号与列号，含两端）与它的类型（普通、整行、整列、全选，RANGE_TYPE 的取值） */
export interface SheetArea {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
  readonly rangeType: number | undefined
}

export interface SheetViewState {
  /** 当前工作表的 id */
  readonly sheetId: string
  /** 主视口里看到的第一行、第一列（从 0 开始；含冻结的部分，与 scrollToCell 的参数同一口径） */
  readonly topLeft: { readonly row: number, readonly column: number }
  /** 主选区与它的当前单元格；没有选区时为 undefined */
  readonly selection: { readonly range: SheetArea, readonly current: SheetArea } | undefined
}

/** 用到的 Facade：工作簿 */
export type ViewWorkbook = Pick<FWorkbook, 'getActiveSheet' | 'getSheetBySheetId' | 'setActiveSheet' | 'getActiveRange' | 'getActiveCell'>

function areaOf(range: FRange): SheetArea {
  const { startRow, endRow, startColumn, endColumn, rangeType } = range.getRange()
  return { startRow, endRow, startColumn, endColumn, rangeType }
}

/** 取出现在的视图状态；Facade 出错时报告并返回 undefined（重建之后是默认视图） */
export function readViewState(workbook: ViewWorkbook, report: (error: unknown) => void = reportError): SheetViewState | undefined {
  try {
    const sheet = workbook.getActiveSheet()
    const scroll = sheet.getScrollState()
    const { xSplit, ySplit } = sheet.getFreeze()
    const range = workbook.getActiveRange()
    const current = workbook.getActiveCell()
    return {
      sheetId: sheet.getSheetId(),
      topLeft: { row: scroll.sheetViewStartRow + ySplit, column: scroll.sheetViewStartColumn + xSplit },
      selection: range === null || current === null ? undefined : { range: areaOf(range), current: areaOf(current) },
    }
  }
  catch (error) {
    report(new Error('取出视图状态时出错，重建之后是默认视图', { cause: error }))
    return undefined
  }
}

/** 区域在这张表现在的行列里（行列被删掉之后选区可能落在外面） */
function fits(area: SheetArea, sheet: FWorksheet): boolean {
  const values = [area.startRow, area.endRow, area.startColumn, area.endColumn]
  return values.every(value => Number.isInteger(value) && value >= 0)
    && area.startRow <= area.endRow && area.startColumn <= area.endColumn
    && area.endRow < sheet.getMaxRows() && area.endColumn < sheet.getMaxColumns()
}

function rangeIn(sheet: FWorksheet, area: SheetArea): FRange {
  const range: IRange = { startRow: area.startRow, endRow: area.endRow, startColumn: area.startColumn, endColumn: area.endColumn, sheetId: sheet.getSheetId() }
  return sheet.getRange(area.rangeType === undefined ? range : { ...range, rangeType: area.rangeType })
}

/**
 * 能不能设为当前单元格：activateAsCurrentCell 只接受一个没有合并的单元格，或者恰好是一个合并区，否则抛 'The range is not a single cell'
 * （sheets 的 facade/f-range.ts 的 activateAsCurrentCell：按左上角所在的合并区判断）。重建之后合并的布局可能变了——别人合并了
 * 本页当前单元格所在的格子（记下的是单格，现在落在合并区里），或者取消了它所在的合并（记下的是合并区，现在不是）——按新表核对：
 * isMerged 与 activateAsCurrentCell 用同一个相等判断（Rectangle.equals），isPartOfMerge 看这一格有没有落进合并区，都是公开的 Facade
 */
function canBeCurrentCell(range: FRange): boolean {
  if (range.isMerged())
    return true
  const { startRow, endRow, startColumn, endColumn } = range.getRange()
  return startRow === endRow && startColumn === endColumn && !range.isPartOfMerge()
}

/** 恢复一步：意外出错时报告（说明这一步停在哪里），返回这一步是否没有出错 */
function attempt(step: () => void, failure: string, report: (error: unknown) => void): boolean {
  try {
    step()
    return true
  }
  catch (error) {
    report(new Error(failure, { cause: error }))
    return false
  }
}

/** 设主选区与当前单元格。选区不在现在的行列里：不设；当前单元格的合并布局变了：只设选区（当前单元格落在选区的左上角） */
function restoreSelection(sheet: FWorksheet, selection: SheetViewState['selection']): void {
  if (selection === undefined || !fits(selection.range, sheet) || !fits(selection.current, sheet))
    return
  rangeIn(sheet, selection.range).activate()
  const current = rangeIn(sheet, selection.current)
  if (canBeCurrentCell(current))
    current.activateAsCurrentCell()
}

/**
 * 恢复视图状态（编辑器就绪之后）。三步：先切到那张表（滚动与选区都作用于当前的表），再设选区，最后滚动。
 * 滚动放在最后、而且单独接住错误：设选区现在不滚动，将来即使滚动了，可见区域也由最后的 scrollToCell 定下；
 * 选区那一步意外出错（已报告）时照样滚动，用户还在原来的地方。工作表已经不在或被隐藏：什么也不做；
 * 选区不在现在的行列里、当前单元格的合并布局变了：跳过那一项。都是预期之内的，不报告。
 * 返回恢复的结果（单元测试与排查用）：有一步意外出错（已报告）时是 failed，其余各步照常做完
 */
export function restoreViewState(workbook: ViewWorkbook, state: SheetViewState, report: (error: unknown) => void = reportError): 'restored' | 'sheet-missing' | 'failed' {
  let sheet: FWorksheet | null
  try {
    sheet = workbook.getSheetBySheetId(state.sheetId)
    if (sheet === null || sheet.isSheetHidden())
      return 'sheet-missing'
    if (workbook.getActiveSheet().getSheetId() !== state.sheetId)
      workbook.setActiveSheet(sheet)
  }
  catch (error) {
    report(new Error('恢复视图状态时出错（切换工作表），停在默认视图', { cause: error }))
    return 'failed'
  }
  const target = sheet
  const selected = attempt(() => restoreSelection(target, state.selection), '恢复视图状态时出错（选区），选区停在默认的位置', report)
  const scrolled = attempt(() => {
    target.scrollToCell(Math.min(state.topLeft.row, target.getMaxRows() - 1), Math.min(state.topLeft.column, target.getMaxColumns() - 1))
  }, '恢复视图状态时出错（滚动位置），停在表的开头', report)
  return selected && scrolled ? 'restored' : 'failed'
}

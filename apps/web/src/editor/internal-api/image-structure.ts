import type { Univer, Workbook } from '@univerjs/core'
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core'
import { IDrawingManagerService } from '@univerjs/drawing'
import { CopySheetCommand, DeleteRangeMoveLeftCommand, DeleteRangeMoveUpCommand, getSheetCommandTarget, InsertColByRangeCommand, InsertColCommand, InsertColMutation, InsertRangeMoveDownCommand, InsertRangeMoveRightCommand, InsertRowByRangeCommand, InsertRowMutation, InsertSheetCommand, InsertSheetMutation, MoveColsCommand, MoveRangeCommand, MoveRangeMutation, MoveRowsCommand, RemoveColByRangeCommand, RemoveColCommand, RemoveRowByRangeCommand, RemoveRowCommand, RemoveSheetCommand } from '@univerjs/sheets'
import { ISheetDrawingService } from '@univerjs/sheets-drawing'
import { compatibleDrawingSheets, imageRecord } from './image-json.ts'
import { injectorOf } from './injector.ts'

export const IMAGE_STRUCTURE_PROTOCOL = Object.freeze({
  structural: Object.freeze([RemoveSheetCommand.id, CopySheetCommand.id, RemoveRowCommand.id, RemoveColCommand.id, RemoveRowByRangeCommand.id, RemoveColByRangeCommand.id, DeleteRangeMoveLeftCommand.id, DeleteRangeMoveUpCommand.id, InsertRangeMoveDownCommand.id, InsertRangeMoveRightCommand.id, MoveRowsCommand.id, MoveColsCommand.id, MoveRangeCommand.id]),
  // 1.0.1 的 barrel 声称导出 InsertRowCommand，实际 d.ts 无声明；ES 定义仍使用此 id。
  insertAxis: Object.freeze(['sheet.command.insert-row', InsertRowByRangeCommand.id, InsertColCommand.id, InsertColByRangeCommand.id]),
  applyAxis: Object.freeze([InsertRowMutation.id, InsertColMutation.id]),
  insertSheet: InsertSheetCommand.id,
  applySheet: InsertSheetMutation.id,
  moveRange: MoveRangeCommand.id,
  applyMove: MoveRangeMutation.id,
})

type Check = (value: unknown) => boolean
type StyleLookup = (id: string) => unknown

/** 只找工作表的样式引用；对象样式/富文本的图片由调用方的纯片段规则负责。 */
function validStyleReferences(sheet: unknown, lookup: StyleLookup, valid: Check): boolean {
  if (sheet === undefined)
    return true
  if (!imageRecord(sheet))
    return false
  const style = (value: unknown): boolean => typeof value !== 'string' || valid(lookup(value))
  let count = 0
  const cell = (value: unknown): boolean => ++count <= 1_500_000 && (!imageRecord(value) || style(value.s))
  const values = (value: unknown): unknown[] => typeof value === 'object' && value !== null ? Object.values(value) : []
  return style(sheet.defaultStyle)
    && values(sheet.cellData).every(row => values(row).every(cell))
    && values(sheet.rowData).every(cell)
    && values(sheet.columnData).every(cell)
}

function targetParams(id: string, params: Record<string, unknown>): Record<string, unknown>[] {
  // 这四个 handler 只读取 range，忽略传入的 unitId/subUnitId，始终操作当前表。
  if ([DeleteRangeMoveLeftCommand.id, DeleteRangeMoveUpCommand.id, InsertRangeMoveDownCommand.id, InsertRangeMoveRightCommand.id].includes(id))
    return [{}]
  if (id !== MoveRangeCommand.id)
    return [params]
  return [
    { unitId: params.fromUnitId ?? params.toUnitId, subUnitId: params.fromSubUnitId },
    { unitId: params.toUnitId ?? params.fromUnitId, subUnitId: params.toSubUnitId ?? params.fromSubUnitId },
  ]
}

/** 结构命令的 SDK 后处理没有回滚；在 handler 前检查目标表载体，不能等删表/删行后才拒绝。 */
export function acceptsImageStructure(univer: Univer, id: string, params: unknown, validSheet: Check, validFragment: Check): boolean {
  const injector = injectorOf(univer)
  const instances = injector.get(IUniverInstanceService)
  for (const input of targetParams(id, imageRecord(params) ? params : {})) {
    const target = getSheetCommandTarget(instances, {
      unitId: typeof input.unitId === 'string' ? input.unitId : undefined,
      subUnitId: typeof input.subUnitId === 'string' ? input.subUnitId : undefined,
    })
    if (!target)
      return false
    const { workbook, worksheet, unitId, subUnitId } = target
    if (id === MoveRangeCommand.id && instances.getCurrentUnitOfType<Workbook>(UniverInstanceType.UNIVER_SHEET)?.getUnitId() !== unitId)
      return false
    if ([RemoveRowCommand.id, RemoveColCommand.id, RemoveRowByRangeCommand.id, RemoveColByRangeCommand.id].includes(id)) {
      // 基础 mutation 用指定表，图片 after handler 却固定用当前表；不允许两部分落在不同表。
      const current = getSheetCommandTarget(instances)
      if (current?.unitId !== unitId || current.subUnitId !== subUnitId)
        return false
    }
    const sheet = {
      cellData: worksheet.getCellMatrix().getMatrix(),
      rowData: worksheet.getRowManager().getRowData(),
      columnData: worksheet.getColumnManager().getColumnData(),
      defaultStyle: worksheet.getConfig().defaultStyle,
      backgroundImage: worksheet.getConfig().backgroundImage,
    }
    if (!validSheet(sheet) || !validStyleReferences(sheet, key => workbook.getStyles().get(key), validFragment))
      return false
    const sheets = [injector.get(IDrawingManagerService), injector.get(ISheetDrawingService)].map(service => service.drawingManagerData[unitId]?.[subUnitId])
    const changesLayout = id !== RemoveSheetCommand.id && id !== CopySheetCommand.id
    if (!sheets.every(value => validFragment(value?.data)) || !compatibleDrawingSheets(sheets[0], sheets[1], { unitId, subUnitId }, changesLayout))
      return false
  }
  return true
}

/** 插表的 styles 先于工作表写入；所有引用先同时校验，不通过 addStyles 试写。 */
export function acceptsImageSheetInput(univer: Univer, params: unknown, validFragment: Check): boolean {
  if (params === undefined)
    return true
  if (!imageRecord(params))
    return false
  const instances = injectorOf(univer).get(IUniverInstanceService)
  const book = typeof params.unitId === 'string' ? instances.getUnit<Workbook>(params.unitId, UniverInstanceType.UNIVER_SHEET) : instances.getCurrentUnitOfType<Workbook>(UniverInstanceType.UNIVER_SHEET)
  if (!book)
    return false
  return validStyleReferences(params.sheet, key => imageRecord(params.styles) && Object.hasOwn(params.styles, key) ? params.styles[key] : book.getStyles().get(key), validFragment)
}

/** 固定 MoveRangeMutation 取 current workbook，不信任名义上的 unitId。 */
export function imageMoveTargets(univer: Univer, params: unknown): Record<string, unknown>[] | undefined {
  if (!imageRecord(params) || !imageRecord(params.from) || !imageRecord(params.to))
    return undefined
  const book = injectorOf(univer).get(IUniverInstanceService).getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET)
  if (!book || (params.unitId !== undefined && params.unitId !== book.getUnitId()))
    return undefined
  return [params.from, params.to].map(part => ({ unitId: book.getUnitId(), subUnitId: part.subUnitId, cellValue: part.value }))
}

import type { Univer } from '@univerjs/core'
import { isICellData, IUniverInstanceService } from '@univerjs/core'
import { getSheetCommandTarget, SheetsSelectionsService } from '@univerjs/sheets'
import { imageRecord } from './image-json.ts'
import { injectorOf } from './injector.ts'

type CellCheck = (cell: unknown) => boolean
const CELL_BUDGET = 1_500_000

function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function matrixCells(value: unknown, check: (row: number, column: number, cell: unknown) => boolean): boolean {
  if (value === null || value === undefined)
    return true
  if (typeof value !== 'object')
    return false
  const rows: [string, unknown][] = Object.entries(value)
  for (const [row, columns] of rows) {
    if (!/^\d{1,10}$/.test(row) || typeof columns !== 'object' || columns === null)
      return false
    for (const [column, cell] of Object.entries(columns)) {
      if (!/^\d{1,10}$/.test(column) || !check(Number(row), Number(column), cell))
        return false
    }
  }
  return true
}

function rangeCells(ranges: readonly unknown[], value: unknown, check: (row: number, column: number, cell: unknown) => boolean): boolean {
  let count = 0
  for (const range of ranges) {
    if (!imageRecord(range))
      return false
    const { startRow, endRow, startColumn, endColumn } = range
    if (!coordinate(startRow) || !coordinate(endRow) || !coordinate(startColumn) || !coordinate(endColumn) || endRow < startRow || endColumn < startColumn)
      return false
    count += (endRow - startRow + 1) * (endColumn - startColumn + 1)
    if (count > CELL_BUDGET)
      return false
    for (let row = startRow; row <= endRow; row++) {
      for (let column = startColumn; column <= endColumn; column++) {
        const cells: unknown = Array.isArray(value) ? value[row - startRow] : undefined
        const cell: unknown = Array.isArray(value) ? (Array.isArray(cells) ? cells[column - startColumn] : undefined) : value
        if (!check(row, column, cell))
          return false
      }
    }
  }
  return true
}

/** 只读本次写入的格子及其命名样式，不捕获工作簿，也不遍历 v/f。 */
export function acceptsImageCellWrite(univer: Univer, params: unknown, value: unknown, mutation: boolean, valid: CellCheck): boolean {
  if (!imageRecord(params))
    return false
  const injector = injectorOf(univer)
  const unitId = typeof params.unitId === 'string' ? params.unitId : undefined
  const subUnitId = typeof params.subUnitId === 'string' ? params.subUnitId : undefined
  const target = getSheetCommandTarget(injector.get(IUniverInstanceService), { unitId, subUnitId })
  if (!target)
    return false
  const { workbook, worksheet } = target
  const style = (cell: unknown): unknown => imageRecord(cell) && typeof cell.s === 'string' ? workbook.getStyles().get(cell.s) : undefined
  const validCell = (cell: unknown): boolean => valid(cell) && valid({ s: style(cell) })
  let count = 0
  const check = (row: number, column: number, cell: unknown): boolean => ++count <= CELL_BUDGET && validCell(worksheet.getCellMatrix().getValue(row, column)) && validCell(cell)
  if (mutation || (!Array.isArray(value) && !(imageRecord(value) && isICellData(value))))
    return matrixCells(value, check)
  const ranges = params.range === undefined ? injector.get(SheetsSelectionsService).getCurrentSelections()?.map(selection => selection.range) ?? [] : [params.range]
  return rangeCells(ranges, value, check)
}

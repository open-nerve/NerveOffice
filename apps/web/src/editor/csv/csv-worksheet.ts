import type { ICellData, IWorksheetData } from '@univerjs/core'
import type { CsvTable } from '../../shared/csv/index.ts'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { CellValueType } from '@univerjs/core'
import { assertCsvField, assertCsvShape, CsvError } from '../../shared/csv/index.ts'

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u

/** 只用于已确认的十进制或 Number.toString；不通过浮点容差判定等值。 */
function decimalKey(text: string): string {
  const [coefficient = '', exponent = '0'] = text.toLowerCase().split('e')
  const negative = coefficient.startsWith('-')
  const [whole = '', fraction = ''] = (negative ? coefficient.slice(1) : coefficient).split('.')
  const digits = `${whole}${fraction}`.replace(/^0+/u, '')
  const significant = digits.replace(/0+$/u, '')
  // 保留 -0 的符号差异：JSON 数字会抹去它，因此作为文本导入。
  return significant === ''
    ? `${negative ? '-' : ''}0`
    : `${negative ? '-' : ''}${significant}e${Number(exponent) - fraction.length + digits.length - significant.length}`
}

export function csvCell(text: string): ICellData {
  assertCsvField(text)
  if (text.trim() === text && DECIMAL.test(text)) {
    const significant = text.replace('-', '').replace('.', '').replace(/^0+/u, '')
    const value = Number(text)
    if (significant.length <= 15 && Number.isFinite(value) && decimalKey(text) === decimalKey(String(value)))
      return { v: value, t: CellValueType.NUMBER }
  }
  return { v: text, t: CellValueType.STRING }
}

export function csvWorksheet(table: CsvTable, identity: { readonly id: string, readonly name: string }): IWorksheetData {
  if (table.rows.length === 0 || table.columnCount === 0)
    throw new CsvError('empty')
  assertCsvShape(table.rows.length, table.columnCount)
  if (table.rowCount !== table.rows.length || !table.rows.every(row => row.length === table.columnCount))
    throw new CsvError('syntax')
  const cellData: NonNullable<IWorksheetData['cellData']> = {}
  for (const [rowIndex, row] of table.rows.entries()) {
    const cells: Record<number, ICellData> = {}
    for (const [column, text] of row.entries())
      cells[column] = csvCell(text)
    cellData[rowIndex] = cells
  }
  const template = structuredClone(SHEET_TEMPLATE.sheets['sheet-1'])
  return {
    ...template,
    ...identity,
    rowCount: Math.max(template.rowCount, table.rowCount),
    columnCount: Math.max(template.columnCount, table.columnCount),
    mergeData: [...template.mergeData],
    cellData,
  }
}

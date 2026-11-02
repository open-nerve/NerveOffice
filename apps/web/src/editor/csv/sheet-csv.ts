import type { ICellData, IWorkbookData, IWorksheetData, Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { FWorkbook } from '@univerjs/sheets/facade'
import type { CsvExportCell, CsvTable } from '../../shared/csv/index.ts'
import { CellValueType } from '@univerjs/core'
import { assertCsvShape } from '../../shared/csv/index.ts'
import { CSV_SHEET_COMMAND, csvArrayCells } from '../internal-api/index.ts'
import { CsvOperationError } from './csv-operation-error.ts'
import { assertCsvSnapshot } from './csv-snapshot.ts'
import { csvWorksheet } from './csv-worksheet.ts'

export interface CsvSheetSummary {
  readonly id: string
  readonly name: string
  readonly active: boolean
}

export interface SheetCsv {
  readonly sheets: () => readonly CsvSheetSummary[]
  readonly read: (sheetId: string) => readonly (readonly CsvExportCell[])[]
  readonly insert: (table: CsvTable) => string
}

interface SheetCsvOptions {
  readonly univer: Univer
  readonly workbook: FWorkbook
  readonly univerAPI: FUniver
  readonly canRead: () => boolean
  readonly canWrite: () => boolean
  readonly formulasSettled: () => boolean
  readonly newId: () => string
  readonly reportError: (error: unknown) => void
}

function hasContent(cell: ICellData | null | undefined): boolean {
  if (!cell)
    return false
  if ((cell.f ?? '') !== '' || (cell.si ?? '') !== '')
    return true
  const text = cell.p?.body?.dataStream
  if (text !== undefined && text !== '')
    return text.replace(/\r\n$/u, '') !== ''
  return cell.v !== undefined && cell.v !== null && cell.v !== ''
}

/** 扫描稀疏内容，先限矩形再分配；SDK getDataRange 也包含纯格式，不能用于 CSV。 */
function contentShape(sheet: Partial<IWorksheetData>): { rows: number, columns: number } {
  let rows = 1
  let columns = 1
  const matrix = sheet.cellData ?? {}
  for (const rowKey of Object.keys(matrix)) {
    const row = Number(rowKey)
    if (!Number.isSafeInteger(row) || row < 0)
      throw new CsvOperationError('capacity')
    const cells = matrix[row]
    for (const columnKey of Object.keys(cells ?? {})) {
      const column = Number(columnKey)
      if (!Number.isSafeInteger(column) || column < 0)
        throw new CsvOperationError('capacity')
      if (!hasContent(cells?.[column]))
        continue
      rows = Math.max(rows, row + 1)
      columns = Math.max(columns, column + 1)
      assertCsvShape(rows, columns)
    }
  }
  return { rows, columns }
}

function nextIdentity(snapshot: IWorkbookData, newId: () => string): { id: string, name: string } {
  let id = ''
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = newId()
    if (candidate !== '' && !Object.hasOwn(snapshot.sheets, candidate)) {
      id = candidate
      break
    }
  }
  if (id === '')
    throw new CsvOperationError('insert-failed')
  const names = new Set(Object.values(snapshot.sheets).flatMap(sheet => typeof sheet.name === 'string' ? [sheet.name.toLowerCase()] : []))
  let name = 'CSV导入'
  for (let suffix = 2; names.has(name.toLowerCase()); suffix += 1)
    name = `CSV导入 ${suffix}`
  return { id, name }
}

export function createSheetCsv(options: SheetCsvOptions): SheetCsv {
  const { workbook, univerAPI } = options
  const readable = (): void => {
    if (!options.canRead())
      throw new CsvOperationError('unavailable')
  }
  return {
    sheets() {
      readable()
      const active = workbook.getActiveSheet()?.getSheetId()
      return workbook.getSheets().filter(sheet => !sheet.isSheetHidden()).map(sheet => ({
        id: sheet.getSheetId(),
        name: sheet.getSheetName(),
        active: sheet.getSheetId() === active,
      }))
    },
    read(sheetId) {
      readable()
      if (!options.formulasSettled())
        throw new CsvOperationError('formula-pending')
      // 显示读取与正文捕获分开：先读取原始快照与实际数组缓存，再取显示值。
      const raw = workbook.save().sheets[sheetId]
      const sheet = workbook.getSheetBySheetId(sheetId)
      if (!raw || !sheet || sheet.isSheetHidden())
        throw new CsvOperationError('sheet-missing')
      const shape = contentShape(raw)
      const arrayTypes = new Map<string, boolean>()
      for (const { row, column, numeric } of csvArrayCells(options.univer, workbook.getId(), sheetId)) {
        if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0)
          throw new CsvOperationError('capacity')
        shape.rows = Math.max(shape.rows, row + 1)
        shape.columns = Math.max(shape.columns, column + 1)
        assertCsvShape(shape.rows, shape.columns)
        arrayTypes.set(`${row}:${column}`, numeric)
      }
      const { rows, columns } = shape
      const display = sheet.getRange(0, 0, rows, columns).getDisplayValues()
      return display.map((row, rowIndex) => row.map((text, columnIndex) => {
        const cell = raw.cellData?.[rowIndex]?.[columnIndex]
        const rawNumeric = cell?.t === CellValueType.NUMBER || ((cell?.t === undefined || cell.t === null) && typeof cell?.v === 'number')
        // 数组缓存只覆盖 v/t，不替换原 p；实际富文本仍优先于数字显示。
        const numeric = (arrayTypes.get(`${rowIndex}:${columnIndex}`) ?? rawNumeric) && (cell?.p?.body?.dataStream ?? '') === ''
        return { text, kind: numeric ? 'number' as const : 'text' as const }
      }))
    },
    insert(table) {
      readable()
      if (!options.canWrite())
        throw new CsvOperationError('read-only')
      const original = workbook.save()
      const identity = nextIdentity(original, options.newId)
      const sheet = CSV_SHEET_COMMAND.prepare(csvWorksheet(table, identity))
      assertCsvSnapshot({ ...original, sheetOrder: [...original.sheetOrder, identity.id], sheets: { ...original.sheets, [identity.id]: sheet } })
      if (!CSV_SHEET_COMMAND.insert(univerAPI, workbook.getId(), sheet, original.sheetOrder.length))
        throw new CsvOperationError('insert-failed')
      // 插表已提交并入历史；激活失败只能报告视图错误，不能让调用方误以为可安全重复导入。
      try {
        workbook.setActiveSheet(identity.id)
      }
      catch (error) {
        options.reportError(error)
      }
      return identity.id
    },
  }
}

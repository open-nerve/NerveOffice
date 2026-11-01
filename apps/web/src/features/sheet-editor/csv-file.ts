import type { CsvTable } from '../../shared/csv/index.ts'

export interface CsvFile {
  readonly name: string
  readonly size: number
  readonly arrayBuffer: () => Promise<ArrayBuffer>
}

export interface CsvPreview {
  readonly rowCount: number
  readonly columnCount: number
  readonly rows: readonly (readonly string[])[]
}

/** React 只收到有界预览，完整矩阵继续属于发起操作的控制器。 */
export function csvPreview(table: CsvTable): CsvPreview {
  return {
    rowCount: table.rowCount,
    columnCount: table.columnCount,
    rows: table.rows.slice(0, 8).map(row => row.slice(0, 8).map(cell => cell.length <= 80 ? cell : `${cell.slice(0, 78)}…`)),
  }
}

// 实测用的大表（M3-P2 S5 的切换耗时与内存）：在新建表格的模板上生成，规模见 LARGE_SHEET。
// - "数据"表：第 1 行是表头；之下 1,000 行 × 20 列两位小数的数值（固定的伪随机序列，每次生成的字节相同），
//   第 21 列（U）每行一个 =SUM(A:T)，共 1,000 个公式；
// - "汇总"表：100 行，每行一个跨表的 =SUM('数据'!U…:U…)（10 行一组），共 100 个公式；
// - 公式都带缓存值（与保存过的文档一样：打开时 SDK 只算没有结果的公式），表头一个加粗的样式。
// 写库时换上文档自己的 unitId（与新建的模板相同，database.ts 的 SnapshotFor）。
import { sheetSnapshotFor } from '@nerve-office/contracts'

export const LARGE_SHEET = {
  /** 数据表的数据行数（不含表头）与数值的列数 */
  rows: 1_000,
  valueColumns: 20,
  /** 汇总表的行数：每行汇总数据表的 10 行 */
  summaryRows: 100,
  summaryGroup: 10,
} as const

/** 生成的规模：数值、公式、文字（表头与汇总表的标签）各多少个单元格 */
export interface LargeSheetScale {
  readonly numberCells: number
  readonly formulaCells: number
  readonly textCells: number
  readonly cells: number
}

interface Cell {
  v?: number | string
  t?: number
  f?: string
  s?: string
}

/** 单元格的值的类型（Univer 的 CellValueType）：1 文字，2 数值 */
const TEXT = 1
const NUMBER = 2

/** 从 0 开始的列号的字母写法（只用到 A–Z） */
function columnName(index: number): string {
  return String.fromCharCode(65 + index)
}

/** 固定种子的线性同余序列：两位小数的数值，0–999.99 */
function numbers(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return Math.round((state / 2_147_483_648) * 100_000) / 100
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

interface SheetData {
  id: string
  name: string
  rowCount: number
  columnCount: number
  cellData: Record<number, Record<number, Cell>>
  [key: string]: unknown
}

/** 大表的快照 JSON：模板换上 unitId，填上两张表 */
export function largeSheetFor(unitId: string): string {
  const workbook = JSON.parse(sheetSnapshotFor(unitId)) as { sheetOrder: string[], styles: Record<string, unknown>, sheets: Record<string, SheetData> }
  const template = workbook.sheets['sheet-1']
  if (template === undefined)
    throw new Error('模板里没有 sheet-1')
  const { rows, valueColumns, summaryRows, summaryGroup } = LARGE_SHEET
  workbook.styles = { header: { bl: 1 } }
  const next = numbers(20_261_004)
  const data: Record<number, Record<number, Cell>> = {}
  const header: Record<number, Cell> = {}
  for (let column = 0; column < valueColumns; column += 1)
    header[column] = { v: `指标${column + 1}`, t: TEXT, s: 'header' }
  header[valueColumns] = { v: '合计', t: TEXT, s: 'header' }
  data[0] = header
  const totals: number[] = []
  for (let row = 1; row <= rows; row += 1) {
    const cells: Record<number, Cell> = {}
    let total = 0
    for (let column = 0; column < valueColumns; column += 1) {
      const value = next()
      total += value
      cells[column] = { v: value, t: NUMBER }
    }
    totals.push(round2(total))
    cells[valueColumns] = { f: `=SUM(A${row + 1}:${columnName(valueColumns - 1)}${row + 1})`, v: round2(total), t: NUMBER }
    data[row] = cells
  }
  const totalColumn = columnName(valueColumns)
  const summary: Record<number, Record<number, Cell>> = {}
  for (let row = 0; row < summaryRows; row += 1) {
    const first = row * summaryGroup
    const value = round2(totals.slice(first, first + summaryGroup).reduce((sum, item) => sum + item, 0))
    summary[row] = {
      0: { v: `第 ${row + 1} 组`, t: TEXT },
      1: { f: `=SUM('数据'!${totalColumn}${first + 2}:${totalColumn}${first + summaryGroup + 1})`, v: value, t: NUMBER },
    }
  }
  workbook.sheets = {
    'sheet-1': { ...template, name: '数据', rowCount: rows + 100, columnCount: 26, cellData: data },
    'sheet-summary': { ...template, id: 'sheet-summary', name: '汇总', rowCount: summaryRows + 20, columnCount: 10, cellData: summary },
  }
  workbook.sheetOrder = ['sheet-1', 'sheet-summary']
  return JSON.stringify(workbook)
}

/** 数一数快照里的单元格：数值、公式、文字 */
export function largeSheetScale(snapshot: string): LargeSheetScale {
  const workbook = JSON.parse(snapshot) as { sheets: Record<string, { cellData: Record<string, Record<string, Cell>> }> }
  let numberCells = 0
  let formulaCells = 0
  let textCells = 0
  for (const sheet of Object.values(workbook.sheets)) {
    for (const row of Object.values(sheet.cellData)) {
      for (const cell of Object.values(row)) {
        if (cell.f !== undefined)
          formulaCells += 1
        else if (cell.t === TEXT)
          textCells += 1
        else
          numberCells += 1
      }
    }
  }
  return { numberCells, formulaCells, textCells, cells: numberCells + formulaCells + textCells }
}

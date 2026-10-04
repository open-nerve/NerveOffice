// 实测用的大表（large-sheet.ts）：规模、每次生成的字节相同、公式的缓存值与它们的计算一致、在快照的上限之内。
import { Buffer } from 'node:buffer'
import { SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { LARGE_SHEET, largeSheetFor, largeSheetScale } from './large-sheet.ts'

interface Cell {
  readonly v?: number | string
  readonly f?: string
}

interface Workbook {
  readonly id: string
  readonly sheetOrder: readonly string[]
  readonly sheets: Readonly<Record<string, { readonly name: string, readonly cellData: Readonly<Record<string, Readonly<Record<string, Cell>>>> }>>
}

describe('实测用的大表', () => {
  const snapshot = largeSheetFor('unit-1')
  const workbook = JSON.parse(snapshot) as Workbook

  it('规模：2 万个数值、1,100 个公式（每行一个求和 1,000 个、汇总表 100 个），表头与标签 121 个文字', () => {
    expect(largeSheetScale(snapshot)).toEqual({ numberCells: 20_000, formulaCells: 1_100, textCells: 121, cells: 21_221 })
    expect(workbook.sheetOrder).toEqual(['sheet-1', 'sheet-summary'])
    expect(Object.values(workbook.sheets).map(sheet => sheet.name)).toEqual(['数据', '汇总'])
  })

  it('每次生成的字节相同，只有 unitId 不同；在快照的上限之内', () => {
    expect(largeSheetFor('unit-1')).toBe(snapshot)
    expect(largeSheetFor('unit-2')).toBe(snapshot.replace('"unit-1"', '"unit-2"'))
    expect(workbook.id).toBe('unit-1')
    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(SNAPSHOT_MAX_RAW_BYTES)
  })

  it('公式的缓存值与它们的计算一致：每行的合计、汇总表的每一组', () => {
    const data = workbook.sheets['sheet-1']?.cellData ?? {}
    const totals: number[] = []
    for (let row = 1; row <= LARGE_SHEET.rows; row += 1) {
      const cells = data[row] ?? {}
      const sum = Array.from({ length: LARGE_SHEET.valueColumns }, (_, column) => Number(cells[column]?.v)).reduce((total, value) => total + value, 0)
      const formula = cells[LARGE_SHEET.valueColumns]
      expect(formula?.f).toBe(`=SUM(A${row + 1}:T${row + 1})`)
      expect(formula?.v).toBeCloseTo(sum, 6)
      totals.push(Number(formula?.v))
    }
    const summary = workbook.sheets['sheet-summary']?.cellData ?? {}
    expect(summary[0]?.[1]?.f).toBe('=SUM(\'数据\'!U2:U11)')
    expect(summary[99]?.[1]?.f).toBe('=SUM(\'数据\'!U992:U1001)')
    expect(summary[99]?.[1]?.v).toBeCloseTo(totals.slice(990).reduce((total, value) => total + value, 0), 6)
  })
})

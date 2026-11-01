import { describe, expect, it } from 'vitest'
import { csvCell, csvWorksheet } from './csv-worksheet.ts'

describe('CSV 显式单元格类型', () => {
  it.each([
    ['0', 0],
    ['-2', -2],
    ['0.125', 0.125],
    ['12.500', 12.5],
    ['999999999999999', 999999999999999],
    ['0.000000000000001', 1e-15],
  ])('可可靠表示的普通十进制 %s 作为数字', (input, value) => {
    expect(csvCell(input)).toEqual({ v: value, t: 2 })
  })

  it.each(['', '001', '2026-11-01', '1e3', '.5', '1.', '-0', ' 1', '1 ', '1\n', '1000000000000000', '0.1234567890123456', '=1+1', '+1', '-2+3', '@x', '＝1', '\t=1', '😀'])('其余 %j 保留为显式文本，无公式字段', (value) => {
    expect(csvCell(value)).toEqual({ v: value, t: 1 })
  })

  it('非零下溢到 0、次正规数的有效数字丢失不自动转数值', () => {
    const underflow = `0.${'0'.repeat(400)}1`
    const subnormal = `0.${'0'.repeat(323)}5123456789`
    expect(csvCell(underflow)).toEqual({ v: underflow, t: 1 })
    expect(csvCell(subnormal)).toEqual({ v: subnormal, t: 1 })
    expect(csvCell(`0.${'0'.repeat(299)}1`)).toEqual({ v: 1e-300, t: 2 })
  })

  it('字段超长和 NUL 拒绝，不靠 SDK 截断', () => {
    expect(() => csvCell('x'.repeat(32_768))).toThrow(expect.objectContaining({ reason: 'field' }))
    expect(() => csvCell('x\0y')).toThrow(expect.objectContaining({ reason: 'syntax' }))
  })
})

describe('CSV 工作表候选', () => {
  const identity = { id: 'csv-1', name: 'CSV导入' }

  it('一次构造完整显式数据，保留空字段，不修改传入矩阵', () => {
    const rows = Object.freeze([Object.freeze(['-2', '=1+1']), Object.freeze(['001', ''])])
    const sheet = csvWorksheet({ rows, rowCount: 2, columnCount: 2 }, identity)
    expect(sheet).toMatchObject({
      id: 'csv-1',
      name: 'CSV导入',
      rowCount: 1000,
      columnCount: 20,
      cellData: { 0: { 0: { v: -2, t: 2 }, 1: { v: '=1+1', t: 1 } }, 1: { 0: { v: '001', t: 1 }, 1: { v: '', t: 1 } } },
    })
    expect(sheet.cellData?.[0]?.[1]).toEqual({ v: '=1+1', t: 1 })
    expect(rows).toEqual([['-2', '=1+1'], ['001', '']])
  })

  it('超过默认网格时扩展行列，不裁掉输入', () => {
    const rows = Array.from({ length: 1001 }, () => Array.from({ length: 21 }).fill('x') as string[])
    const sheet = csvWorksheet({ rows, rowCount: 1001, columnCount: 21 }, identity)
    expect(sheet.rowCount).toBe(1001)
    expect(sheet.columnCount).toBe(21)
    expect(sheet.cellData?.[1000]?.[20]).toEqual({ v: 'x', t: 1 })
  })

  it.each([
    { table: { rows: [], rowCount: 0, columnCount: 0 }, reason: 'empty' },
    { table: { rows: [['x']], rowCount: 2, columnCount: 1 }, reason: 'syntax' },
    { table: { rows: [['x'], ['y', 'z']], rowCount: 2, columnCount: 2 }, reason: 'syntax' },
  ])('不相信错误的矩阵统计 %j', ({ table, reason }) => {
    expect(() => csvWorksheet(table, identity)).toThrow(expect.objectContaining({ reason }))
  })

  it('超过 CSV 行列或矩形预算的候选在进入 SDK 前拒绝', () => {
    expect(() => csvWorksheet({ rows: Array.from({ length: 50_001 }, () => ['']), rowCount: 50_001, columnCount: 1 }, identity)).toThrow(expect.objectContaining({ reason: 'rows' }))
    const row = Array.from({ length: 1_025 }).fill('') as string[]
    expect(() => csvWorksheet({ rows: [row], rowCount: 1, columnCount: 1_025 }, identity)).toThrow(expect.objectContaining({ reason: 'columns' }))
    const rows = Array.from({ length: 1001 }, () => Array.from({ length: 100 }).fill('') as string[])
    expect(() => csvWorksheet({ rows, rowCount: 1001, columnCount: 100 }, identity)).toThrow(expect.objectContaining({ reason: 'cells' }))
  })
})

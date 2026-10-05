// 捕获时机复核的样本（capture-samples.ts）：公式样本的结构、按定义的核对认得出过期的值、大表的规模
import type { SampleCells } from './capture-samples.ts'
import { describe, expect, it } from 'vitest'
import { aggregateValues, BIG_SHEET, bigSheet, cellCount, FORMULA_SAMPLE, formulaSampleSheets, randOf, verifyFormulaSnapshot } from './capture-samples.ts'

/** 公式样本的快照，公式都按定义填上值（核对应当全部一致）；edit 可以在填值之前改输入 */
function computedSnapshot(edit: (sheets: Record<string, SampleCells>) => void = () => {}): Record<string, { cellData: SampleCells }> {
  const sheets = Object.fromEntries(formulaSampleSheets().map(sheet => [sheet.id, structuredClone(sheet.cellData)]))
  edit(sheets)
  const { chain, aggregate, cross, slow, volatile } = FORMULA_SAMPLE
  const cells = (id: string): SampleCells => sheets[id] ?? {}
  const start = cells(chain.id)[0]?.[0]?.v as number
  for (let row = 1; row < chain.length; row += 1)
    Object.assign(cells(chain.id)[row]?.[0] ?? {}, { v: start + row, t: 2 })
  const values = Array.from({ length: aggregate.rows }, (_, row) => cells(aggregate.id)[row]?.[1]?.v as number)
  const sum = values.reduce((total, value) => total + value, 0)
  ;[sum, sum / values.length, values.filter(value => value > 500).length, Math.max(...values)].forEach((value, row) => {
    Object.assign(cells(aggregate.id)[row]?.[2] ?? {}, { v: value, t: 2 })
  })
  ;[(start + chain.length - 1) * 2, sum + start, sum - (values[0] ?? 0)].forEach((value, row) => {
    Object.assign(cells(cross.id)[row]?.[0] ?? {}, { v: value, t: 2 })
  })
  for (let index = 0; index < slow.count; index += 1)
    Object.assign(cells(slow.id)[index]?.[0] ?? {}, { v: values.filter(value => value > index * slow.step).reduce((total, value) => total + value, 0), t: 2 })
  ;[46000.5, 46000, 0.25, 4242, 0.5].forEach((value, row) => {
    Object.assign(cells(volatile.id)[row]?.[0] ?? {}, { v: value, t: 2 })
  })
  return Object.fromEntries(Object.entries(sheets).map(([id, cellData]) => [id, { cellData }]))
}

function text(sheets: Record<string, { cellData: SampleCells }>): string {
  return JSON.stringify({ id: 'unit-1', sheets })
}

describe('公式样本（M0-P3 V07 的 formula-scenarios，按自检的时限缩放）', () => {
  it('五张表：链 200 层、聚合 1 万行与 4 个聚合公式、跨表 3 个、SUMPRODUCT 100 个、易变 5 个；公式都不带缓存值', () => {
    const sheets = formulaSampleSheets()
    expect(sheets.map(sheet => [sheet.id, sheet.name])).toEqual([['f-chain', '链'], ['f-aggregate', '聚合'], ['f-cross', '跨表'], ['f-slow', '慢'], ['f-volatile', '易变']])
    const formulas = sheets.flatMap(sheet => Object.values(sheet.cellData).flatMap(row => Object.values(row))).filter(cell => cell.f !== undefined)
    expect(formulas).toHaveLength(199 + 4 + 3 + 100 + 5)
    expect(formulas.every(cell => cell.v === undefined)).toBe(true)
    const slow = sheets.find(sheet => sheet.id === 'f-slow')?.cellData
    expect(slow?.[3]?.[0]?.f).toBe('=SUMPRODUCT((\'聚合\'!$B$1:$B$10000>30)*\'聚合\'!$B$1:$B$10000)')
    expect(sheets.find(sheet => sheet.id === 'f-cross')?.cellData[1]?.[0]?.f).toBe('=SUM(\'聚合\'!B1:B10000)+\'链\'!A1')
  })

  it('聚合的值是 0–1000 的整数，每次生成的相同', () => {
    const values = aggregateValues()
    expect(values).toHaveLength(10_000)
    expect(values.every(value => Number.isInteger(value) && value >= 0 && value <= 1000)).toBe(true)
    expect(aggregateValues()).toEqual(values)
  })
})

describe('按定义核对公式的值（verifyFormulaSnapshot）', () => {
  it('值都按定义算出时全部一致', () => {
    const verdict = verifyFormulaSnapshot(text(computedSnapshot()))
    expect(verdict).toEqual({ checked: 311, stale: [], staleCount: 0, byKind: { chain: '0/199', aggregate: '0/4', cross: '0/3', slow: '0/100', volatile: '0/5' } })
  })

  it('改了输入、公式还是旧值：认出过期的（链!A1 改了，链与依赖它的跨表都过期；最多列出 limit 个）', () => {
    const sheets = computedSnapshot()
    const chain = sheets[FORMULA_SAMPLE.chain.id]?.cellData
    if (chain?.[0]?.[0] !== undefined)
      chain[0][0].v = 7
    const verdict = verifyFormulaSnapshot(text(sheets), 3)
    expect(verdict.staleCount).toBe(199 + 2)
    expect(verdict.stale).toEqual(['链!A2', '链!A3', '链!A4'])
    expect(verdict.byKind).toMatchObject({ chain: '199/199', cross: '2/3', aggregate: '0/4', slow: '0/100' })
  })

  it('聚合的一格改了：聚合、跨表与 SUMPRODUCT 都按新的输入核对', () => {
    const fresh = verifyFormulaSnapshot(text(computedSnapshot((cells) => {
      const row = cells[FORMULA_SAMPLE.aggregate.id]?.[0]
      if (row?.[1] !== undefined)
        row[1].v = 999
    })))
    expect(fresh.staleCount).toBe(0)
    // B1 是 11（固定的种子）：改成 611 之后 SUM、AVERAGE、COUNTIF（越过 500）变了，MAX 不变；跨表 A2 变了，A3 = C1 − B1 恰好不变；
    // 阈值在 611 以下的 62 个 SUMPRODUCT 变了
    const stale = computedSnapshot()
    const row = stale[FORMULA_SAMPLE.aggregate.id]?.cellData[0]
    expect(row?.[1]?.v).toBe(11)
    if (row?.[1] !== undefined)
      row[1].v = 611
    expect(verifyFormulaSnapshot(text(stale)).byKind).toMatchObject({ aggregate: '3/4', cross: '1/3', slow: '62/100' })
  })

  it('易变函数只核对内部一致：A5 ≠ A3 × 2、RAND 超出范围、没有值都算错', () => {
    const sheets = computedSnapshot()
    const volatile = sheets[FORMULA_SAMPLE.volatile.id]?.cellData
    if (volatile?.[4]?.[0] !== undefined)
      volatile[4][0].v = 0.7
    if (volatile?.[3]?.[0] !== undefined)
      delete volatile[3][0].v
    expect(verifyFormulaSnapshot(text(sheets)).byKind.volatile).toBe('2/5')
    expect(randOf(text(sheets))).toBe(0.25)
  })

  it('公式的值缺了（还没算出来）也算过期', () => {
    const verdict = verifyFormulaSnapshot(text(Object.fromEntries(formulaSampleSheets().map(sheet => [sheet.id, { cellData: sheet.cellData }]))))
    expect(verdict.staleCount).toBe(verdict.checked)
  })
})

describe('大表', () => {
  it('5 万行一列文字（5 万格），工作表 26 列', () => {
    const sheet = bigSheet()
    expect([sheet.id, sheet.name, sheet.columnCount, sheet.rowCount]).toEqual([BIG_SHEET.id, '大表', 26, 50_100])
    expect(sheet.cellData[49_999]?.[0]).toEqual({ v: '第 50000 行', t: 1 })
    expect(cellCount(JSON.stringify({ sheets: { [sheet.id]: { cellData: sheet.cellData } } }), sheet.id)).toBe(50_000)
    expect(cellCount('{"sheets":{}}', 'none')).toBe(0)
  })
})

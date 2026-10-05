// 捕获时机复核的样本（capture-samples.ts）：公式样本的结构、按定义的核对认得出过期的值、大表的规模
import type { FormulaSample, SampleCells } from './capture-samples.ts'
import { describe, expect, it } from 'vitest'
import { aggregateValues, BIG_SHEET, bigSheet, cellCount, FORMULA_SAMPLE, formulaSampleSheets, randOf, verifyFormulaSnapshot } from './capture-samples.ts'

/** 公式样本的快照，公式都按定义填上值（核对应当全部一致）；edit 可以在填值之前改输入 */
function computedSnapshot(edit: (sheets: Record<string, SampleCells>) => void = () => {}, sample: FormulaSample = FORMULA_SAMPLE): Record<string, { cellData: SampleCells }> {
  const sheets = Object.fromEntries(formulaSampleSheets(sample).map(sheet => [sheet.id, structuredClone(sheet.cellData)]))
  edit(sheets)
  const { chain, aggregate, cross, slow, volatile, heavy } = sample
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
  const heavyData = Array.from({ length: heavy.rows }, (_, row) => cells(heavy.id)[row]?.[0]?.v as number)
  for (let index = 0; index < heavy.count; index += 1)
    Object.assign(cells(heavy.id)[index]?.[2] ?? {}, { v: heavyData.filter(value => value > index * heavy.step).reduce((total, value) => total + value, 0), t: 2 })
  ;[46000.5, 46000, 0.25, 4242, 0.5].forEach((value, row) => {
    Object.assign(cells(volatile.id)[row]?.[0] ?? {}, { v: value, t: 2 })
  })
  return Object.fromEntries(Object.entries(sheets).map(([id, cellData]) => [id, { cellData }]))
}

function text(sheets: Record<string, { cellData: SampleCells }>): string {
  return JSON.stringify({ id: 'unit-1', sheets })
}

describe('公式样本（M0-P3 V07 的 formula-scenarios，按自检的时限缩放）', () => {
  it('六张表：链 200 层、聚合 1 万行与 4 个聚合公式、跨表 3 个、SUMPRODUCT 100 个、易变 5 个（都不带缓存值）；"重"表 500 个带缓存值的 SUMPRODUCT', () => {
    const sheets = formulaSampleSheets()
    expect(sheets.map(sheet => [sheet.id, sheet.name])).toEqual([['f-chain', '链'], ['f-aggregate', '聚合'], ['f-cross', '跨表'], ['f-slow', '慢'], ['f-volatile', '易变'], ['f-heavy', '重']])
    const formulasOf = (sheetIds: readonly string[]) => sheets.filter(sheet => sheetIds.includes(sheet.id)).flatMap(sheet => Object.values(sheet.cellData).flatMap(row => Object.values(row))).filter(cell => cell.f !== undefined)
    const uncached = formulasOf(['f-chain', 'f-aggregate', 'f-cross', 'f-slow', 'f-volatile'])
    expect(uncached).toHaveLength(199 + 4 + 3 + 100 + 5)
    expect(uncached.every(cell => cell.v === undefined)).toBe(true)
    const heavy = formulasOf(['f-heavy'])
    expect(heavy).toHaveLength(500)
    expect(heavy.every(cell => typeof cell.v === 'number')).toBe(true)
    // 带的缓存值就是按定义算出的
    expect(verifyFormulaSnapshot(JSON.stringify({ sheets: Object.fromEntries(sheets.map(sheet => [sheet.id, { cellData: sheet.cellData }])) })).byKind.heavy).toBe('0/500')
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
    expect(verdict).toEqual({ checked: 811, stale: [], staleCount: 0, byKind: { chain: '0/199', aggregate: '0/4', cross: '0/3', slow: '0/100', volatile: '0/5', heavy: '0/500' }, errors: {} })
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

  it('公式的值缺了（还没算出来）也算过期（"重"表带着缓存值，是对的）', () => {
    const verdict = verifyFormulaSnapshot(text(Object.fromEntries(formulaSampleSheets().map(sheet => [sheet.id, { cellData: sheet.cellData }]))))
    expect(verdict.staleCount).toBe(verdict.checked - 500)
  })

  it('错了的格里不是数的值按写法计数（例如重建之后命中坏掉的语法树时的 #NAME?）', () => {
    const sheets = computedSnapshot()
    const slow = sheets[FORMULA_SAMPLE.slow.id]?.cellData
    const heavy = sheets[FORMULA_SAMPLE.heavy.id]?.cellData
    for (const cell of [slow?.[0]?.[0], slow?.[1]?.[0], heavy?.[7]?.[2]])
      Object.assign(cell ?? {}, { v: '#NAME?', t: 1 })
    const verdict = verifyFormulaSnapshot(text(sheets))
    expect([verdict.staleCount, verdict.errors, verdict.byKind.slow, verdict.byKind.heavy]).toEqual([3, { '#NAME?': 3 }, '2/100', '1/500'])
  })
})

describe('另给的规模（US-M3-03 的 E2E 用更小的一份）', () => {
  const SMALL: FormulaSample = {
    ...FORMULA_SAMPLE,
    chain: { ...FORMULA_SAMPLE.chain, length: 20 },
    aggregate: { ...FORMULA_SAMPLE.aggregate, rows: 300 },
    slow: { ...FORMULA_SAMPLE.slow, count: 12, step: 80 },
    heavy: { ...FORMULA_SAMPLE.heavy, rows: 0, count: 0 },
  }

  it('表与公式的个数随规模变，"重"表的公式个数为 0 时不生成；聚合的值是同一串的前面几个；范围按行数写', () => {
    const sheets = formulaSampleSheets(SMALL)
    expect(sheets.map(sheet => sheet.id)).toEqual(['f-chain', 'f-aggregate', 'f-cross', 'f-slow', 'f-volatile'])
    const formulas = sheets.flatMap(sheet => Object.values(sheet.cellData).flatMap(row => Object.values(row))).filter(cell => cell.f !== undefined)
    expect(formulas).toHaveLength(19 + 4 + 3 + 12 + 5)
    expect(aggregateValues(300)).toEqual(aggregateValues().slice(0, 300))
    expect(sheets.find(sheet => sheet.id === 'f-slow')?.cellData[2]?.[0]?.f).toBe('=SUMPRODUCT((\'聚合\'!$B$1:$B$300>160)*\'聚合\'!$B$1:$B$300)')
    expect(sheets.find(sheet => sheet.id === 'f-cross')?.cellData[0]?.[0]?.f).toBe('=\'链\'!A20*2')
  })

  it('按同一个规模核对：算对的全部一致；改了聚合的一格、公式还是旧值时认出过期的；按默认的规模核对对不上', () => {
    expect(verifyFormulaSnapshot(text(computedSnapshot(() => {}, SMALL)), 8, SMALL)).toEqual({
      checked: 19 + 4 + 3 + 12 + 5,
      stale: [],
      staleCount: 0,
      byKind: { chain: '0/19', aggregate: '0/4', cross: '0/3', slow: '0/12', volatile: '0/5', heavy: '0/0' },
      errors: {},
    })
    const stale = computedSnapshot(() => {}, SMALL)
    const row = stale[SMALL.aggregate.id]?.cellData[0]
    expect(row?.[1]?.v).toBe(11)
    if (row?.[1] !== undefined)
      row[1].v = 1000
    // B1 是 11、300 个里最大的是 995：改成 1000 之后 SUM、AVERAGE、COUNTIF、MAX 都变了；跨表 A2 变了（A3 = C1 − B1 恰好不变）；12 个 SUMPRODUCT 都变了
    expect(verifyFormulaSnapshot(text(stale), 8, SMALL).byKind).toMatchObject({ aggregate: '4/4', cross: '1/3', slow: '12/12' })
    expect(verifyFormulaSnapshot(text(computedSnapshot(() => {}, SMALL))).staleCount).toBeGreaterThan(0)
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

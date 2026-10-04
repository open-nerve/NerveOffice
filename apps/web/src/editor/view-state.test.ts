import type { IRange } from '@univerjs/core'
import type { SheetArea, SheetViewState, ViewWorkbook } from './view-state.ts'
import { describe, expect, it, vi } from 'vitest'
import { readViewState, restoreViewState } from './view-state.ts'

/** 一张假的工作表：记下设过的选区、当前单元格与滚动；merges 是这张表现在的合并区 */
interface FakeSheet {
  readonly id: string
  hidden: boolean
  maxRows: number
  maxColumns: number
  scroll: { sheetViewStartRow: number, sheetViewStartColumn: number }
  freeze: { xSplit: number, ySplit: number }
  merges: IRange[]
  readonly activated: IRange[]
  readonly currentCells: IRange[]
  readonly scrolledTo: [number, number][]
  /** 让这几个 Facade 方法意外出错（核对报告与"其余各步照常"） */
  failing?: { activate?: Error, scrollToCell?: Error }
}

function area(startRow: number, startColumn: number, endRow = startRow, endColumn = startColumn, rangeType?: number): SheetArea {
  return { startRow, endRow, startColumn, endColumn, rangeType }
}

const sameArea = (a: IRange, b: IRange): boolean => a.startRow === b.startRow && a.endRow === b.endRow && a.startColumn === b.startColumn && a.endColumn === b.endColumn
const contains = (outer: IRange, row: number, column: number): boolean => outer.startRow <= row && row <= outer.endRow && outer.startColumn <= column && column <= outer.endColumn
const overlaps = (a: IRange, b: IRange): boolean => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/**
 * 假的 Facade：FWorkbook、FWorksheet 与 FRange 里用到的方法。合并的判断照 SDK：isMerged 是恰好一个合并区，isPartOfMerge 是与合并区相交；
 * activateAsCurrentCell 按左上角所在的合并区判断，不是"没有合并的单元格"或"恰好那个合并区"时抛出与 SDK 相同的错误
 * （sheets 的 facade/f-range.ts）——去掉 view-state.ts 里的核对，合并布局变了的用例就会报告错误、结果 failed
 */
function fakeWorkbook(sheets: FakeSheet[], options: { activeId?: string, range?: SheetArea, current?: SheetArea } = {}) {
  let activeId = options.activeId ?? sheets[0]?.id ?? ''
  const switched: string[] = []
  const facadeRange = (sheet: FakeSheet, range: IRange) => ({
    getRange: () => range,
    isMerged: () => sheet.merges.some(merge => sameArea(merge, range)),
    isPartOfMerge: () => sheet.merges.some(merge => overlaps(merge, range)),
    activate: () => {
      if (sheet.failing?.activate !== undefined)
        throw sheet.failing.activate
      sheet.activated.push(range)
    },
    activateAsCurrentCell: () => {
      const merge = sheet.merges.find(item => contains(item, range.startRow, range.startColumn))
      const single = range.startRow === range.endRow && range.startColumn === range.endColumn
      if (merge === undefined ? !single : !sameArea(merge, range))
        throw new Error('The range is not a single cell')
      sheet.currentCells.push(range)
    },
  })
  const facadeSheet = (sheet: FakeSheet) => ({
    getSheetId: () => sheet.id,
    isSheetHidden: () => sheet.hidden,
    getMaxRows: () => sheet.maxRows,
    getMaxColumns: () => sheet.maxColumns,
    getScrollState: () => ({ ...sheet.scroll, offsetX: 3, offsetY: 4 }),
    getFreeze: () => ({ ...sheet.freeze, startRow: -1, startColumn: -1 }),
    getRange: (range: IRange) => facadeRange(sheet, range),
    scrollToCell: (row: number, column: number) => {
      if (sheet.failing?.scrollToCell !== undefined)
        throw sheet.failing.scrollToCell
      sheet.scrolledTo.push([row, column])
    },
  })
  const byId = (id: string) => sheets.find(sheet => sheet.id === id)
  const workbook = {
    getActiveSheet: () => facadeSheet(byId(activeId) ?? sheets[0] as FakeSheet),
    getSheetBySheetId: (id: string) => {
      const sheet = byId(id)
      return sheet === undefined ? null : facadeSheet(sheet)
    },
    setActiveSheet: (sheet: { getSheetId: () => string }) => {
      activeId = sheet.getSheetId()
      switched.push(activeId)
      return sheet
    },
    getActiveRange: () => options.range === undefined ? null : { getRange: () => options.range },
    getActiveCell: () => options.current === undefined ? null : { getRange: () => options.current },
  } as unknown as ViewWorkbook
  return { workbook, switched, active: () => activeId }
}

function sheet(id: string, overrides: Partial<FakeSheet> = {}): FakeSheet {
  return { id, hidden: false, maxRows: 1000, maxColumns: 20, scroll: { sheetViewStartRow: 0, sheetViewStartColumn: 0 }, freeze: { xSplit: 0, ySplit: 0 }, merges: [], activated: [], currentCells: [], scrolledTo: [], ...overrides }
}

describe('视图状态的取出（M3-P2 设计 §3.3）', () => {
  it('当前工作表、主视口里看到的第一行与第一列（滚动位置加上冻结的行列）、主选区与当前单元格', () => {
    const data = sheet('s2', { scroll: { sheetViewStartRow: 40, sheetViewStartColumn: 3 }, freeze: { xSplit: 1, ySplit: 2 } })
    const { workbook } = fakeWorkbook([sheet('s1'), data], { activeId: 's2', range: area(5, 1, 9, 3, 0), current: area(6, 2) })
    expect(readViewState(workbook, vi.fn())).toEqual({
      sheetId: 's2',
      topLeft: { row: 42, column: 4 },
      selection: { range: area(5, 1, 9, 3, 0), current: area(6, 2) },
    })
  })

  it('没有选区：只有工作表与滚动', () => {
    const { workbook } = fakeWorkbook([sheet('s1', { scroll: { sheetViewStartRow: 7, sheetViewStartColumn: 0 } })])
    expect(readViewState(workbook, vi.fn())).toEqual({ sheetId: 's1', topLeft: { row: 7, column: 0 }, selection: undefined })
  })

  it('Facade 出错：报告（原因是 Facade 的错误），没有视图状态（重建之后是默认视图）', () => {
    const report = vi.fn()
    const failure = new Error('boom')
    const workbook = { getActiveSheet: () => {
      throw failure
    } } as unknown as ViewWorkbook
    expect(readViewState(workbook, report)).toBeUndefined()
    expect(report).toHaveBeenCalledOnce()
    expect((report.mock.calls[0]?.[0] as Error).cause).toBe(failure)
  })
})

describe('视图状态的恢复（M3-P2 设计 §3.3）', () => {
  const STATE: SheetViewState = { sheetId: 's2', topLeft: { row: 42, column: 4 }, selection: { range: area(5, 1, 9, 3, 1), current: area(6, 2) } }

  it('切到那张表，设主选区（带整行、整列的类型）与当前单元格，最后滚到原来的左上角', () => {
    const s2 = sheet('s2')
    const { workbook, switched, active } = fakeWorkbook([sheet('s1'), s2])
    expect(restoreViewState(workbook, STATE, vi.fn())).toBe('restored')
    expect(switched).toEqual(['s2'])
    expect(active()).toBe('s2')
    expect(s2.activated).toEqual([{ startRow: 5, endRow: 9, startColumn: 1, endColumn: 3, rangeType: 1, sheetId: 's2' }])
    expect(s2.currentCells).toEqual([{ startRow: 6, endRow: 6, startColumn: 2, endColumn: 2, sheetId: 's2' }])
    expect(s2.scrolledTo).toEqual([[42, 4]])
  })

  it('本来就在那张表：不切换', () => {
    const { workbook, switched } = fakeWorkbook([sheet('s2')], { activeId: 's2' })
    expect(restoreViewState(workbook, STATE, vi.fn())).toBe('restored')
    expect(switched).toEqual([])
  })

  it('那张表已经不在、或者被隐藏了：什么也不做，不报告（预期之内，回到默认视图）', () => {
    const report = vi.fn()
    const missing = fakeWorkbook([sheet('s1')])
    expect(restoreViewState(missing.workbook, STATE, report)).toBe('sheet-missing')
    expect(missing.switched).toEqual([])
    const hidden = sheet('s2', { hidden: true })
    const hiddenBook = fakeWorkbook([sheet('s1'), hidden])
    expect(restoreViewState(hiddenBook.workbook, STATE, report)).toBe('sheet-missing')
    expect([hiddenBook.switched, hidden.activated, hidden.scrolledTo]).toEqual([[], [], []])
    expect(report).not.toHaveBeenCalled()
  })

  it('选区落在现在的行列之外（行列被删掉了）：不设选区，照常滚动；滚动按现在的行列收住', () => {
    const small = sheet('s2', { maxRows: 8, maxColumns: 3 })
    const { workbook } = fakeWorkbook([small], { activeId: 's2' })
    expect(restoreViewState(workbook, STATE, vi.fn())).toBe('restored')
    expect([small.activated, small.currentCells]).toEqual([[], []])
    expect(small.scrolledTo).toEqual([[7, 2]])
  })

  it('没有选区：只切表与滚动', () => {
    const s2 = sheet('s2')
    const { workbook } = fakeWorkbook([s2], { activeId: 's2' })
    expect(restoreViewState(workbook, { ...STATE, selection: undefined }, vi.fn())).toBe('restored')
    expect([s2.activated, s2.scrolledTo]).toEqual([[], [[42, 4]]])
  })

  it('切换工作表时 Facade 出错：报告，停在那一步（编辑器照常可用）', () => {
    const report = vi.fn()
    const workbook = { getSheetBySheetId: () => {
      throw new Error('boom')
    } } as unknown as ViewWorkbook
    expect(restoreViewState(workbook, STATE, report)).toBe('failed')
    expect(report).toHaveBeenCalledOnce()
  })
})

describe('视图状态的恢复：按新内容重建之后合并的布局变了（M3-P2 复核 B1）', () => {
  /** 本页记下的：第 41 行在左上角，选中 B45（从 0 开始是第 44 行、第 1 列），当前单元格就是它 */
  const SINGLE: SheetViewState = { sheetId: 's1', topLeft: { row: 40, column: 0 }, selection: { range: area(44, 1, 44, 1, 0), current: area(44, 1, 44, 1, 0) } }
  /** 本页记下的：当前单元格是合并区 B45:C46（getActiveCell 给出整个合并区），选区是 B45 */
  const MERGED: SheetViewState = { sheetId: 's1', topLeft: { row: 40, column: 0 }, selection: { range: area(44, 1, 44, 1, 0), current: area(44, 1, 45, 2, 0) } }
  const B45_C46: IRange = { startRow: 44, endRow: 45, startColumn: 1, endColumn: 2 }

  it('记下的是单格，别人合并了它所在的格子（现在落进合并区）：设选区、不设当前单元格（落在选区的左上角），照常滚动，不报告', () => {
    const report = vi.fn()
    const s1 = sheet('s1', { merges: [B45_C46] })
    const { workbook } = fakeWorkbook([s1], { activeId: 's1' })
    expect(restoreViewState(workbook, SINGLE, report)).toBe('restored')
    expect(s1.activated).toEqual([{ startRow: 44, endRow: 44, startColumn: 1, endColumn: 1, rangeType: 0, sheetId: 's1' }])
    expect(s1.currentCells).toEqual([])
    expect(s1.scrolledTo).toEqual([[40, 0]])
    expect(report).not.toHaveBeenCalled()
  })

  it('记下的是合并区，别人取消了合并（现在不是合并区）：同样只设选区、照常滚动，不报告', () => {
    const report = vi.fn()
    const s1 = sheet('s1')
    const { workbook } = fakeWorkbook([s1], { activeId: 's1' })
    expect(restoreViewState(workbook, MERGED, report)).toBe('restored')
    expect([s1.activated.length, s1.currentCells, s1.scrolledTo]).toEqual([1, [], [[40, 0]]])
    expect(report).not.toHaveBeenCalled()
  })

  it('记下的是合并区，合并改成了另一个范围（B45:D46）：不设当前单元格，不报告', () => {
    const report = vi.fn()
    const s1 = sheet('s1', { merges: [{ startRow: 44, endRow: 45, startColumn: 1, endColumn: 3 }] })
    const { workbook } = fakeWorkbook([s1], { activeId: 's1' })
    expect(restoreViewState(workbook, MERGED, report)).toBe('restored')
    expect([s1.currentCells, s1.scrolledTo]).toEqual([[], [[40, 0]]])
    expect(report).not.toHaveBeenCalled()
  })

  it('合并的布局没变：合并区仍是那个合并区、单格仍没有合并（别处有合并不相干），照常设当前单元格', () => {
    const merged = sheet('s1', { merges: [B45_C46] })
    expect(restoreViewState(fakeWorkbook([merged], { activeId: 's1' }).workbook, MERGED, vi.fn())).toBe('restored')
    expect(merged.currentCells).toEqual([{ startRow: 44, endRow: 45, startColumn: 1, endColumn: 2, rangeType: 0, sheetId: 's1' }])
    const single = sheet('s1', { merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }] })
    expect(restoreViewState(fakeWorkbook([single], { activeId: 's1' }).workbook, SINGLE, vi.fn())).toBe('restored')
    expect(single.currentCells).toEqual([{ startRow: 44, endRow: 44, startColumn: 1, endColumn: 1, rangeType: 0, sheetId: 's1' }])
  })

  it('设选区时 Facade 意外出错：报告（原因是 Facade 的错误），照样滚动到原来的左上角，结果 failed', () => {
    const report = vi.fn()
    const failure = new Error('boom')
    const s1 = sheet('s1', { failing: { activate: failure } })
    const { workbook } = fakeWorkbook([s1], { activeId: 's1' })
    expect(restoreViewState(workbook, SINGLE, report)).toBe('failed')
    expect(report).toHaveBeenCalledOnce()
    expect((report.mock.calls[0]?.[0] as Error).cause).toBe(failure)
    expect(s1.scrolledTo).toEqual([[40, 0]])
  })

  it('滚动时 Facade 意外出错：报告，选区与当前单元格照常设上，结果 failed', () => {
    const report = vi.fn()
    const s1 = sheet('s1', { failing: { scrollToCell: new Error('boom') } })
    const { workbook } = fakeWorkbook([s1], { activeId: 's1' })
    expect(restoreViewState(workbook, SINGLE, report)).toBe('failed')
    expect(report).toHaveBeenCalledOnce()
    expect([s1.activated.length, s1.currentCells.length]).toEqual([1, 1])
  })
})

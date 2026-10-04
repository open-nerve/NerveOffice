import type { IRange } from '@univerjs/core'
import type { SheetArea, SheetViewState, ViewWorkbook } from './view-state.ts'
import { describe, expect, it, vi } from 'vitest'
import { readViewState, restoreViewState } from './view-state.ts'

/** 一张假的工作表：记下设过的选区、当前单元格与滚动 */
interface FakeSheet {
  readonly id: string
  hidden: boolean
  maxRows: number
  maxColumns: number
  scroll: { sheetViewStartRow: number, sheetViewStartColumn: number }
  freeze: { xSplit: number, ySplit: number }
  readonly activated: IRange[]
  readonly currentCells: IRange[]
  readonly scrolledTo: [number, number][]
}

function area(startRow: number, startColumn: number, endRow = startRow, endColumn = startColumn, rangeType?: number): SheetArea {
  return { startRow, endRow, startColumn, endColumn, rangeType }
}

/** 假的 Facade：FWorkbook、FWorksheet 与 FRange 里用到的方法 */
function fakeWorkbook(sheets: FakeSheet[], options: { activeId?: string, range?: SheetArea, current?: SheetArea } = {}) {
  let activeId = options.activeId ?? sheets[0]?.id ?? ''
  const switched: string[] = []
  const facadeRange = (sheet: FakeSheet, range: IRange) => ({
    getRange: () => range,
    activate: () => sheet.activated.push(range),
    activateAsCurrentCell: () => sheet.currentCells.push(range),
  })
  const facadeSheet = (sheet: FakeSheet) => ({
    getSheetId: () => sheet.id,
    isSheetHidden: () => sheet.hidden,
    getMaxRows: () => sheet.maxRows,
    getMaxColumns: () => sheet.maxColumns,
    getScrollState: () => ({ ...sheet.scroll, offsetX: 3, offsetY: 4 }),
    getFreeze: () => ({ ...sheet.freeze, startRow: -1, startColumn: -1 }),
    getRange: (range: IRange) => facadeRange(sheet, range),
    scrollToCell: (row: number, column: number) => sheet.scrolledTo.push([row, column]),
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
  return { id, hidden: false, maxRows: 1000, maxColumns: 20, scroll: { sheetViewStartRow: 0, sheetViewStartColumn: 0 }, freeze: { xSplit: 0, ySplit: 0 }, activated: [], currentCells: [], scrolledTo: [], ...overrides }
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

  it('Facade 出错：报告，停在那一步（编辑器照常可用）', () => {
    const report = vi.fn()
    const workbook = { getSheetBySheetId: () => {
      throw new Error('boom')
    } } as unknown as ViewWorkbook
    expect(restoreViewState(workbook, STATE, report)).toBe('failed')
    expect(report).toHaveBeenCalledOnce()
  })
})

import type { IWorkbookData } from '@univerjs/core'
import type { ISetArrayFormulaDataMutationParams } from '@univerjs/engine-formula'
import { CellValueType } from '@univerjs/core'
import { SetArrayFormulaDataMutation } from '@univerjs/engine-formula'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { csvBook, csvFixture } from './csv/csv.test-support.ts'
import { captureWorkbookData, withoutArrayAnchorValues } from './snapshot-capture-form.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function book(): IWorkbookData {
  const snapshot = csvBook()
  const sheet = snapshot.sheets['sheet-1']!
  sheet.cellData = {
    0: {
      0: { v: 1, t: CellValueType.NUMBER, f: '=SEQUENCE(2,3)', s: { bl: 1 } },
      5: { v: 7, t: CellValueType.NUMBER, f: '=SEQUENCE(1,1,7)' },
      6: { v: 3, t: CellValueType.NUMBER, f: '=1+2' },
    },
  }
  return snapshot
}

function setup(snapshot = book()) {
  const fixture = csvFixture(snapshot, 'edit')
  cleanups.push(fixture.dispose)
  const publish = (ranges: ISetArrayFormulaDataMutationParams['arrayFormulaRange']) => {
    const params: ISetArrayFormulaDataMutationParams = { arrayFormulaRange: ranges, arrayFormulaCellData: {}, arrayFormulaEmbedded: {} }
    expect(fixture.api.syncExecuteCommand(SetArrayFormulaDataMutation.id, params, { onlyLocal: true })).toBe(true)
  }
  return { ...fixture, publish }
}

describe('正文捕获的数组锚点形态（M5R-I-07，D-04）', () => {
  it('多格数组锚点去掉缓存值 v/t，公式与样式保留；1×1 结果与普通公式照常带缓存值；模型本身不变', () => {
    const h = setup()
    h.publish({ 'csv-book': { 'sheet-1': {
      0: {
        0: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        5: { startRow: 0, endRow: 0, startColumn: 5, endColumn: 5 },
      },
    } } })
    const before = JSON.stringify(h.workbook.save())
    const captured = JSON.parse(captureWorkbookData(h.univer, h.workbook.save())) as IWorkbookData
    const cells = captured.sheets['sheet-1']!.cellData!
    expect(cells[0]![0]).toEqual({ f: '=SEQUENCE(2,3)', s: { bl: 1 } })
    expect(cells[0]![5]).toMatchObject({ v: 7, t: CellValueType.NUMBER, f: '=SEQUENCE(1,1,7)' })
    expect(cells[0]![6]).toMatchObject({ v: 3, t: CellValueType.NUMBER, f: '=1+2' })
    expect(JSON.stringify(h.workbook.save())).toBe(before)
  })

  it('没有数组结果时捕获与 save() 逐字节相同', () => {
    const h = setup()
    expect(captureWorkbookData(h.univer, h.workbook.save())).toBe(JSON.stringify(h.workbook.save()))
  })

  it('其他工作簿或其他表的数组数据不影响当前捕获', () => {
    const h = setup()
    h.publish({
      'other-book': { 'sheet-1': { 0: { 0: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 } } } },
      'csv-book': { 'other-sheet': { 0: { 0: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 } } } },
    })
    expect(captureWorkbookData(h.univer, h.workbook.save())).toBe(JSON.stringify(h.workbook.save()))
  })

  it('纯函数：锚点不在正文或已无缓存值时原样返回同一对象，不复制', () => {
    const data = book()
    expect(withoutArrayAnchorValues(data, [{ sheetId: 'sheet-1', row: 9, column: 9 }, { sheetId: 'missing', row: 0, column: 0 }])).toBe(data)
    const stripped = withoutArrayAnchorValues(data, [{ sheetId: 'sheet-1', row: 0, column: 0 }])
    expect(stripped).not.toBe(data)
    expect(withoutArrayAnchorValues(stripped, [{ sheetId: 'sheet-1', row: 0, column: 0 }])).toBe(stripped)
    expect(data.sheets['sheet-1']!.cellData![0]![0]).toMatchObject({ v: 1 })
  })
})

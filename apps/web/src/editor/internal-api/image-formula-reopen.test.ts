import type { ICellData, Workbook } from '@univerjs/core'
import { ObjectMatrix, Univer, UniverInstanceType } from '@univerjs/core'
import { FormulaDataModel, LexerTreeBuilder } from '@univerjs/engine-formula'
import { afterEach, describe, expect, it } from 'vitest'
import { injectorOf } from './injector.ts'

const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
const cleanups: (() => void)[] = []

function setup(cell: ICellData, extra?: ICellData) {
  const univer = new Univer()
  const workbook = univer.createUnit<unknown, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: 'images',
    sheetOrder: ['sheet'],
    sheets: { sheet: { id: 'sheet', name: 'Sheet', rowCount: 10, columnCount: 5, cellData: { 0: { 0: cell }, ...(extra ? { 1: { 0: extra } } : {}) } } },
  })
  const injector = injectorOf(univer)
  injector.add([LexerTreeBuilder])
  const model = injector.createInstance(FormulaDataModel)
  cleanups.push(() => {
    model.dispose()
    univer.dispose()
  })
  return { model, workbook }
}

afterEach(() => cleanups.splice(0).forEach(dispose => dispose()))

describe('IMAGE 运行时信息不能由快照里的空字符串缓存代替', () => {
  it.each([
    [`=IMAGE("${SOURCE}")`, true],
    [`=image("${SOURCE}")`, true],
    [`=IF(TRUE,IMAGE("${SOURCE}"),"")`, true],
    [`=_xlfn.IMAGE("${SOURCE}")`, true],
    ['="IMAGE("', false],
    ['=CONCAT("IMAGE(",A1)', false],
    ['=\'IMAGE\'!A1', false],
    ['=SUM(1,2)', false],
    [`=MYIMAGE("${SOURCE}")`, false],
  ] as const)('有缓存的公式 %s 重新打开时需要恢复图片：%s', (formula, image) => {
    const { model, workbook } = setup({ f: formula, v: '' })
    const before = JSON.stringify(workbook.getSnapshot())
    expect(model.getFormulaDirtyRanges().length > 0).toBe(image)
    expect(JSON.stringify(workbook.getSnapshot())).toBe(before)
  })

  it('共享公式的从格也按实际主公式恢复，连续范围保留合并', () => {
    const { model } = setup({ f: `=IMAGE("${SOURCE}")`, si: 'shared', v: '' }, { si: 'shared', v: '' })
    expect(model.getFormulaDirtyRanges()).toMatchObject([{ unitId: 'images', sheetId: 'sheet', range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 } }])
  })

  it('已有本实例图片信息时不再次强制重算；无缓存的普通公式仍会计算', () => {
    const { model } = setup({ f: `=IMAGE("${SOURCE}")`, v: '' }, { f: '=SUM(1,2)' })
    model.mergeUnitImageFormulaData({ images: { sheet: new ObjectMatrix({ 0: { 0: { source: SOURCE, altText: '', sizing: 0, height: 0, width: 0, imageNaturalWidth: 120, imageNaturalHeight: 80 } } }) } })
    expect(model.getFormulaDirtyRanges()).toMatchObject([{ range: { startRow: 1, endRow: 1 } }])
  })
})

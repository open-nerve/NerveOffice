import { describe, expect, it } from 'vitest'
import { imageSnapshotForUrlCheck } from './image-snapshot-urls.ts'

const input = { sheetId: 'images', row: 0, column: 8, formula: '=IMAGE("data:image/png;base64,aW5wdXQ=")' }
const forbidden = /blob:|data:image/
function fixture() {
  return {
    sheets: { images: { cellData: { 0: { 8: { f: input.formula, v: '#VALUE!' } } } } },
    resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: '{}' }],
  }
}

describe('图片快照中的原始拒绝样本与新增运行时地址', () => {
  it('没有显式输入声明时仍检查整个快照', () => {
    const raw = JSON.stringify(fixture())
    expect(imageSnapshotForUrlCheck(raw)).toBe(raw)
    expect(imageSnapshotForUrlCheck(raw)).toMatch(forbidden)
  })

  it('只扣除逐字保持的指定输入公式，实际快照不被修改', () => {
    const snapshot = fixture()
    const raw = JSON.stringify(snapshot)
    const checked = imageSnapshotForUrlCheck(raw, input)
    expect(checked).not.toMatch(forbidden)
    const checkedSnapshot = JSON.parse(checked) as ReturnType<typeof fixture>
    expect(checkedSnapshot.sheets.images.cellData[0][8]).toEqual({ v: '#VALUE!' })
    expect(JSON.stringify(snapshot)).toBe(raw)
    expect(snapshot.sheets.images.cellData[0][8].f).toBe(input.formula)
  })

  it.each(['=IMAGE("data:image/png;base64,Y2hhbmdlZA==")', '=IMAGE("blob:unexpected")', ''])('原始公式改变或丢失必须拒绝（%s）', (formula) => {
    const snapshot = fixture()
    snapshot.sheets.images.cellData[0][8].f = formula
    expect(() => imageSnapshotForUrlCheck(JSON.stringify(snapshot), input)).toThrow('原始输入公式')
  })

  it('指定工作表或单元格不存在时拒绝', () => {
    expect(() => imageSnapshotForUrlCheck('{"sheets":{}}', input)).toThrow('原始输入公式')
  })

  it.each([
    { name: '同一个单元格的值', patch: { sheets: { images: { cellData: { 0: { 8: { f: input.formula, v: 'data:image/png;base64,bGVhaw==' } } } } } } },
    { name: '另一个单元格的公式', patch: { sheets: { images: { cellData: { 0: { 8: { f: input.formula }, 9: { f: input.formula } } } } } } },
    { name: '另一张工作表的相同位置', patch: { sheets: { ...fixture().sheets, other: fixture().sheets.images } } },
    { name: '图片来源', patch: { resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ images: { data: { first: { source: 'blob:generated' } } } }) }] } },
    { name: '图片缓存', patch: { resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ images: { data: { first: { base64Cache: 'data:image/png;base64,bGVhaw==' } } } }) }] } },
    { name: '未知字段', patch: { unexpected: 'blob:generated' } },
  ])('额外地址仍被原检查捕获：$name', ({ patch }) => {
    const raw = JSON.stringify({ ...fixture(), ...patch })
    expect(imageSnapshotForUrlCheck(raw, input)).toMatch(forbidden)
  })
})

import { Buffer } from 'node:buffer'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { inspectSnapshot } from './snapshot-inspection.ts'

const UNIT = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const SECRET = 'https://private.example/secret-file.png'
interface Sample {
  id: string
  sheetOrder: string[]
  sheets: Record<string, Record<string, unknown>>
  resources: { name: string, data: string }[]
  [key: string]: unknown
}
function sample(): Sample {
  return JSON.parse(sheetSnapshotFor(UNIT)) as Sample
}
function inspect(value: unknown) {
  return inspectSnapshot(Buffer.from(JSON.stringify(value)), 'sheet@1')
}
function drawing(drawingId = 'd1') {
  return { unitId: UNIT, subUnitId: 'sheet-1', drawingId, source: SECRET, sheetTransform: { from: { row: 2, column: 1 } } }
}
function setDrawings(book: Sample, value: unknown): number {
  const index = book.resources.findIndex(item => item.name === 'SHEET_DRAWING_PLUGIN')
  book.resources[index] = { name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify(value) }
  return index
}

describe('图片拒绝位置：沿实际快照检查给出小结果', () => {
  it('单元格的富文本和嵌套填充只定位一次；不采用单元格或工作表自报的 id/名称', () => {
    const book = sample()
    book.sheets['sheet-1'] = { ...book.sheets['sheet-1'], id: 'false-id', name: 'private-name', cellData: { 2: { 1: { p: { drawings: { d: { source: SECRET } }, fill: { source: SECRET } } } } } }
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 'sheet-1', row: 2, column: 1 }] })
  })

  it('数组形式的单元格矩阵同样定位；工作表其他嵌套 source 定位到表', () => {
    const book = sample()
    book.sheets['sheet-1'] = { ...book.sheets['sheet-1'], cellData: [[{}, { p: { source: SECRET } }]], backgroundImage: { fill: { source: SECRET } } }
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 'sheet-1', row: 0, column: 1 }, { kind: 'sheet', sheetId: 'sheet-1' }] })
  })

  it('drawing 按真实资源结构及匹配身份给出锚点；失配或未知资源结构只给资源索引', () => {
    const book = sample()
    const resourceIndex = setDrawings(book, { 'sheet-1': { data: { d1: drawing(), d2: { ...drawing('d2'), subUnitId: 'other' } }, order: ['d1', 'd2'] } })
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'drawing', sheetId: 'sheet-1', drawingId: 'd1', row: 2, column: 1 }, { kind: 'resource', resourceIndex }] })
    setDrawings(book, { other: { nested: { source: SECRET } } })
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'resource', resourceIndex }] })
  })

  it('不能证明或不在表范围内的锚点不回传；drawing 内部填充仍归到该 drawing', () => {
    const book = sample()
    setDrawings(book, { 'sheet-1': { data: { d1: { ...drawing(), source: '/api/assets/0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d', sheetTransform: { from: { row: 2_147_483_647, column: -1 } }, fill: [{ source: SECRET }] } }, order: ['d1'] } })
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'drawing', sheetId: 'sheet-1', drawingId: 'd1' }] })
  })

  it('资源索引保留空 data 的间隔，不回传资源名或正文', () => {
    const book = sample()
    const resourceIndex = book.resources.findIndex(item => item.name === 'SHEET_NOTE_PLUGIN')
    book.resources[resourceIndex]!.data = JSON.stringify({ 'sheet-1': { nested: { source: SECRET, name: 'private-name' } } })
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'resource', resourceIndex }] })
  })

  it('未知路径、伪造的 sheets 路径、非结构标识只给工作簿；异常坐标降到工作表', () => {
    const book = sample()
    book.extra = { sheets: { leak: { cellData: { 3: { 4: { source: SECRET } } } } } }
    book.sheets['sheet-1'] = { ...book.sheets['sheet-1'], cellData: { '-1': { 0: { source: SECRET } }, '01': { 1: { source: SECRET } } } }
    book.sheets['secret/file.png'] = { cellData: { 0: { 0: { source: SECRET } } } }
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: [{ kind: 'sheet', sheetId: 'sheet-1' }, { kind: 'workbook' }] })
  })

  it('最多返回五个不同位置，原有 source 值的拒绝不放宽', () => {
    const book = sample()
    book.sheets['sheet-1']!.cellData = { 0: Object.fromEntries(Array.from({ length: 8 }, (_, column) => [column, { p: { source: column === 0 ? 42 : SECRET } }])) }
    expect(inspect(book)).toEqual({ ok: false, rule: 'image-source', imageLocations: Array.from({ length: 5 }, (_, column) => ({ kind: 'cell', sheetId: 'sheet-1', row: 0, column })) })
  })

  it('原有结构/资源检查优先，普通 source 字样的字符串不当成图片', () => {
    const book = sample()
    expect(inspect({ ...book, sheetOrder: ['absent'], extra: { source: SECRET } })).toEqual({ ok: false, rule: 'structure' })
    expect(inspect({ ...book, resources: [{ name: 'unknown', data: '{}' }], extra: { source: SECRET } })).toEqual({ ok: false, rule: 'resource-unknown' })
    book.sheets['sheet-1']!.cellData = { 0: { 0: { v: `source ${SECRET}`, f: '=1' } } }
    expect(inspect(book).ok).toBe(true)
  })
})

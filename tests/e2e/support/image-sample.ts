import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { readOnlySampleFor, SAMPLE_SHEETS } from './read-only-sample.ts'

interface RichImage {
  readonly p: {
    readonly drawings: Record<string, { source: string, imageSourceType: string }>
    readonly [key: string]: unknown
  }
}

/** 沿已保存的 SDK 富文本形状换成真实上传地址；正式入口保持关闭，不修改守卫。 */
export function imageSample(unitId: string, source: string, secondAnchor: '0' | '1' = '0'): string {
  const sample = JSON.parse(readOnlySampleFor(unitId)) as { sheets: Record<string, { cellData: Record<string, Record<string, RichImage>> }> }
  const cell = sample.sheets[SAMPLE_SHEETS.features.id]?.cellData['4']?.['7']
  if (cell === undefined)
    throw new Error('真实 SDK 样本中缺少单元格图片')
  for (const drawing of Object.values(cell.p.drawings)) {
    drawing.source = source
    drawing.imageSourceType = 'URL'
  }
  const first = SHEET_TEMPLATE.sheetOrder?.[0]
  const template = first === undefined ? undefined : SHEET_TEMPLATE.sheets?.[first]
  if (template === undefined)
    throw new Error('模板没有工作表')
  const base = { ...template, rowCount: 40, columnCount: 15, defaultRowHeight: 20, defaultColumnWidth: 80, rowData: { 7: { h: 80, ia: 0 } }, columnData: {}, mergeData: [] }
  function image(drawingId: string, column: number) {
    const from = { row: 2, column, rowOffset: 0, columnOffset: 0 }
    const to = { row: 6, column: column + 1, rowOffset: 0, columnOffset: 40 }
    return {
      unitId,
      subUnitId: 'images',
      drawingId,
      drawingType: 0,
      imageSourceType: 'URL',
      source,
      anchorType: drawingId === 'second' ? secondAnchor : '0',
      transform: { left: 46 + column * 80, top: 60, width: 120, height: 80 },
      sheetTransform: { from, to },
      axisAlignSheetTransform: { from, to },
    }
  }
  return JSON.stringify({
    ...SHEET_TEMPLATE,
    id: unitId,
    sheetOrder: ['images', 'other'],
    sheets: {
      images: { ...base, id: 'images', name: '图片复核', cellData: { 0: { 0: { v: '绘制哨兵' } }, 7: { 0: cell, 3: { f: `=IMAGE("${source}")` } } } },
      other: { ...base, id: 'other', name: '切表对照', cellData: { 0: { 0: { v: '切表哨兵' } } } },
    },
    resources: [
      ...(SHEET_TEMPLATE.resources ?? []).filter(resource => resource.name !== 'SHEET_DRAWING_PLUGIN'),
      { name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ images: { data: { first: image('first', 2), second: image('second', 5) }, order: ['first', 'second'] } }) },
    ],
  })
}

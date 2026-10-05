import { describe, expect, it } from 'vitest'
import { readOnlySampleFor, SAMPLE_SHEETS, sampleWithoutImagesFor } from './read-only-sample.ts'

interface Workbook {
  sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }>
  resources: { name: string, data: string }[]
}

const UNIT_ID = 'unit-1'

describe('去掉图片的样本（M3-P3 设计 §3.11：data: 的图片地址服务端拒绝保存）', () => {
  it('完整的样本里有两张 data: 图片（浮动图片与 H5 的单元格图片）；去掉之后一处 data: 地址也没有', () => {
    expect(readOnlySampleFor(UNIT_ID).match(/data:image\//g)).toHaveLength(2)
    expect(sampleWithoutImagesFor(UNIT_ID)).not.toContain('data:image/')
  })

  it('只差这两处："功能"表的 H5 那一格与 SHEET_DRAWING_PLUGIN 里"功能"表那一项，其余（工作表、单元格、别的资源）都相同', () => {
    const full = JSON.parse(readOnlySampleFor(UNIT_ID)) as Workbook
    const derived = JSON.parse(sampleWithoutImagesFor(UNIT_ID)) as Workbook
    const features = SAMPLE_SHEETS.features.id
    expect(derived.sheets[features]?.cellData['4']?.['7']).toBeUndefined()
    delete full.sheets[features]?.cellData['4']?.['7']
    expect(derived.sheets).toEqual(full.sheets)
    expect(derived.resources.map(resource => resource.name)).toEqual(full.resources.map(resource => resource.name))
    for (const [index, resource] of derived.resources.entries()) {
      if (resource.name === 'SHEET_DRAWING_PLUGIN')
        expect(JSON.parse(resource.data)).toEqual({})
      else
        expect(resource, resource.name).toEqual(full.resources[index])
    }
    expect({ ...derived, sheets: undefined, resources: undefined }).toEqual({ ...full, sheets: undefined, resources: undefined })
  })
})

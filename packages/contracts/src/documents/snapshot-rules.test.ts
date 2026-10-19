import { describe, expect, it } from 'vitest'
import { SNAPSHOT_RULES, snapshotInvalidDetailsSchema } from './snapshot-rules.ts'

describe('快照检查的规则标识（SNAPSHOT_INVALID 的 details.rule）', () => {
  it('标识不重复，写成小写加连字符', () => {
    expect(new Set(SNAPSHOT_RULES).size).toBe(SNAPSHOT_RULES.length)
    for (const rule of SNAPSHOT_RULES)
      expect(rule).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
  })

  it('资源、链接与图片的规则都在（profile-resources.ts、link-address.ts 与服务端的图片规则给出）', () => {
    expect(SNAPSHOT_RULES).toEqual(expect.arrayContaining(['resources', 'resource-duplicate', 'resource-unknown', 'resource-data', 'resource-not-empty', 'resource-missing', 'link-structure', 'link-address', 'link-range-id', 'image-source', 'too-complex', 'unit-id']))
  })

  it('详情：认识的规则原样给出', () => {
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'link-address' })).toEqual({ rule: 'link-address' })
  })

  it('响应宽松：不认识的规则、缺少规则、不是字符串都解析成 undefined，不让整个解析失败', () => {
    for (const details of [{ rule: 'doc-header' }, {}, { rule: 1 }, { rule: null }])
      expect(snapshotInvalidDetailsSchema.parse(details), JSON.stringify(details)).toEqual({ rule: undefined })
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'json', extra: true })).toEqual({ rule: 'json' })
  })

  it('图片位置最多五项，仅保留结构标识、坐标和资源索引', () => {
    const imageLocations = [
      { kind: 'cell', sheetId: 'sheet-1', row: 2, column: 1 },
      { kind: 'drawing', sheetId: 'sheet-1', drawingId: 'image_1', row: 4, column: 3 },
      { kind: 'sheet', sheetId: 'sheet-2' },
      { kind: 'resource', resourceIndex: 7 },
      { kind: 'workbook' },
    ]
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'image-source', imageLocations: imageLocations.map(item => ({ ...item, source: 'private', name: 'secret.png' })) })).toEqual({ rule: 'image-source', imageLocations })
  })

  it.each([
    [{ kind: 'future', source: 'private' }],
    [{ kind: 'cell', sheetId: 'sheet-1', row: -1, column: 0 }],
    [{ kind: 'cell', sheetId: 'sheet-1', row: 0.5, column: 0 }],
    [{ kind: 'cell', sheetId: 'sheet-1', row: 2_147_483_648, column: 0 }],
    [{ kind: 'sheet', sheetId: 'x'.repeat(129) }],
    [{ kind: 'sheet', sheetId: 'secret/file.png' }],
    [{ kind: 'sheet', sheetId: '__proto__' }],
    [{ kind: 'drawing', sheetId: 's', drawingId: 'd', row: 0 }],
    [{ kind: 'resource', resourceIndex: -1 }],
    Array.from({ length: 6 }, () => ({ kind: 'workbook' })),
    'not-an-array',
  ].map(imageLocations => [imageLocations]))('位置不合法时保留图片规则、回退通用说明：%j', (imageLocations) => {
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'image-source', imageLocations })).toEqual({ rule: 'image-source', imageLocations: undefined })
  })

  it('其他规则和未知规则不能携带图片位置', () => {
    for (const rule of ['link-address', 'future', undefined]) {
      const result = snapshotInvalidDetailsSchema.parse({ rule, imageLocations: [{ kind: 'workbook' }] })
      expect(result).not.toHaveProperty('imageLocations')
    }
  })
})

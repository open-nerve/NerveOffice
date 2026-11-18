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

describe('链接拒绝位置的有界、兼容契约', () => {
  it.each(['link-structure', 'link-address', 'link-range-id'])('%s 只保留三类位置，去掉地址与图片字段', (rule) => {
    const linkLocations = [
      { kind: 'cell', sheetId: 'sheet-1', row: 2, column: 1 },
      { kind: 'cell', sheetId: 'sheet-1', row: 2_147_483_647, column: 2_147_483_647 },
      { kind: 'sheet', sheetId: 's'.repeat(128) },
      { kind: 'workbook' },
      { kind: 'cell', sheetId: 'sheet-2', row: 0, column: 0 },
    ]
    expect(snapshotInvalidDetailsSchema.parse({
      rule,
      linkLocations: linkLocations.map(location => ({ ...location, url: 'private address', display: 'private text' })),
      imageLocations: [{ kind: 'workbook' }],
    })).toEqual({ rule, linkLocations })
  })

  it.each([
    [{ kind: 'cell', sheetId: 's', row: -1, column: 0 }],
    [{ kind: 'cell', sheetId: 's', row: 0.5, column: 0 }],
    [{ kind: 'cell', sheetId: 's', row: 0, column: 2_147_483_648 }],
    [{ kind: 'sheet', sheetId: '' }],
    [{ kind: 'sheet', sheetId: 's'.repeat(129) }],
    [{ kind: 'sheet', sheetId: 'private/path' }],
    [{ kind: 'sheet', sheetId: '__proto__' }],
    [{ kind: 'sheet', sheetId: 'constructor' }],
    [{ kind: 'sheet', sheetId: 'prototype' }],
    [{ kind: 'drawing', sheetId: 's', drawingId: 'd' }],
    [{ kind: 'resource', resourceIndex: 0 }],
    Array.from({ length: 6 }, () => ({ kind: 'workbook' })),
    'not-an-array',
  ].map(linkLocations => [linkLocations]))('畸形位置只退回固定链接错误，不丢掉规则：%j', (linkLocations) => {
    const parsed = snapshotInvalidDetailsSchema.parse({ rule: 'link-address', linkLocations })
    expect(parsed).toEqual({ rule: 'link-address', linkLocations: undefined })
  })

  it('旧响应不制造位置字段，非链接规则不携带链接位置', () => {
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'link-address' })).toEqual({ rule: 'link-address' })
    for (const rule of ['image-source', 'json', 'later', undefined]) {
      const parsed = snapshotInvalidDetailsSchema.parse({ rule, linkLocations: [{ kind: 'workbook' }] })
      expect(parsed).not.toHaveProperty('linkLocations')
    }
  })
})

describe('文字文档的规则与位置（M6-P1 S3 spec §4）', () => {
  const at = (rule: string): number => (SNAPSHOT_RULES as readonly string[]).indexOf(rule)

  it('新规则按检查的先后排好：文字文档的四条在结构之后、资源之前；交叉核对在链接之后、unitId 之前', () => {
    for (const rule of ['doc-flavor', 'doc-header-footer', 'doc-section-break', 'doc-toc']) {
      expect(at(rule), rule).toBeGreaterThan(at('structure'))
      expect(at(rule), rule).toBeLessThan(at('resources'))
    }
    expect(at('resource-mismatch')).toBeGreaterThan(at('link-range-id'))
    expect(at('resource-mismatch')).toBeLessThan(at('unit-id'))
  })

  it('新规则的详情原样给出，不带位置', () => {
    for (const rule of ['doc-flavor', 'doc-header-footer', 'doc-section-break', 'doc-toc', 'resource-mismatch'])
      expect(snapshotInvalidDetailsSchema.parse({ rule, linkLocations: [{ kind: 'document' }], imageLocations: [{ kind: 'document' }] }), rule).toEqual({ rule })
  })

  it('图片位置加上文字文档里的一张图片与“文档里别的位置”', () => {
    const imageLocations = [{ kind: 'doc-drawing', drawingId: 'H2Qtn4' }, { kind: 'document' }, { kind: 'resource', resourceIndex: 3 }]
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'image-source', imageLocations })).toEqual({ rule: 'image-source', imageLocations })
    for (const drawingId of ['', '__proto__', 'private/path', 'x'.repeat(129)])
      expect(snapshotInvalidDetailsSchema.parse({ rule: 'image-source', imageLocations: [{ kind: 'doc-drawing', drawingId }] }), drawingId).toEqual({ rule: 'image-source', imageLocations: undefined })
  })

  it('链接位置加上段落（从 0 起的非负整数）与“文档里别的位置”；畸形的退回固定的链接错误', () => {
    const linkLocations = [{ kind: 'paragraph', paragraph: 0 }, { kind: 'paragraph', paragraph: 12 }, { kind: 'document' }]
    expect(snapshotInvalidDetailsSchema.parse({ rule: 'link-address', linkLocations })).toEqual({ rule: 'link-address', linkLocations })
    for (const bad of [{ kind: 'paragraph', paragraph: -1 }, { kind: 'paragraph', paragraph: 0.5 }, { kind: 'paragraph', paragraph: 2_147_483_648 }, { kind: 'paragraph' }, { kind: 'doc-drawing', drawingId: 'x' }])
      expect(snapshotInvalidDetailsSchema.parse({ rule: 'link-address', linkLocations: [bad] }), JSON.stringify(bad)).toEqual({ rule: 'link-address', linkLocations: undefined })
  })
})

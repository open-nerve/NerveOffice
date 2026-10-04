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
})

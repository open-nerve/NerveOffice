import { describe, expect, it } from 'vitest'
import { CONTENT_FORMAT_AAD_FIELDS, DRAFT_AAD_FIELDS, DRAFT_AAD_FORMAT, draftAad, IN_FLIGHT_AAD_FIELDS } from './draft-aad.ts'
import { metaVariants, sampleMeta } from './draft-record.test-support.ts'

/** 样例元数据的 AAD 全文（金标准）：格式标识，之后按字段表的顺序；format 与 inFlight 各是固定顺序的子数组 */
const GOLDEN_AAD = '["nerve-office/outbox-draft/v1","0199b0c4-7d3e-7a3b-9c4e-2f1a5b6c7d8e","0199b0c4-7d3e-7a3b-9c4e-00000000d0c1",1,7,12,3,'
  + '"6f1c2a3b-4d5e-4f60-8172-8394a5b6c7d8","0199b0c4-7d3e-7a3b-9c4e-0000000c1e01",["0.1.0+abc1234","0.12.4","sheet-v1",1],false,2,'
  + '["0199b0c4-7d3e-7a3b-9c4e-0000000e0001","0199b0c4-7d3e-7a3b-9c4e-0000000c1e01",7,1791532799000],4096,1791532800000]'

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])
}

/** AAD 里某个字段的位置：第 0 项是格式标识 */
function positionOf(field: (typeof DRAFT_AAD_FIELDS)[number]): number {
  return DRAFT_AAD_FIELDS.indexOf(field) + 1
}

describe('AAD（M4-P1 设计 §3.3）：带格式标识、固定顺序的 JSON 数组，覆盖全部明文元数据', () => {
  it('金标准：样例的 AAD 逐字节固定（改了写法或顺序，库里已有的草稿全部解不开）', () => {
    expect(DRAFT_AAD_FORMAT).toBe('nerve-office/outbox-draft/v1')
    const aad = draftAad(sampleMeta())
    expect(text(aad)).toBe(GOLDEN_AAD)
    expect(sameBytes(aad, new TextEncoder().encode(GOLDEN_AAD))).toBe(true)
  })

  it('不在途时 inFlight 一项是 null；字符串按 UTF-8 编码', () => {
    const aad = draftAad(sampleMeta({ inFlight: null, writtenBy: '实例-甲' }))
    const values: unknown = JSON.parse(text(aad))
    expect(Array.isArray(values) && values.length).toBe(DRAFT_AAD_FIELDS.length + 1)
    expect((values as unknown[])[positionOf('inFlight')]).toBeNull()
    expect((values as unknown[])[positionOf('writtenBy')]).toBe('实例-甲')
    expect(sameBytes(aad, new TextEncoder().encode(text(aad)))).toBe(true)
    expect(text(aad)).toContain('"实例-甲"')
  })

  it('字段表恰好是 DraftMeta、ContentFormat、InFlightSave 的全部键，没有重复', () => {
    const meta = sampleMeta()
    for (const [fields, record] of [[DRAFT_AAD_FIELDS, meta], [CONTENT_FORMAT_AAD_FIELDS, meta.format], [IN_FLIGHT_AAD_FIELDS, meta.inFlight ?? {}]] as const) {
      expect(new Set<string>(fields).size).toBe(fields.length)
      expect([...fields].sort()).toEqual(Object.keys(record).sort())
    }
  })

  it('任何一个明文字段改动，AAD 都不同（含 format 与 inFlight 的每一项、去掉在途）', () => {
    const base = sampleMeta()
    const golden = draftAad(base)
    const variants = metaVariants(base)
    // 改动覆盖了字段表的每一项（format 与 inFlight 按子表的每一项算）
    const labels = new Set(variants.map(variant => variant.label))
    for (const field of DRAFT_AAD_FIELDS)
      expect([...labels].some(label => label === field || label.startsWith(`${field}.`)), field).toBe(true)
    for (const field of CONTENT_FORMAT_AAD_FIELDS)
      expect(labels.has(`format.${field}`), `format.${field}`).toBe(true)
    for (const field of IN_FLIGHT_AAD_FIELDS)
      expect(labels.has(`inFlight.${field}`), `inFlight.${field}`).toBe(true)
    for (const variant of variants)
      expect(sameBytes(draftAad(variant.meta), golden), variant.label).toBe(false)
  })

  it('没有拼接的歧义：字段的边界挪动之后 AAD 不同（JSON 的引号与转义）', () => {
    const left = draftAad(sampleMeta({ writerId: 'a","b', writtenBy: 'c' }))
    const right = draftAad(sampleMeta({ writerId: 'a', writtenBy: 'b","c' }))
    expect(sameBytes(left, right)).toBe(false)
  })
})

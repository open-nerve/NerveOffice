import type { SnapshotInspection } from './snapshot-inspection.ts'
import { Buffer } from 'node:buffer'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { inspectSnapshot } from './snapshot-inspection.ts'

const UNIT = '0199a2c4-0000-7000-8000-000000000001'
const A = '0199a2c4-0000-7000-8000-00000000000a'
const B = '0199a2c4-0000-7000-8000-00000000000b'
const C = '0199a2c4-0000-7000-8000-00000000000c'
const url = (id: string): string => `/api/assets/${id}`
function template(): Record<string, unknown> {
  return JSON.parse(sheetSnapshotFor(UNIT)) as Record<string, unknown>
}
function inspect(value: unknown): SnapshotInspection {
  return inspectSnapshot(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), 'sheet@1')
}
function ids(value: unknown): readonly string[] {
  const result = inspect(value)
  if (!result.ok)
    throw new Error(`样本未通过原校验：${result.rule}`)
  return result.assetIds
}

describe('完整快照检查返回资源标识', () => {
  it('空模板明确返回空集合，值/数组/公式全量提取，键名不算', () => {
    expect(ids(template())).toEqual([])
    const snapshot = { ...template(), [url(C)]: '键不是引用', extra: [url(B), { value: url(A), formula: `=IMAGE("${url(B)}")` }] }
    expect(ids(snapshot)).toEqual([A, B])
  })

  it('资源 data 使用解析值：重复键只保留最后值，Unicode/斜杠转义被正确解开，不扫描已被覆盖的原始字节', () => {
    const data = `{"sheet-1":{"note":"${url(C)}","note":"\\u002fapi\\u002fassets\\u002f${A}","more":["${url(B)}"]}}`
    const snapshot = { ...template(), resources: [{ name: 'SHEET_NOTE_PLUGIN', data }] }
    expect(ids(snapshot)).toEqual([A, B])
  })

  it('外层重复键同样只看解析后最后值，任意嵌套字符串不再当 JSON 反复解码', () => {
    const base = JSON.stringify(template()).slice(0, -1)
    expect(ids(`${base},"extra":"${url(B)}","extra":"${url(A)}"}`)).toEqual([A])
    expect(ids({ ...template(), extra: '"\\u002fapi\\u002fassets\\u002f0199a2c4-0000-7000-8000-00000000000c"' })).toEqual([])
  })

  it('富文本和浮动资源的 source 均被提取；非法图片依旧先被拒绝', () => {
    const drawing = (source: string) => ({ 'sheet-1': { data: { image: { drawingId: 'image', imageSourceType: 'URL', source } }, order: ['image'] } })
    const snapshot = { ...template(), extra: { p: { drawings: { image: { source: url(B) } } } }, resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify(drawing(url(A))) }] }
    expect(ids(snapshot)).toEqual([A, B])
    expect(inspect({ ...snapshot, extra: { source: `https://example.com${url(B)}` } })).toEqual({ ok: false, rule: 'image-source' })
  })

  it('即使视图字段不参与内容哈希也照实提取；调用者不能把 unchanged 入参标识当成已落盘内容', () => {
    const base = template()
    const changed = { ...base, sheets: { ...(base.sheets as object), 'sheet-1': { ...(base.sheets as Record<string, object>)['sheet-1'], zoomRatio: url(A) } } }
    const before = inspect(base)
    const after = inspect(changed)
    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok)
      throw new Error('模板结构不合法')
    expect(after.contentHash).toEqual(before.contentHash)
    expect(after.assetIds).toEqual([A])
    expect(before.assetIds).toEqual([])
  })
})

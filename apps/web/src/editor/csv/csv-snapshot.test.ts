import type { IWorkbookData } from '@univerjs/core'
import { LocaleType } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { assertCsvSnapshot } from './csv-snapshot.ts'

function empty(): IWorkbookData {
  return { id: 'csv', name: '', appVersion: '1.0.1', locale: LocaleType.ZH_CN, sheets: {}, sheetOrder: [], styles: {}, resources: [] }
}

describe('CSV 完整候选使用原快照预算', () => {
  it('最终 UTF-8 JSON 恰好 5 MiB 通过，多一字节拒绝', () => {
    const snapshot = empty()
    const overhead = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
    snapshot.name = 'x'.repeat(5_242_880 - overhead)
    expect(() => assertCsvSnapshot(snapshot)).not.toThrow()
    snapshot.name += 'x'
    expect(() => assertCsvSnapshot(snapshot)).toThrow(expect.objectContaining({ reason: 'capacity' }))
  })

  it('多字节和 JSON 转义膨胀按真实字节计，不按字段长度', () => {
    expect(() => assertCsvSnapshot({ ...empty(), name: '一'.repeat(1_750_000) })).toThrow(expect.objectContaining({ reason: 'capacity' }))
    expect(() => assertCsvSnapshot({ ...empty(), name: '\n'.repeat(2_650_000) })).toThrow(expect.objectContaining({ reason: 'capacity' }))
  })

  it('资源 data 从原第 4 层累计深度，64 允许、65 拒绝', () => {
    const resource = (count: number) => [{ name: 'SHEET_NOTE_PLUGIN', data: `${'['.repeat(count)}0${']'.repeat(count)}` }]
    expect(() => assertCsvSnapshot({ ...empty(), resources: resource(61) })).not.toThrow()
    expect(() => assertCsvSnapshot({ ...empty(), resources: resource(62) })).toThrow(expect.objectContaining({ reason: 'capacity' }))
  })

  it('外层和多份资源的元素数累加，不能每个资源重新计算', () => {
    const values = (count: number) => `[${'0,'.repeat(count - 1)}0]`
    const resources = [{ name: 'SHEET_NOTE_PLUGIN', data: values(750_000) }, { name: 'SHEET_FILTER_PLUGIN', data: values(750_000) }]
    expect(() => assertCsvSnapshot({ ...empty(), resources })).toThrow(expect.objectContaining({ reason: 'capacity' }))
    resources[1] = { name: 'SHEET_FILTER_PLUGIN', data: values(700_000) }
    expect(() => assertCsvSnapshot({ ...empty(), resources })).not.toThrow()
  })
})

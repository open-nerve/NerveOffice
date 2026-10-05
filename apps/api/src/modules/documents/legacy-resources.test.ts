import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { legacyNonEmptyResources } from './legacy-resources.ts'

function stored(snapshot: unknown): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'))
}

describe('legacyNonEmptyResources：存量快照里非空的资源名（M3-P3 设计 §3.3 的不缩水）', () => {
  it('深层为空的不算（空串、{}、{ 表: [] }）；非空的、解析不了的 data 都算（宁可多核对一项）；不认名称是否在白名单（由 shrunkResources 过滤）', () => {
    const snapshot = {
      id: 'u',
      resources: [
        { name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{"0":{"0":{"note":"n"}}}}' },
        { name: 'SHEET_FILTER_PLUGIN', data: '' },
        { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"s1":[]}' },
        { name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '{}' },
        { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{不是 JSON' },
        { name: 'SHEET_AuthzIoMockService_PLUGIN', data: '{"x":1}' },
        // 不是 { name, data } 的项、重复的名称：跳过、去重
        { name: 'SHEET_NOTE_PLUGIN', data: '{"s2":{"1":{}}}' },
        { data: '{"x":1}' },
        'garbage',
      ],
    }
    expect(legacyNonEmptyResources(stored(snapshot))?.toSorted()).toEqual(['SHEET_AuthzIoMockService_PLUGIN', 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_NOTE_PLUGIN'])
  })

  it('没有 resources：没有非空的资源', () => {
    expect(legacyNonEmptyResources(stored({ id: 'u', sheets: {} }))).toEqual([])
    expect(legacyNonEmptyResources(stored({ id: 'u', resources: null }))).toEqual([])
  })

  it('解压、解析不了，顶层不是对象，resources 不是数组：undefined（调用方记一条警告，没有可核对的上一版）', () => {
    expect(legacyNonEmptyResources(Buffer.from('不是 gzip'))).toBeUndefined()
    expect(legacyNonEmptyResources(zlib.gzipSync(Buffer.from('{"id":', 'utf8')))).toBeUndefined()
    expect(legacyNonEmptyResources(stored([1, 2]))).toBeUndefined()
    expect(legacyNonEmptyResources(stored({ id: 'u', resources: { a: 1 } }))).toBeUndefined()
  })

  it('解压之后超过 5 MiB（数据库的约束兜着，这里再限一次）：undefined，不把超大的内容读进内存', () => {
    expect(legacyNonEmptyResources(zlib.gzipSync(Buffer.alloc(SNAPSHOT_MAX_RAW_BYTES + 1, 0x20)))).toBeUndefined()
  })
})

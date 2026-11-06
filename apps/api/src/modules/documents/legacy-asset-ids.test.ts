import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { legacyAssetIds } from './legacy-asset-ids.ts'

const A = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const B = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0e'
const C = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0f'

function stored(snapshot: unknown): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'))
}

describe('legacyAssetIds：存量修订正文里的图片标识（M5-P7 设计 §3.2，D-01 的回退基准，调用方再减去已登记的关系）', () => {
  it('正文任意字符串与资源 data 里的规范地址都算，去重排序；不看是否合规或是否获授权', () => {
    const snapshot = {
      id: 'u',
      sheets: { s1: { cellData: { 0: { 0: { f: `=IMAGE("/api/assets/${B}")` }, 1: { v: `说明 /api/assets/${A}` } } } } },
      // 存量里可能有今天的规则不认的内容：data: 图片、外站地址照样不妨碍提取
      extra: { images: [`/api/assets/${A}`, 'data:image/png;base64,AAAA', `https://outside.example/api/assets/${C}`] },
      resources: [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ s1: { data: { d: { source: `/api/assets/${C}` } } } }) }, { name: 'X', data: '{不是 JSON' }],
    }
    expect(legacyAssetIds(stored(snapshot))).toEqual([A, B, C])
  })

  it('没有图片时为空集合，不是“未知”', () => {
    expect(legacyAssetIds(stored({ id: 'u', sheets: {} }))).toEqual([])
  })

  it('解压、解析不了或超出上限：undefined（调用方退回当前关系并记警告）', () => {
    expect(legacyAssetIds(Buffer.from('不是 gzip'))).toBeUndefined()
    expect(legacyAssetIds(zlib.gzipSync(Buffer.from('{"id":', 'utf8')))).toBeUndefined()
    expect(legacyAssetIds(zlib.gzipSync(Buffer.alloc(SNAPSHOT_MAX_RAW_BYTES + 1, 0x20)))).toBeUndefined()
    let deep: unknown = `/api/assets/${A}`
    for (let i = 0; i < 200; i++)
      deep = [deep]
    expect(legacyAssetIds(stored({ id: 'u', deep }))).toBeUndefined()
  })
})

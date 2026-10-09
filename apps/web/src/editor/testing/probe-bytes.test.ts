// 真实浏览器复核的共用办法（probe-bytes.ts）里不用浏览器存储的部分：不经 Blob 的 gzip 往返、SHA-256、随机字节（超过 getRandomValues 一次的上限）、
// 错误的名字。IndexedDB 的几样由三个浏览器里的校准（specs/editor/selftest.spec.ts）覆盖（jsdom 里没有 IndexedDB）
import { describe, expect, it } from 'vitest'
import { errorName, gunzipBytes, gzipBytes, probeDatabaseName, randomBytes, sha256Hex, tenth } from './probe-bytes.ts'

describe('真实浏览器复核的共用办法', () => {
  it('gzip 再解开与原来的字节相同（含多字节字符与空的），压缩之后是 gzip 的格式（1f 8b 开头）', async () => {
    for (const text of ['', '捕获的快照'.repeat(5000), 'a']) {
      const bytes = new TextEncoder().encode(text)
      const compressed = await gzipBytes(bytes)
      expect([compressed[0], compressed[1]]).toEqual([0x1F, 0x8B])
      expect(new TextDecoder().decode(await gunzipBytes(compressed))).toBe(text)
    }
  })

  it('SHA-256 的已知答案（"abc"）', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('随机字节：长度对、超过 64 KiB 的部分也填上了（getRandomValues 一次最多 64 KiB）', () => {
    const bytes = randomBytes(200_000)
    expect(bytes.length).toBe(200_000)
    expect(bytes.subarray(150_000).some(byte => byte !== 0)).toBe(true)
  })

  it('错误的名字：Error 与 DOMException 取 name，别的写成字符串；库名带随机的后缀；计时保留一位小数', () => {
    expect([errorName(new DOMException('x', 'QuotaExceededError')), errorName(new TypeError('x')), errorName('坏了')]).toEqual(['QuotaExceededError', 'TypeError', '坏了'])
    expect(probeDatabaseName('storage')).toMatch(/^nerve-probe-storage-[\da-f-]{36}$/)
    expect(probeDatabaseName('storage')).not.toBe(probeDatabaseName('storage'))
    expect(tenth(12.345)).toBe(12.3)
  })
})

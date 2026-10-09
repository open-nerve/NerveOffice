import { afterEach, describe, expect, it, vi } from 'vitest'
import { importLocalKey } from './local-key-import.ts'

/** 测试向量（不是任何环境的密钥）：0x40…0x5f */
const RAW = new Uint8Array(Array.from({ length: 32 }, (_, index) => 0x40 + index))
const RAW_BASE64 = btoa(String.fromCharCode(...RAW))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('导入本机密钥（M4-P1 设计 §3.4.9）', () => {
  it('不可导出、AES-GCM-256、用途只有加密与解密，版本照抄', async () => {
    const handle = await importLocalKey({ version: 7, key: RAW_BASE64 })
    expect(handle.version).toBe(7)
    expect(handle.key.extractable).toBe(false)
    expect(handle.key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect([...handle.key.usages].sort()).toEqual(['decrypt', 'encrypt'])
    await expect(crypto.subtle.exportKey('raw', handle.key)).rejects.toMatchObject({ name: 'InvalidAccessError' })
  })

  it('再核对一次长度（纵深防御：契约的写法改了也不会把别的长度悄悄导入成更短的密钥）：不是 32 字节就抛出 TypeError，不导入', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    for (const length of [16, 24, 31, 33]) {
      const key = btoa(String.fromCharCode(...new Uint8Array(length).fill(1)))
      await expect(importLocalKey({ version: 1, key }), String(length)).rejects.toBeInstanceOf(TypeError)
    }
    expect(importKey).not.toHaveBeenCalled()
  })

  it('原始字节在导入之后清零，导入失败时同样', async () => {
    const importKey = crypto.subtle.importKey.bind(crypto.subtle)
    const seen: Uint8Array[] = []
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (format, keyData, algorithm, extractable, usages) => {
      seen.push(keyData as Uint8Array)
      return importKey(format as 'raw', keyData as Uint8Array<ArrayBuffer>, algorithm, extractable, usages)
    })
    await importLocalKey({ version: 1, key: RAW_BASE64 })
    expect(Array.from(seen[0] ?? [1]).every(byte => byte === 0), '原始字节没有清零').toBe(true)
    spy.mockImplementation(async (_format, keyData) => {
      seen.push(keyData as Uint8Array)
      throw new DOMException('导入失败', 'DataError')
    })
    await expect(importLocalKey({ version: 1, key: RAW_BASE64 })).rejects.toMatchObject({ name: 'DataError' })
    expect(Array.from(seen[1] ?? [1]).every(byte => byte === 0), '导入失败时原始字节没有清零').toBe(true)
  })
})

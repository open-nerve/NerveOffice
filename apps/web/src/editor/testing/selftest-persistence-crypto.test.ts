import type { StoredDraft } from '../../shared/outbox/draft-record.ts'
import { Buffer, Blob as NodeBlob } from 'node:buffer'
import { createCipheriv } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSelftestDraft, decryptWithSelftestKey, loadSelftestKey } from './selftest-persistence.ts'

// 人造测试向量。独立 Node AES-GCM + 明示 AAD，不经产品 codec 或本模块的解密实现构造期望。
const RAW = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const PLAIN = '{"独立":"离线原件"}'
beforeEach(() => {
  // jsdom Blob 没有 stream；使用真正实现流的 Node Blob，不替换加解密或压缩算法。
  vi.stubGlobal('Blob', NodeBlob)
})
function draft(): StoredDraft {
  const rawBytes = Buffer.byteLength(PLAIN)
  const aad = ['nerve-office/outbox-draft/v1', 'u', 'd', 1, 3, 2, 4, 'w', 'p', ['test', '0.1', 'sheet', 1], false, 2, null, rawBytes, 17000]
  const iv = new Uint8Array(12).fill(0xA0)
  const cipher = createCipheriv('aes-256-gcm', RAW, iv)
  cipher.setAAD(Buffer.from(JSON.stringify(aad)))
  const ciphertext = new Uint8Array(Buffer.concat([cipher.update(gzipSync(PLAIN)), cipher.final(), cipher.getAuthTag()]))
  return { userId: 'u', documentId: 'd', recordVersion: 1, draftSeq: 3, baseRevision: 2, writeEpoch: 4, writerId: 'w', writtenBy: 'p', format: { clientBuild: 'test', univerVersion: '0.1', profile: 'sheet', formatVersion: 1 }, formulasPending: false, keyVersion: 2, inFlight: null, rawBytes, updatedAt: 17000, iv, ciphertext }
}

function online() {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ version: 2, key: RAW.toString('base64') }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('自检预取密钥后的独立离线解密', () => {
  it('密钥不可导出；离线解密不再联网，仍解开独立生成的完整原件', async () => {
    const fetcher = online()
    const key = await loadSelftestKey('test-csrf')
    expect(key.version).toBe(2)
    expect(key.key.extractable).toBe(false)
    expect(key.key.usages).toEqual(['decrypt'])
    await expect(crypto.subtle.exportKey('raw', key.key)).rejects.toThrow()
    fetcher.mockRejectedValue(new Error('已断开 API'))
    await expect(decryptWithSelftestKey(draft(), key)).resolves.toBe(PLAIN)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ 'x-csrf-token': 'test-csrf' })
  })

  it('旧按次取钥入口继续解开同一个独立原件', async () => {
    online()
    await expect(decryptSelftestDraft(draft(), 'test-csrf')).resolves.toBe(PLAIN)
  })

  it('密钥版本不同必须拒绝，即使底层 key 字节相同', async () => {
    online()
    const key = await loadSelftestKey('test-csrf')
    await expect(decryptWithSelftestKey({ ...draft(), keyVersion: 3 }, key)).rejects.toThrow('密钥版本')
  })

  it.each(['writerId', 'draftSeq', 'formulasPending', 'ciphertext'] as const)('拒绝篡改的 %s', async (field) => {
    online()
    const key = await loadSelftestKey('test-csrf')
    const original = draft()
    const changed = { ...original, ...(field === 'writerId' ? { writerId: 'later' } : field === 'draftSeq' ? { draftSeq: 4 } : field === 'formulasPending' ? { formulasPending: true } : { ciphertext: new Uint8Array(original.ciphertext) }) }
    if (field === 'ciphertext')
      changed.ciphertext[0] = (changed.ciphertext[0] ?? 0) ^ 1
    await expect(decryptWithSelftestKey(changed, key)).rejects.toThrow()
  })

  it.each([
    { version: 0, key: RAW.toString('base64') },
    { version: 1.5, key: RAW.toString('base64') },
    { version: '2', key: RAW.toString('base64') },
    { version: 2, key: 'not-base64' },
    { version: 2, key: Buffer.alloc(16).toString('base64') },
  ])('拒绝无效密钥回包 %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(loadSelftestKey('test-csrf')).rejects.toThrow('密钥回包无效')
  })

  it('HTTP 失败不导入密钥', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await expect(loadSelftestKey('test-csrf')).rejects.toThrow('无法独立取得本机密钥')
  })
})

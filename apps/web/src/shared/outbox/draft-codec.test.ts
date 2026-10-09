import type { LocalKeyHandle } from './draft-codec.ts'
import type { StoredDraft } from './draft-record.ts'
import { describe, expect, it } from 'vitest'
import { canSealDrafts, gunzipBytes, gzipBytes, newDraftIv, openDraft, sealDraft, sha256Hex, unsealFailureOf } from './draft-codec.ts'
import { metaVariants, sampleMeta } from './draft-record.test-support.ts'
import { DRAFT_IV_BYTES, DRAFT_TAG_BYTES, readStoredDraft } from './draft-record.ts'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])
}

async function importKey(raw: Uint8Array<ArrayBuffer>, version: number, usages: readonly KeyUsage[] = ['encrypt', 'decrypt']): Promise<LocalKeyHandle> {
  return { version, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [...usages]) }
}

async function randomKey(version: number): Promise<LocalKeyHandle> {
  return importKey(crypto.getRandomValues(new Uint8Array(32)), version)
}

/** 第 index 个字节翻一位 */
function flipped(bytes: Uint8Array<ArrayBuffer>, index: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes)
  copy[index] = (copy[index] ?? 0) ^ 0x01
  return copy
}

/** 草稿元数据去掉密钥版本（由密钥给出） */
function metaWithoutKeyVersion() {
  const { keyVersion: _keyVersion, ...meta } = sampleMeta()
  return meta
}

describe('已知答案（KAT）：草稿的加密格式一旦有库里的数据就不能改', () => {
  // 测试向量（不是任何环境的密钥）：本机密钥 0x00…0x1f（第 2 版）、IV 0xa0…0xab、样例的元数据（AAD 见 draft-aad.test.ts 的金标准）。
  // 期望值另经独立的实现核对过：node:crypto 的 createCipheriv('aes-256-gcm')，标签 16 字节附在密文之后
  const RAW_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index))
  const IV = new Uint8Array(Array.from({ length: DRAFT_IV_BYTES }, (_, index) => 0xA0 + index))
  const PLAIN = 'nerve-office 本机草稿 KAT'
  const SEALED = '887d0e5b20e66dd9040ce4b6279c5c729630e3f81f3ea5c4232e6dc72b23ef53004797e5ebe9bbeeb3a301214a'

  it('同样的密钥、IV、元数据与内容，密文（含认证标签）逐字节相同；解开得到原来的内容', async () => {
    const key = await importKey(RAW_KEY, 2)
    const sealed = await sealDraft(key, metaWithoutKeyVersion(), utf8(PLAIN), new Uint8Array(IV))
    expect(hex(sealed.iv)).toBe(hex(IV))
    expect(hex(sealed.ciphertext)).toBe(SEALED)
    expect(sealed.keyVersion).toBe(2)
    const opened = await openDraft(key, sealed)
    expect(opened.kind).toBe('opened')
    expect(opened.kind === 'opened' && new TextDecoder().decode(opened.gzip)).toBe(PLAIN)
  })
})

describe('这里能不能封草稿（crypto.subtle 只在安全上下文里有，P1 审查 B14）', () => {
  it('有 crypto.subtle 才能；没有 crypto、crypto 上没有 subtle（经 http 打开的部署）都不能——存储随之按 unsupported 交回', () => {
    expect(canSealDrafts(globalThis)).toBe(true)
    expect(canSealDrafts({ crypto: globalThis.crypto })).toBe(true)
    expect(canSealDrafts({})).toBe(false)
    // 非安全上下文里 crypto 还在（getRandomValues 照常），只是没有 subtle
    expect(canSealDrafts({ crypto: {} })).toBe(false)
    expect(canSealDrafts({ crypto: { subtle: undefined } })).toBe(false)
  })
})

describe('封与开（AES-GCM-256，AAD 覆盖全部明文元数据）', () => {
  it('封好的就是合法的记录：密钥版本取自密钥；IV 12 字节；密文是内容加 16 字节的标签；字节紧凑', async () => {
    const key = await randomKey(5)
    const plain = utf8('{"甲":1}')
    const sealed = await sealDraft(key, metaWithoutKeyVersion(), plain)
    expect(sealed).toMatchObject({ ...metaWithoutKeyVersion(), keyVersion: 5 })
    expect(sealed.iv.byteLength).toBe(DRAFT_IV_BYTES)
    expect(sealed.ciphertext.byteLength).toBe(plain.byteLength + DRAFT_TAG_BYTES)
    expect(readStoredDraft(sealed)).toEqual({ kind: 'draft', draft: sealed })
  })

  it('每次的 IV 都不同（同一把密钥不重用 IV），密文随之不同；两份都解得开', async () => {
    const key = await randomKey(1)
    const plain = utf8('same content')
    const first = await sealDraft(key, metaWithoutKeyVersion(), plain)
    const second = await sealDraft(key, metaWithoutKeyVersion(), plain)
    expect(sameBytes(first.iv, second.iv)).toBe(false)
    expect(sameBytes(first.ciphertext, second.ciphertext)).toBe(false)
    for (const sealed of [first, second]) {
      const opened = await openDraft(key, sealed)
      expect(opened.kind === 'opened' && sameBytes(opened.gzip, plain)).toBe(true)
    }
    const ivs = new Set(Array.from({ length: 64 }, () => hex(newDraftIv())))
    expect(ivs.size).toBe(64)
  })

  it('改动任何一个明文字段（含 format、inFlight 的每一项）之后解不开：密钥版本变小算"已吊销"、变大算"本页的密钥过时"，其余算"已损坏"', async () => {
    const key = await randomKey(sampleMeta().keyVersion)
    const sealed = await sealDraft(key, metaWithoutKeyVersion(), utf8('content'))
    for (const { label, meta } of metaVariants(sampleMeta())) {
      const tampered: StoredDraft = { ...meta, iv: sealed.iv, ciphertext: sealed.ciphertext }
      const reason = meta.keyVersion < key.version ? 'revoked' : meta.keyVersion > key.version ? 'stale-key' : 'corrupted'
      await expect(openDraft(key, tampered), label).resolves.toEqual({ kind: 'unreadable', reason })
    }
  })

  it('IV、密文、标签各翻一位都解不开（已损坏）；截掉标签也解不开', async () => {
    const key = await randomKey(2)
    const sealed = await sealDraft(key, metaWithoutKeyVersion(), utf8('0123456789abcdef'))
    const last = sealed.ciphertext.byteLength - 1
    const variants: readonly [string, StoredDraft][] = [
      ['IV[0]', { ...sealed, iv: flipped(sealed.iv, 0) }],
      ['IV[11]', { ...sealed, iv: flipped(sealed.iv, DRAFT_IV_BYTES - 1) }],
      ['密文[0]', { ...sealed, ciphertext: flipped(sealed.ciphertext, 0) }],
      ['标签[0]', { ...sealed, ciphertext: flipped(sealed.ciphertext, last - DRAFT_TAG_BYTES + 1) }],
      ['标签[15]', { ...sealed, ciphertext: flipped(sealed.ciphertext, last) }],
      ['截掉 4 字节', { ...sealed, ciphertext: sealed.ciphertext.slice(0, last - 3) }],
    ]
    for (const [label, tampered] of variants)
      await expect(openDraft(key, tampered), label).resolves.toEqual({ kind: 'unreadable', reason: 'corrupted' })
  })

  it('换一把密钥：记录的版本比当前的小 → 已吊销；更大 → 本页的密钥过时（去取新的再试，不删）；相同（不是这把密钥加密的）→ 已损坏', async () => {
    const sealed = await sealDraft(await randomKey(2), metaWithoutKeyVersion(), utf8('content'))
    await expect(openDraft(await randomKey(3), sealed)).resolves.toEqual({ kind: 'unreadable', reason: 'revoked' })
    await expect(openDraft(await randomKey(2), sealed)).resolves.toEqual({ kind: 'unreadable', reason: 'corrupted' })
    await expect(openDraft(await randomKey(1), sealed)).resolves.toEqual({ kind: 'unreadable', reason: 'stale-key' })
  })

  it('解不开的归类：只看记录的密钥版本与当前版本（审查 A3）', () => {
    expect(unsealFailureOf(1, 2)).toBe('revoked')
    expect(unsealFailureOf(1, 9)).toBe('revoked')
    expect(unsealFailureOf(2, 2)).toBe('corrupted')
    expect(unsealFailureOf(3, 2)).toBe('stale-key')
    expect(unsealFailureOf(9, 1)).toBe('stale-key')
  })

  it('不是"解不开"的错误照常抛出（例如密钥没有解密的用途）：那是调用方的错，不能说成记录已损坏', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const sealed = await sealDraft(await importKey(raw, 1), metaWithoutKeyVersion(), utf8('content'))
    const encryptOnly = await importKey(raw, 1, ['encrypt'])
    await expect(openDraft(encryptOnly, sealed)).rejects.toMatchObject({ name: 'InvalidAccessError' })
  })
})

describe('gzip 与 gunzip（内存里的流，不经 Blob）', () => {
  it('往返得到原来的字节：多字节字符、空的内容、1 MiB 的内容', async () => {
    const samples = [utf8('{"v":{"0":{"0":{"v":"汉字与 emoji 😀"}}}}'), utf8(''), utf8('x'.repeat(1024 * 1024))]
    for (const sample of samples) {
      const gzip = await gzipBytes(sample)
      expect([gzip[0], gzip[1]], `gzip 的魔数（${sample.byteLength} 字节）`).toEqual([0x1F, 0x8B])
      expect(sameBytes(await gunzipBytes(gzip), sample), `${sample.byteLength} 字节`).toBe(true)
    }
  })

  it('压缩得了：重复的内容明显变小', async () => {
    const sample = utf8('{"cell":"重复"}'.repeat(10_000))
    expect((await gzipBytes(sample)).byteLength).toBeLessThan(sample.byteLength / 20)
  })

  it('不是 gzip 的数据：gunzip 抛出（只会解开自己加密的数据，正常走不到这里）', async () => {
    await expect(gunzipBytes(utf8('not gzip at all'))).rejects.toThrow()
  })

  it('交回的字节紧凑（存进库时不带多余的缓冲）', async () => {
    const gzip = await gzipBytes(utf8('a'.repeat(100_000)))
    expect(gzip.byteOffset).toBe(0)
    expect(gzip.byteLength).toBe(gzip.buffer.byteLength)
    const plain = await gunzipBytes(gzip)
    expect(plain.byteOffset).toBe(0)
    expect(plain.byteLength).toBe(plain.buffer.byteLength)
  })
})

describe('SHA-256（会话内去重的键）', () => {
  it('十六进制小写，与标准的测试向量一致', async () => {
    await expect(sha256Hex(utf8('abc'))).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    await expect(sha256Hex(utf8(''))).resolves.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

// 编辑租约的令牌（M3-P1 设计 §3.2、§3.5）：生成、摘要与恒定时间的比较。
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { editLeaseTokenSchema } from '@nerve-office/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { editLeaseTokenDigest, editLeaseTokenMatches, generateEditLeaseToken } from './edit-lease-token.ts'

// 比较必须经 timingSafeEqual（恒定时间）：包一层记下调用，换成 Buffer.equals 或逐字节比较时用例失败
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear()
})

describe('编辑租约的令牌', () => {
  it('32 字节安全随机数的 base64url（43 个字符，不带填充），符合契约的格式；每次不同', () => {
    const token = generateEditLeaseToken()
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(editLeaseTokenSchema.safeParse(token).success).toBe(true)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(new Set(Array.from({ length: 20 }, () => generateEditLeaseToken())).size).toBe(20)
  })

  it('库里存的是 SHA-256 摘要（32 字节）：按 UTF-8 算，同一个令牌摘要相同', () => {
    // FIPS 180-2 的测试向量："abc" 的 SHA-256
    expect(editLeaseTokenDigest('abc').toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const token = generateEditLeaseToken()
    expect(editLeaseTokenDigest(token)).toHaveLength(32)
    expect(editLeaseTokenDigest(token).equals(editLeaseTokenDigest(token))).toBe(true)
    expect(editLeaseTokenDigest(token).equals(editLeaseTokenDigest(generateEditLeaseToken()))).toBe(false)
  })
})

describe('令牌与摘要的比较', () => {
  it('是这个摘要的令牌才对得上；别的令牌、差一个字符的令牌都对不上', () => {
    const token = generateEditLeaseToken()
    const digest = editLeaseTokenDigest(token)
    expect(editLeaseTokenMatches(token, digest)).toBe(true)
    expect(editLeaseTokenMatches(generateEditLeaseToken(), digest)).toBe(false)
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    expect(editLeaseTokenMatches(flipped, digest)).toBe(false)
  })

  it('比较走 timingSafeEqual（恒定时间），比的是两个 32 字节的摘要', () => {
    const token = generateEditLeaseToken()
    const digest = editLeaseTokenDigest(token)
    editLeaseTokenMatches(token, digest)
    editLeaseTokenMatches(generateEditLeaseToken(), digest)
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(2)
    for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls)
      expect([left.byteLength, right.byteLength]).toEqual([32, 32])
  })

  it('摘要的长度不对（损坏的数据）直接对不上，不抛错，也不去比较', () => {
    const token = generateEditLeaseToken()
    const digest = editLeaseTokenDigest(token)
    for (const broken of [Buffer.alloc(0), digest.subarray(0, 31), Buffer.concat([digest, Buffer.from([0])])])
      expect(editLeaseTokenMatches(token, broken), String(broken.length)).toBe(false)
    expect(vi.mocked(timingSafeEqual)).not.toHaveBeenCalled()
  })
})

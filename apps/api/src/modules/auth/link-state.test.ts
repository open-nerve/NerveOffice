import { isWellFormedLinkToken } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { invitationStatusOf, usabilityOf } from './link-state.ts'
import { generateLinkToken, linkTokenDigest } from './link-token.ts'

const AT = new Date('2026-09-28T00:00:00Z')

describe('一次性链接的状态', () => {
  it('没有接受（使用）、没有作废、没有到期：可用', () => {
    expect(usabilityOf({ completedAt: null, revokedAt: null, expired: false })).toBe('usable')
  })

  it('已用、已作废优先于过期：过期之后才被作废的按作废说', () => {
    expect(usabilityOf({ completedAt: AT, revokedAt: null, expired: true })).toBe('used')
    expect(usabilityOf({ completedAt: null, revokedAt: AT, expired: true })).toBe('revoked')
    expect(usabilityOf({ completedAt: null, revokedAt: null, expired: true })).toBe('expired')
  })

  it('管理界面里邀请的状态：待接受、已接受、已过期、已作废', () => {
    expect(invitationStatusOf({ completedAt: null, revokedAt: null, expired: false })).toBe('pending')
    expect(invitationStatusOf({ completedAt: AT, revokedAt: null, expired: false })).toBe('accepted')
    expect(invitationStatusOf({ completedAt: null, revokedAt: null, expired: true })).toBe('expired')
    expect(invitationStatusOf({ completedAt: null, revokedAt: AT, expired: false })).toBe('revoked')
  })
})

describe('一次性链接的令牌', () => {
  it('32 字节随机数的 base64url：格式合法，每次不同', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateLinkToken()))
    expect(tokens.size).toBe(20)
    for (const token of tokens)
      expect(isWellFormedLinkToken(token)).toBe(true)
  })

  it('摘要是 32 字节；格式不对的令牌不算摘要（与找不到一样回答"链接无效"）', () => {
    expect(linkTokenDigest(generateLinkToken())?.length).toBe(32)
    expect(linkTokenDigest('')).toBeUndefined()
    expect(linkTokenDigest('short')).toBeUndefined()
    expect(linkTokenDigest(`${generateLinkToken()}x`)).toBeUndefined()
  })
})

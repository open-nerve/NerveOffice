import { describe, expect, it } from 'vitest'
import { csrfTokenFor, csrfTokenMatches, generateSessionToken, isWellFormedSessionToken, sessionTokenDigest } from './session-token.ts'

describe('会话令牌', () => {
  it('32 字节随机数的 base64url 编码；每次不同', () => {
    const first = generateSessionToken()
    expect(first).toMatch(/^[\w-]{43}$/)
    expect(isWellFormedSessionToken(first)).toBe(true)
    expect(generateSessionToken()).not.toBe(first)
  })

  it('格式不对的令牌直接判为无效', () => {
    for (const value of ['', 'short', `${'a'.repeat(43)}=`, 'a'.repeat(44), `${'a'.repeat(42)}!`])
      expect(isWellFormedSessionToken(value), value).toBe(false)
  })

  it('摘要是 32 字节的 SHA-256，同一个令牌摘要相同', () => {
    const token = generateSessionToken()
    expect(sessionTokenDigest(token)).toHaveLength(32)
    expect(sessionTokenDigest(token).equals(sessionTokenDigest(token))).toBe(true)
    expect(sessionTokenDigest(token).equals(sessionTokenDigest(generateSessionToken()))).toBe(false)
  })
})

describe('CSRF 令牌', () => {
  it('由会话令牌派生：同一个会话相同，不同的会话不同，与会话令牌本身不同', () => {
    const token = generateSessionToken()
    expect(csrfTokenFor(token)).toBe(csrfTokenFor(token))
    expect(csrfTokenFor(token)).not.toBe(csrfTokenFor(generateSessionToken()))
    expect(csrfTokenFor(token)).not.toBe(token)
  })

  it('比较：缺少、长度不同、内容不同都不通过', () => {
    const expected = csrfTokenFor(generateSessionToken())
    expect(csrfTokenMatches(expected, expected)).toBe(true)
    expect(csrfTokenMatches(expected, undefined)).toBe(false)
    expect(csrfTokenMatches(expected, '')).toBe(false)
    expect(csrfTokenMatches(expected, `${expected}x`)).toBe(false)
    expect(csrfTokenMatches(expected, csrfTokenFor(generateSessionToken()))).toBe(false)
  })
})

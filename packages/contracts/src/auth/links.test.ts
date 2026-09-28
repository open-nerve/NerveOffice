import { describe, expect, it } from 'vitest'
import {
  acceptInvitationRequestSchema,
  completePasswordResetRequestSchema,
  inspectLinkRequestSchema,
  isWellFormedLinkToken,
  linkInvalidDetailsSchema,
  linkTokenFromHash,
  ONE_TIME_TOKEN_LENGTH,
  oneTimeLinkUrl,
} from './links.ts'

const TOKEN = `${'a'.repeat(ONE_TIME_TOKEN_LENGTH - 2)}-_`

describe('一次性链接', () => {
  it('令牌放在 # 之后，指向对应的平台页面', () => {
    expect(oneTimeLinkUrl('https://docs.example.com', 'invitation', TOKEN)).toBe(`https://docs.example.com/invite#${TOKEN}`)
    expect(oneTimeLinkUrl('https://docs.example.com', 'password_reset', TOKEN)).toBe(`https://docs.example.com/reset-password#${TOKEN}`)
  })

  it('页面从 # 部分取出令牌；没有 # 部分时是空字符串', () => {
    expect(linkTokenFromHash(`#${TOKEN}`)).toBe(TOKEN)
    expect(linkTokenFromHash('')).toBe('')
    expect(linkTokenFromHash('#')).toBe('')
  })

  it('格式合法的令牌：43 个 base64url 字符', () => {
    expect(isWellFormedLinkToken(TOKEN)).toBe(true)
    expect(isWellFormedLinkToken(TOKEN.slice(1))).toBe(false)
    expect(isWellFormedLinkToken(`${TOKEN}a`)).toBe(false)
    expect(isWellFormedLinkToken(`${TOKEN.slice(1)}=`)).toBe(false)
    expect(isWellFormedLinkToken(`${TOKEN.slice(1)}+`)).toBe(false)
  })

  it('请求里的令牌只限制长度：格式不对的交给服务端回答"链接无效"', () => {
    expect(inspectLinkRequestSchema.safeParse({ token: 'short' }).success).toBe(true)
    expect(inspectLinkRequestSchema.safeParse({ token: '' }).success).toBe(true)
    expect(inspectLinkRequestSchema.safeParse({ token: 'x'.repeat(257) }).success).toBe(false)
    expect(inspectLinkRequestSchema.safeParse({ token: TOKEN, extra: 1 }).success).toBe(false)
  })

  it('接受邀请：显示名与新密码按设置时的规则', () => {
    expect(acceptInvitationRequestSchema.parse({ token: TOKEN, displayName: '  张三 ', password: 'p'.repeat(12) }).displayName).toBe('张三')
    expect(acceptInvitationRequestSchema.safeParse({ token: TOKEN, displayName: '张三', password: 'short' }).success).toBe(false)
    expect(acceptInvitationRequestSchema.safeParse({ token: TOKEN, displayName: '', password: 'p'.repeat(12) }).success).toBe(false)
  })

  it('用重置链接设置新密码：新密码按设置时的规则', () => {
    expect(completePasswordResetRequestSchema.safeParse({ token: TOKEN, password: 'p'.repeat(12) }).success).toBe(true)
    expect(completePasswordResetRequestSchema.safeParse({ token: TOKEN, password: 'p\n'.repeat(6) }).success).toBe(false)
  })

  it('链接不能用的原因只有四种', () => {
    for (const reason of ['invalid', 'expired', 'used', 'revoked'])
      expect(linkInvalidDetailsSchema.safeParse({ reason }).success).toBe(true)
    expect(linkInvalidDetailsSchema.safeParse({ reason: 'other' }).success).toBe(false)
  })
})

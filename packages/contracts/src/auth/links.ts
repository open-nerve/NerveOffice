import { z } from 'zod'
import { displayNameSchema, newPasswordSchema } from '../users/users.ts'

/**
 * 一次性链接（M2-P1 设计 §3.4）：邀请注册与重置密码。
 * 令牌放在链接的 # 之后：浏览器不把这一段放进请求行，它不进访问日志，也不出现在 Referer 里；
 * 页面读出令牌后放进请求体提交。
 */
export const ONE_TIME_LINK_PURPOSES = ['invitation', 'password_reset'] as const
export type OneTimeLinkPurpose = (typeof ONE_TIME_LINK_PURPOSES)[number]

/** 邀请的有效期：7 天（M2 总设计 §2.1）。界面上的说明用天数，服务端按小时算到期时间 */
export const INVITATION_LIFETIME_DAYS = 7
export const INVITATION_LIFETIME_HOURS = INVITATION_LIFETIME_DAYS * 24
/** 重置链接的有效期：24 小时 */
export const PASSWORD_RESET_LIFETIME_HOURS = 24

/** 链接指向的平台页面 */
export const ONE_TIME_LINK_PAGE_PATHS: Readonly<Record<OneTimeLinkPurpose, string>> = {
  invitation: '/invite',
  password_reset: '/reset-password',
}

/** 32 字节随机数的 base64url 编码（不带填充）是 43 个字符 */
export const ONE_TIME_TOKEN_LENGTH = 43
const ONE_TIME_TOKEN_PATTERN = /^[\w-]{43}$/

/** 格式合法的令牌：生成与解析时核对 */
export function isWellFormedLinkToken(value: string): boolean {
  return ONE_TIME_TOKEN_PATTERN.test(value)
}

/** 链接：公开地址（不带末尾的斜杠）+ 页面 + # + 令牌 */
export function oneTimeLinkUrl(publicOrigin: string, purpose: OneTimeLinkPurpose, token: string): string {
  return `${publicOrigin}${ONE_TIME_LINK_PAGE_PATHS[purpose]}#${token}`
}

/** 页面地址的 # 部分（location.hash，带 #）→ 令牌；没有时是空字符串，交给服务端判断（格式不对同样是"链接无效"） */
export function linkTokenFromHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash
}

/**
 * 请求里的令牌只限制长度：格式不对（例如复制时少了几个字符）与找不到一样回答"链接无效"，
 * 由服务端计入尝试限流，而不是当作请求不合法（REQUEST_INVALID）。
 */
const linkTokenInputSchema = z.string().max(256)

/** 查看邀请或重置链接（POST /api/auth/invitations/inspect、/api/auth/password-resets/inspect） */
export const inspectLinkRequestSchema = z.strictObject({ token: linkTokenInputSchema })

export type InspectLinkRequest = z.infer<typeof inspectLinkRequestSchema>

/** 链接对应的账户：页面只显示登录名与显示名 */
export const inspectLinkResponseSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  expiresAt: z.iso.datetime(),
})

export type InspectLinkResponse = z.infer<typeof inspectLinkResponseSchema>

/** 接受邀请（POST /api/auth/invitations/accept）：可以改显示名，设置密码；成功后已登录，响应同登录 */
export const acceptInvitationRequestSchema = z.strictObject({
  token: linkTokenInputSchema,
  displayName: displayNameSchema,
  password: newPasswordSchema,
})

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>

/** 用重置链接设置新密码（POST /api/auth/password-resets/complete）：成功后已登录，其他地方的登录全部退出 */
export const completePasswordResetRequestSchema = z.strictObject({
  token: linkTokenInputSchema,
  password: newPasswordSchema,
})

export type CompletePasswordResetRequest = z.infer<typeof completePasswordResetRequestSchema>

/** 链接不能用的原因（LINK_INVALID 的 details）：没有这个令牌、已过期、已使用、已作废 */
export const LINK_INVALID_REASONS = ['invalid', 'expired', 'used', 'revoked'] as const
export type LinkInvalidReason = (typeof LINK_INVALID_REASONS)[number]

export const linkInvalidDetailsSchema = z.object({
  reason: z.enum(LINK_INVALID_REASONS),
})

export type LinkInvalidDetails = z.infer<typeof linkInvalidDetailsSchema>

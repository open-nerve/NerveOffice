import { z } from 'zod'

/** 只有持有已经识别出的会话才能获知具体撤销原因；登录失败不使用这些详情。 */
const SESSION_REVOCATION_REASONS = ['account_disabled', 'password_reset', 'password_changed', 'replaced', 'logout'] as const
export const SESSION_EXPIRED_REASONS = [...SESSION_REVOCATION_REASONS, 'expired'] as const
export type SessionExpiredReason = (typeof SESSION_EXPIRED_REASONS)[number]

/** SESSION_EXPIRED 的详情：不认识/已清理的令牌只能回答 expired，不猜测它属于谁。 */
export const sessionExpiredDetailsSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.enum(SESSION_REVOCATION_REASONS), userId: z.uuid() }),
  z.object({ reason: z.literal('expired'), userId: z.uuid().optional() }),
])

export type SessionExpiredDetails = z.infer<typeof sessionExpiredDetailsSchema>

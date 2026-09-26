import { z } from 'zod'
import { USER_SYSTEM_ROLES } from '../users/users.ts'

/** 登录时只限制长度，不向外透露用户名与密码的规则（P3 设计 §3.4）。 */
export const LOGIN_USERNAME_MAX_LENGTH = 64
export const LOGIN_PASSWORD_MAX_LENGTH = 1024

export const loginRequestSchema = z.strictObject({
  username: z.string().min(1).max(LOGIN_USERNAME_MAX_LENGTH),
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
})

export type LoginRequest = z.infer<typeof loginRequestSchema>

/** 当前会话（登录与 GET /api/auth/session 的响应）：账户、个人空间，以及状态变更请求要带的 CSRF 令牌。 */
export const sessionResponseSchema = z.strictObject({
  user: z.strictObject({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    systemRole: z.enum(USER_SYSTEM_ROLES),
  }),
  personalSpace: z.strictObject({
    id: z.uuid(),
    name: z.string(),
  }),
  csrfToken: z.string().min(1),
})

export type SessionResponse = z.infer<typeof sessionResponseSchema>

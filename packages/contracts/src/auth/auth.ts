import { z } from 'zod'
import { newPasswordSchema, USER_SYSTEM_ROLES } from '../users/users.ts'

/** 登录时只限制长度，不向外透露用户名与密码的规则（P3 设计 §3.4）。 */
export const LOGIN_USERNAME_MAX_LENGTH = 64
export const LOGIN_PASSWORD_MAX_LENGTH = 1024

export const loginRequestSchema = z.strictObject({
  username: z.string().min(1).max(LOGIN_USERNAME_MAX_LENGTH),
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
})

export type LoginRequest = z.infer<typeof loginRequestSchema>

/**
 * 当前会话（登录与 GET /api/auth/session 的响应）：账户、个人空间，以及状态变更请求要带的 CSRF 令牌。
 * 响应的结构都是宽松的：客户端丢弃不认识的字段，接口只做加法时，打开着的旧页面照常工作。请求的结构是严格的。
 */
export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    systemRole: z.enum(USER_SYSTEM_ROLES),
  }),
  personalSpace: z.object({
    id: z.uuid(),
    name: z.string(),
  }),
  csrfToken: z.string().min(1),
})

export type SessionResponse = z.infer<typeof sessionResponseSchema>

/**
 * 修改密码（PUT /api/auth/password，M2-P1 设计 §3.5）：旧密码只限制长度，与登录相同；新密码按设置密码的规则。
 * 成功后本人的全部会话撤销（包括当前这个），当前页面换成新的会话（M2-P6 复核 B1）：响应写回新的会话 Cookie，
 * 响应体与登录相同（changePasswordResponseSchema），带着新的 CSRF 令牌。
 */
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
})

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>

/** 修改密码的响应：当前页面的新会话，与登录的响应相同 */
export const changePasswordResponseSchema = sessionResponseSchema

export type ChangePasswordResponse = SessionResponse

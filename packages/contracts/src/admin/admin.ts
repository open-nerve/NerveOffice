import { z } from 'zod'
import { displayNameSchema, USER_SEARCH_QUERY_MAX_LENGTH, USER_STATUSES, USER_SYSTEM_ROLES, usernameSchema, userSummarySchema } from '../users/users.ts'

/** 管理界面各个列表每页的条数 */
export const ADMIN_PAGE_SIZE = 50

/** 游标是服务端给出的不透明字符串 */
const cursorSchema = z.string().min(1).max(512)

/** 管理界面里的账户：含状态与系统角色（M2-P1 设计 §3.6）。时间是 ISO 8601 的 UTC。 */
export const adminUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  systemRole: z.enum(USER_SYSTEM_ROLES),
  status: z.enum(USER_STATUSES),
  createdAt: z.iso.datetime(),
})

export type AdminUser = z.infer<typeof adminUserSchema>

/** 账户列表（GET /api/admin/users）：含停用的账户，可按关键词与状态过滤，按登录名排序分页 */
export const adminUserListQuerySchema = z.strictObject({
  query: z.string().trim().max(USER_SEARCH_QUERY_MAX_LENGTH).optional(),
  status: z.enum(USER_STATUSES).optional(),
  cursor: cursorSchema.optional(),
})

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>

export const adminUserListResponseSchema = z.object({
  items: z.array(adminUserSchema),
  nextCursor: z.string().nullable(),
})

export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>

/** 设为或取消系统管理员（PUT /api/admin/users/{id}/system-role） */
export const changeSystemRoleRequestSchema = z.strictObject({
  systemRole: z.enum(USER_SYSTEM_ROLES),
})

export type ChangeSystemRoleRequest = z.infer<typeof changeSystemRoleRequestSchema>

/** 签发的重置链接（POST /api/admin/users/{id}/password-reset）：链接只在这里出现一次 */
export const issuedPasswordResetSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
})

export type IssuedPasswordReset = z.infer<typeof issuedPasswordResetSchema>

/** 邀请的状态：待接受、已接受、已过期（到期而没有接受或作废）、已作废 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

/** 管理界面里的邀请：不含令牌 */
export const invitationSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  status: z.enum(INVITATION_STATUSES),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** 签发人 */
  createdBy: userSummarySchema,
  acceptedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
})

export type Invitation = z.infer<typeof invitationSchema>

/** 邀请列表（GET /api/admin/invitations）：按签发时间从新到旧分页，可按状态过滤 */
export const invitationListQuerySchema = z.strictObject({
  status: z.enum(INVITATION_STATUSES).optional(),
  cursor: cursorSchema.optional(),
})

export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>

export const invitationListResponseSchema = z.object({
  items: z.array(invitationSchema),
  nextCursor: z.string().nullable(),
})

export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>

/** 签发邀请（POST /api/admin/invitations）：管理员填好登录名与显示名（M2 总设计 §2.1 第 2 条） */
export const createInvitationRequestSchema = z.strictObject({
  username: usernameSchema,
  displayName: displayNameSchema,
})

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>

/** 签发或重发的邀请：链接只在这里出现一次 */
export const issuedInvitationSchema = z.object({
  invitation: invitationSchema,
  url: z.string(),
})

export type IssuedInvitation = z.infer<typeof issuedInvitationSchema>

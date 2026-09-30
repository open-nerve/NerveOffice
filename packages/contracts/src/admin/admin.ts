import { z } from 'zod'
import { DOCUMENT_TYPES } from '../documents/documents.ts'
import { uuidSchema } from '../ids/ids.ts'
import { SPACE_NAME_MAX_LENGTH, SPACE_ROLES, SPACE_STATUSES, spaceNameSchema } from '../spaces/spaces.ts'
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
  /**
   * 登录锁定（M2-P6 复核 A1）：这个账户的失败计数里还在锁定的，最晚锁到什么时候（until）；没有锁定时为空。
   * allSources 为真：只按用户名的上限到了，这个账户在所有来源上都登录不了；为假：只锁了某些来源（按用户名与来源的组合），
   * 本人从别的来源照常登录——多半是有人在某台机器上连续输错了。
   * 系统管理员可以解除（POST /api/admin/users/{id}/unlock-login），清掉这个账户在所有来源上的计数
   */
  loginLock: z.object({ until: z.iso.datetime(), allSources: z.boolean() }).nullable(),
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

/** 路径里的邀请 id */
export const invitationIdSchema = uuidSchema

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
  /** 同一个登录名后来又签发过邀请（重发或重新签发）：界面只对最新的一条给出重新生成（审查 B6） */
  superseded: z.boolean(),
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

/** 管理界面里的团队空间（M2-P2 设计 §3.3）。时间是 ISO 8601 的 UTC。 */
export const adminSpaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(SPACE_STATUSES),
  visibleToAll: z.boolean(),
  /** 成员行的数量，含停用的成员 */
  memberCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  /** 当前系统管理员在这个空间里的角色；没有加入时为空 */
  myRole: z.enum(SPACE_ROLES).nullable(),
})

export type AdminSpace = z.infer<typeof adminSpaceSchema>

/** 团队空间列表（GET /api/admin/spaces）：名称包含关键词，可按状态过滤，按创建时间从新到旧分页 */
export const adminSpaceListQuerySchema = z.strictObject({
  query: z.string().trim().max(SPACE_NAME_MAX_LENGTH).optional(),
  status: z.enum(SPACE_STATUSES).optional(),
  cursor: cursorSchema.optional(),
})

export type AdminSpaceListQuery = z.infer<typeof adminSpaceListQuerySchema>

export const adminSpaceListResponseSchema = z.object({
  items: z.array(adminSpaceSchema),
  nextCursor: z.string().nullable(),
})

export type AdminSpaceListResponse = z.infer<typeof adminSpaceListResponseSchema>

/** 创建团队空间（POST /api/admin/spaces）：同时指定首个空间管理员（US-M2-05） */
export const createTeamSpaceRequestSchema = z.strictObject({
  name: spaceNameSchema,
  adminUserId: uuidSchema,
  visibleToAll: z.boolean(),
})

export type CreateTeamSpaceRequest = z.infer<typeof createTeamSpaceRequestSchema>

/** 设置或取消全员可见（PUT /api/admin/spaces/{id}/visibility） */
export const changeSpaceVisibilityRequestSchema = z.strictObject({
  visibleToAll: z.boolean(),
})

export type ChangeSpaceVisibilityRequest = z.infer<typeof changeSpaceVisibilityRequestSchema>

/** 停用者个人空间里的文档：只有标题、类型与更新时间，不含内容（00 号计划书 §5.4） */
export const adminUserDocumentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  type: z.enum(DOCUMENT_TYPES),
  updatedAt: z.iso.datetime(),
})

export type AdminUserDocument = z.infer<typeof adminUserDocumentSchema>

/** 停用者的文档列表（GET /api/admin/users/{id}/documents）：按更新时间从新到旧分页 */
export const adminUserDocumentListQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
})

export type AdminUserDocumentListQuery = z.infer<typeof adminUserDocumentListQuerySchema>

export const adminUserDocumentListResponseSchema = z.object({
  items: z.array(adminUserDocumentSchema),
  nextCursor: z.string().nullable(),
})

export type AdminUserDocumentListResponse = z.infer<typeof adminUserDocumentListResponseSchema>

/** 一次最多转移的文档数：事务不致过长，界面分批（M2-P2 设计 §3.8） */
export const TRANSFER_MAX_DOCUMENTS = 100

/** 转移的目标：某个有效账户的个人空间，或某个没有归档的团队空间 */
export const transferTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('personal'), userId: uuidSchema }),
  z.strictObject({ type: z.literal('team'), spaceId: uuidSchema }),
])

export type TransferTarget = z.infer<typeof transferTargetSchema>

/** 转移停用者的文档（POST /api/admin/users/{id}/documents/transfer）：整批转移，有一份不在他的个人空间里就整批拒绝 */
export const transferDocumentsRequestSchema = z.strictObject({
  documentIds: z.array(uuidSchema)
    .min(1)
    .max(TRANSFER_MAX_DOCUMENTS)
    // id 已统一成小写：大小写不同的同一个 id 也算重复
    .refine(ids => new Set(ids).size === ids.length, '文档不能重复'),
  target: transferTargetSchema,
})

export type TransferDocumentsRequest = z.infer<typeof transferDocumentsRequestSchema>

export const transferDocumentsResponseSchema = z.object({
  transferred: z.number().int().min(1),
})

export type TransferDocumentsResponse = z.infer<typeof transferDocumentsResponseSchema>

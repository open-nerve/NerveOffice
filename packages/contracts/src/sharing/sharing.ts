import type { SpaceRole } from '../spaces/spaces.ts'
import { z } from 'zod'
import { documentSummarySchema } from '../documents/documents.ts'
import { SPACE_ROLES, spaceIdentitySchema } from '../spaces/spaces.ts'
import { USER_STATUSES, userSummarySchema } from '../users/users.ts'

/**
 * 单独授权的角色（00 号计划书 §5.3，M2-P5 设计 §3.2）：查看者或编辑者，取值是空间角色的一部分（按同样的高低比较），
 * 最高只到编辑者——分享给不出空间管理员。新增取值时，同时用迁移更新 document_grants.role 的 CHECK 约束。
 */
export const GRANT_ROLES = ['viewer', 'editor'] as const satisfies readonly SpaceRole[]
export type GrantRole = (typeof GRANT_ROLES)[number]

/**
 * 一份文档的一条单独授权（GET /api/documents/{id}/grants 的条目，PUT 的响应）：
 * 被授权人与他的账户状态（停用的人的授权照样列出、照样能取消，与成员列表同形）、角色，
 * 以及最后设置这个角色的人（新建或调整）与设置的时间。人名一律是"人"的结构（userSummarySchema），界面经人名组件显示。
 * 响应的结构宽松，见 auth 的会话信息。
 */
export const documentGrantSchema = z.object({
  user: userSummarySchema,
  /** 被授权人的账户状态 */
  status: z.enum(USER_STATUSES),
  role: z.enum(GRANT_ROLES),
  /** 最后设置这个角色的人 */
  grantedBy: userSummarySchema,
  /** 最后设置这个角色的时间 */
  grantedAt: z.iso.datetime(),
})

export type DocumentGrant = z.infer<typeof documentGrantSchema>

/** 这份文档的授权列表：一份文档的授权至多是全部同事，不分页（与成员列表相同）。 */
export const documentGrantListResponseSchema = z.object({
  items: z.array(documentGrantSchema),
})

export type DocumentGrantListResponse = z.infer<typeof documentGrantListResponseSchema>

/**
 * 设置或调整授权（PUT /api/documents/{id}/grants/{userId}，路径里的 id 用 documentIdSchema 与 userIdSchema）：
 * 按状态幂等，不带 requestId（规范 §4 只要求新建与保存带）。响应是这一条授权（documentGrantSchema）
 */
export const setDocumentGrantRequestSchema = z.strictObject({
  role: z.enum(GRANT_ROLES),
})

export type SetDocumentGrantRequest = z.infer<typeof setDocumentGrantRequestSchema>

/** "与我共享"每页的条数（keyset 分页，与搜索同一个做法：固定大小，不由客户端指定）。 */
export const SHARED_PAGE_SIZE = 50

/** "与我共享"（GET /api/shared）：上一页给出的游标（不透明的字符串）。 */
export const sharedListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
})

export type SharedListQuery = z.infer<typeof sharedListQuerySchema>

/**
 * "与我共享"的一条：我有单独授权的一份文档（不论我在那个空间里有没有角色）。文档的元数据不带文件夹；
 * contentRole 是我对这份文档的内容权限——空间角色与授权取较高者，归档的空间里至多是查看者（与文档详情的权限同一套规则）。
 */
export const sharedDocumentSchema = documentSummarySchema.extend({
  /**
   * 所在的空间：只有类型与认得出它的东西，没有目录结构（M2-P5 设计 §3.4(4)）——团队空间是名称，个人空间是所有者，
   * 不给存的名称（spaceIdentitySchema，与搜索结果同一个结构）
   */
  space: spaceIdentitySchema,
  contentRole: z.enum(SPACE_ROLES),
})

export type SharedDocument = z.infer<typeof sharedDocumentSchema>

/** 按更新时间从新到旧（与文档列表相同）；还有下一页时给出游标。 */
export const sharedListResponseSchema = z.object({
  items: z.array(sharedDocumentSchema),
  nextCursor: z.string().nullable(),
})

export type SharedListResponse = z.infer<typeof sharedListResponseSchema>

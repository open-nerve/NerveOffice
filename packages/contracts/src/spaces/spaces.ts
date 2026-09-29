import { z } from 'zod'
import { codePointLength, hasControlCharacters } from '../text/text.ts'
import { USER_STATUSES, userSummarySchema } from '../users/users.ts'

/** 空间类型（00 号计划书 §5.1）：个人空间；团队空间（M2-P2）。新增取值时，同时用迁移更新 spaces.type 的 CHECK 约束。 */
export const SPACE_TYPES = ['personal', 'team'] as const
export type SpaceType = (typeof SPACE_TYPES)[number]

/** 空间状态：正常；归档（M2-P2，只有团队空间能归档）。新增取值时，同时用迁移更新 spaces.status 的 CHECK 约束。 */
export const SPACE_STATUSES = ['active', 'archived'] as const
export type SpaceStatus = (typeof SPACE_STATUSES)[number]

/**
 * 空间角色（00 号计划书 §5.2），按从低到高排列：查看者、编辑者、空间管理员。个人空间的所有者相当于空间管理员。
 * 新增取值时，同时用迁移更新 space_members.role 的 CHECK 约束。
 */
export const SPACE_ROLES = ['viewer', 'editor', 'admin'] as const
export type SpaceRole = (typeof SPACE_ROLES)[number]

/** 空间名称的上限（字符数，按码点计）。 */
export const SPACE_NAME_MAX_LENGTH = 100

/** 团队空间的名称：去掉首尾空白之后 1–100 个字符，不含控制字符。 */
export const spaceNameSchema = z.string()
  .trim()
  .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= SPACE_NAME_MAX_LENGTH, `名称为 1–${SPACE_NAME_MAX_LENGTH} 个字符`)
  .refine(value => !hasControlCharacters(value), '名称不能包含控制字符')

/** 路径里的空间 id */
export const spaceIdSchema = z.uuid()

/** 调用者在这个空间里能做的操作：界面据此只显示能做的，服务端按同一套规则检查（M2-P2 设计 §3.4）。 */
export const spacePermissionsSchema = z.object({
  canCreateDocuments: z.boolean(),
  canViewMembers: z.boolean(),
  canManageMembers: z.boolean(),
  canRename: z.boolean(),
})

export type SpacePermissions = z.infer<typeof spacePermissionsSchema>

/** 我能看到的空间（GET /api/spaces 的条目、GET /api/spaces/{id}）。响应的结构宽松，见 auth 的会话信息。 */
export const spaceViewSchema = z.object({
  id: z.uuid(),
  type: z.enum(SPACE_TYPES),
  name: z.string(),
  status: z.enum(SPACE_STATUSES),
  visibleToAll: z.boolean(),
  /** 调用者的有效空间角色：全员可见的空间至少是查看者，归档的空间至多是查看者 */
  role: z.enum(SPACE_ROLES),
  permissions: spacePermissionsSchema,
})

export type SpaceView = z.infer<typeof spaceViewSchema>

/** 我能看到的空间：个人空间在前，团队空间按名称排序（M2-P2 设计 §3.3）。 */
export const spaceListResponseSchema = z.object({
  items: z.array(spaceViewSchema),
})

export type SpaceListResponse = z.infer<typeof spaceListResponseSchema>

/**
 * 团队空间的基本信息：成员页的页头、改名的响应。不带调用者的角色：没有加入的系统管理员也在这些地方管理团队空间，
 * 而空间的内容对他是看不到的。
 */
export const teamSpaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(SPACE_STATUSES),
  visibleToAll: z.boolean(),
})

export type TeamSpace = z.infer<typeof teamSpaceSchema>

/** 改名（PUT /api/spaces/{id}/name）：只有团队空间能改名；响应是改名之后的 TeamSpace。 */
export const renameSpaceRequestSchema = z.strictObject({
  name: spaceNameSchema,
})

export type RenameSpaceRequest = z.infer<typeof renameSpaceRequestSchema>

/** 空间的成员（GET /api/spaces/{id}/members 的条目）。 */
export const spaceMemberSchema = z.object({
  user: userSummarySchema,
  /** 账户状态：停用的成员照样列出，空间管理员据此清理 */
  status: z.enum(USER_STATUSES),
  role: z.enum(SPACE_ROLES),
  createdAt: z.iso.datetime(),
})

export type SpaceMember = z.infer<typeof spaceMemberSchema>

/**
 * 成员列表：先按角色（空间管理员、编辑者、查看者）、再按显示名排序；不分页（M2-P2 设计 §7）。
 * 带上空间的名称与状态：没有加入的系统管理员也在这一页管理成员，而空间页对他是看不到的。
 */
export const spaceMemberListResponseSchema = z.object({
  space: teamSpaceSchema,
  /** 调用者能不能添加、调整、移出成员 */
  canManage: z.boolean(),
  items: z.array(spaceMemberSchema),
})

export type SpaceMemberListResponse = z.infer<typeof spaceMemberListResponseSchema>

/** 添加成员（POST /api/spaces/{id}/members）：按名字搜索同事之后选中的账户与角色。 */
export const addSpaceMemberRequestSchema = z.strictObject({
  userId: z.uuid(),
  role: z.enum(SPACE_ROLES),
})

export type AddSpaceMemberRequest = z.infer<typeof addSpaceMemberRequestSchema>

/** 调整角色（PUT /api/spaces/{id}/members/{userId}）。 */
export const changeSpaceMemberRoleRequestSchema = z.strictObject({
  role: z.enum(SPACE_ROLES),
})

export type ChangeSpaceMemberRoleRequest = z.infer<typeof changeSpaceMemberRoleRequestSchema>

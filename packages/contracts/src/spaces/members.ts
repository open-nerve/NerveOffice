import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { USER_STATUSES, userSummarySchema } from '../users/users.ts'
import { SPACE_ROLES, teamSpaceSchema } from './spaces.ts'

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
  userId: uuidSchema,
  role: z.enum(SPACE_ROLES),
})

export type AddSpaceMemberRequest = z.infer<typeof addSpaceMemberRequestSchema>

/** 调整角色（PUT /api/spaces/{id}/members/{userId}）。 */
export const changeSpaceMemberRoleRequestSchema = z.strictObject({
  role: z.enum(SPACE_ROLES),
})

export type ChangeSpaceMemberRoleRequest = z.infer<typeof changeSpaceMemberRoleRequestSchema>

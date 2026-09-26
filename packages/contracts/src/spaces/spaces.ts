/** 空间类型（00 号计划书 §5.1）：M1 只有个人空间，M2 加上团队空间。新增取值时，同时用迁移更新 spaces.type 的 CHECK 约束。 */
export const SPACE_TYPES = ['personal'] as const
export type SpaceType = (typeof SPACE_TYPES)[number]

/** 空间状态：M2 加上归档（archived）。新增取值时，同时用迁移更新 spaces.status 的 CHECK 约束。 */
export const SPACE_STATUSES = ['active'] as const
export type SpaceStatus = (typeof SPACE_STATUSES)[number]

/** 空间名称的上限（字符数，按码点计）。 */
export const SPACE_NAME_MAX_LENGTH = 100

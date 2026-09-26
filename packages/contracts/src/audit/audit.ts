import { z } from 'zod'

/**
 * 审计动作（规范 §7）：M1 要记录的全部动作。
 * 以后各 M 新增动作时，同时用迁移更新数据库的 CHECK 约束（audit_events.action）；已发布的动作不改名、不复用。
 */
export const AUDIT_ACTIONS = [
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.logout',
  'users.admin_initialized',
  'documents.created',
] as const

export const auditActionSchema = z.enum(AUDIT_ACTIONS)

export type AuditAction = z.infer<typeof auditActionSchema>

/** 操作者：用户、系统（例如命令行初始化管理员）、未登录的访问者（例如登录失败）。 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'anonymous'] as const

/** 操作的对象。 */
export const AUDIT_TARGET_TYPES = ['user', 'space', 'document'] as const

/** 来源：HTTP 请求或命令行。 */
export const AUDIT_SOURCES = ['http', 'cli'] as const

/** 补充信息（details）按 JSON 文本计的上限（字节）。 */
export const AUDIT_DETAILS_MAX_BYTES = 4096

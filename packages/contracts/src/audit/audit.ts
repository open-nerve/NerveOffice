import { z } from 'zod'

/**
 * 审计动作（规范 §7）。
 * 各 M 新增动作时，同时用迁移更新数据库的 CHECK 约束（audit_events.action）；已发布的动作不改名、不复用。
 */
export const AUDIT_ACTIONS = [
  // M1
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.logout',
  'users.admin_initialized',
  'documents.created',
  'documents.content_saved',
  // M2-P1：一次性链接不能用（没有这个令牌、过期、已用、已作废）；锁定期间只记日志
  'auth.link_rejected',
  // M2-P1：邀请注册、密码、账户的状态与系统角色
  'users.invited',
  'users.invitation_revoked',
  'users.invitation_accepted',
  'users.password_changed',
  'users.password_reset_issued',
  'users.password_reset_completed',
  'users.disabled',
  'users.enabled',
  'users.system_role_changed',
] as const

export const auditActionSchema = z.enum(AUDIT_ACTIONS)

export type AuditAction = z.infer<typeof auditActionSchema>

/** 操作者：用户、系统（例如命令行初始化管理员）、未登录的访问者（例如登录失败）。 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'anonymous'] as const

/** 操作的对象。新增取值时，同时用迁移更新 CHECK 约束（audit_events.target_type）。 */
export const AUDIT_TARGET_TYPES = ['user', 'space', 'document', 'invitation'] as const

/** 来源：HTTP 请求或命令行。 */
export const AUDIT_SOURCES = ['http', 'cli'] as const

/** 补充信息（details）按 JSON 文本计的上限（字节）。 */
export const AUDIT_DETAILS_MAX_BYTES = 4096

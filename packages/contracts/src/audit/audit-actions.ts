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

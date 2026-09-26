// auth 模块的表（P3 设计 §3.2、§3.5）：登录会话与登录限流的计数。令牌与计数的键都只存 SHA-256 摘要。
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { bytea, oneOf } from '../common/index.ts'
import { users } from '../users/index.ts'

/** 会话被撤销的原因：退出；同一个浏览器重新登录时换掉原来的会话。M2 加上改密、停用等。新增取值时同时用迁移更新 CHECK 约束 */
export const SESSION_REVOKE_REASONS = ['logout', 'replaced'] as const
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number]

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason', { enum: SESSION_REVOKE_REASONS }),
}, table => [
  uniqueIndex('auth_sessions_token_hash_key').on(table.tokenHash),
  // M2 停用账户、修改密码时撤销这个人的全部会话
  index('auth_sessions_user_idx').on(table.userId),
  // 清理过期的会话；撤销时空闲过期一并提前到撤销的时间，清理只看这一列
  index('auth_sessions_idle_expires_at_idx').on(table.idleExpiresAt),
  check('auth_sessions_token_hash_check', sql`octet_length(${table.tokenHash}) = 32`),
  check('auth_sessions_expiry_check', sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`),
  check('auth_sessions_revoked_reason_check', oneOf(table.revokedReason, SESSION_REVOKE_REASONS)),
  check('auth_sessions_revoked_check', sql`(${table.revokedAt} IS NULL) = (${table.revokedReason} IS NULL)`),
])

export const authLoginThrottles = pgTable('auth_login_throttles', {
  // "用户名：xxx""地址：xxx"的摘要：不存用户输入的原文
  keyHash: bytea('key_hash').primaryKey(),
  failures: integer('failures').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
}, table => [
  // 清理窗口与锁定都已过期的计数
  index('auth_login_throttles_window_started_at_idx').on(table.windowStartedAt),
  check('auth_login_throttles_key_hash_check', sql`octet_length(${table.keyHash}) = 32`),
  check('auth_login_throttles_failures_check', sql`${table.failures} >= 1`),
])

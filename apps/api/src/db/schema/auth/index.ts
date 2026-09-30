// auth 模块的表（P3 设计 §3.2、§3.5；M2-P1 设计 §3.2）：登录会话、登录限流的计数、邀请与重置密码的一次性令牌。
// 令牌与计数的键都只存 SHA-256 摘要。
import { DISPLAY_NAME_MAX_LENGTH, USERNAME_PATTERN_SOURCE } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { bytea, lengthBetween, oneOf, stringLiteral } from '../common/index.ts'
import { users } from '../users/index.ts'

/**
 * 会话被撤销的原因：退出；同一个浏览器重新登录时换掉原来的会话；账户停用；修改密码（本人的其他会话）；
 * 重置密码（签发与完成时）。新增取值时同时用迁移更新 CHECK 约束
 */
export const SESSION_REVOKE_REASONS = ['logout', 'replaced', 'disabled', 'password_changed', 'password_reset'] as const
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
  // 计数键（"账户：xxx""账户与地址：xxx""地址：xxx"等，见 auth 的 throttle-keys）的摘要：不存用户输入的原文
  keyHash: bytea('key_hash').primaryKey(),
  // 窗口内失败与正在验证的尝试次数：验证之前先占用名额，成功时退回，所以可以回到 0
  failures: integer('failures').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  // 所属账户（M2-P6 复核 A1）：登录的两个账户相关的维度才有，是账户维度的键的摘要。按它一次清掉这个账户在所有来源上的计数
  // （完成重置密码、管理员解除锁定），也按它查这个账户锁定到什么时候（管理界面）
  accountHash: bytea('account_hash'),
}, table => [
  // 清理窗口与锁定都已过期的计数
  index('auth_login_throttles_window_started_at_idx').on(table.windowStartedAt),
  index('auth_login_throttles_account_hash_idx').on(table.accountHash).where(sql`${table.accountHash} IS NOT NULL`),
  check('auth_login_throttles_key_hash_check', sql`octet_length(${table.keyHash}) = 32`),
  check('auth_login_throttles_account_hash_check', sql`${table.accountHash} IS NULL OR octet_length(${table.accountHash}) = 32`),
  check('auth_login_throttles_failures_check', sql`${table.failures} >= 0`),
])

/**
 * 邀请（M2-P1 设计 §3.4）：管理员填好登录名与显示名，签发一次性链接。
 * "已过期"按 expires_at 在查询时判断，不靠定时任务改状态；接受与作废最多有一个。
 */
export const authInvitations = pgTable('auth_invitations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  // 规范写法（小写），与账户表同一条规则
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'restrict' }),
}, table => [
  uniqueIndex('auth_invitations_token_hash_key').on(table.tokenHash),
  // 同一个登录名最多一条未接受、未作废的邀请；已过期而未处理的，由签发新邀请的事务先作废
  uniqueIndex('auth_invitations_open_username_key').on(table.username).where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  // 列表按签发时间从新到旧分页
  index('auth_invitations_created_at_idx').on(table.createdAt, table.id),
  // 一个账户至多由一条邀请建成（M2-P6 复核 G-4）：接受时建账户与标记已接受在同一个事务里，这里是库里的兜底
  uniqueIndex('auth_invitations_accepted_user_key').on(table.acceptedUserId),
  check('auth_invitations_token_hash_check', sql`octet_length(${table.tokenHash}) = 32`),
  check('auth_invitations_username_check', sql`${table.username} ~ ${stringLiteral(USERNAME_PATTERN_SOURCE)}`),
  check('auth_invitations_display_name_check', lengthBetween(table.displayName, 1, DISPLAY_NAME_MAX_LENGTH)),
  check('auth_invitations_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  check('auth_invitations_accepted_check', sql`(${table.acceptedAt} IS NULL) = (${table.acceptedUserId} IS NULL)`),
  check('auth_invitations_revoked_check', sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`),
  check('auth_invitations_outcome_check', sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`),
])

/**
 * 重置密码（M2-P1 设计 §3.4）：管理员（或运维命令）为某个账户签发一次性链接。
 * 同一个账户最多一条未使用、未作废的重置；使用与作废最多有一个。
 */
export const authPasswordResets = pgTable('auth_password_resets', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  tokenHash: bytea('token_hash').notNull(),
  // 签发人；运维命令签发的为空
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [
  uniqueIndex('auth_password_resets_token_hash_key').on(table.tokenHash),
  // 同一个账户最多一条未使用、未作废的重置：签发新的时先作废旧的
  uniqueIndex('auth_password_resets_open_user_key').on(table.userId).where(sql`${table.usedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  check('auth_password_resets_token_hash_check', sql`octet_length(${table.tokenHash}) = 32`),
  check('auth_password_resets_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  check('auth_password_resets_outcome_check', sql`${table.usedAt} IS NULL OR ${table.revokedAt} IS NULL`),
])

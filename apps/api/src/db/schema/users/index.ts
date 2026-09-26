// users 模块的表（P3 设计 §3.2）：账户。用户名存小写的规范写法，唯一。
import { DISPLAY_NAME_MAX_LENGTH, USER_STATUSES, USER_SYSTEM_ROLES, USERNAME_PATTERN_SOURCE } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { lengthBetween, oneOf, stringLiteral } from '../common/index.ts'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  // enum 只收窄 TypeScript 的类型，数据库里仍是 text 加 CHECK
  systemRole: text('system_role', { enum: USER_SYSTEM_ROLES }).notNull(),
  status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('users_username_key').on(table.username),
  check('users_username_check', sql`${table.username} ~ ${stringLiteral(USERNAME_PATTERN_SOURCE)}`),
  check('users_display_name_check', lengthBetween(table.displayName, 1, DISPLAY_NAME_MAX_LENGTH)),
  // 只存 Argon2id 的哈希：代码写错时也存不进明文
  check('users_password_hash_check', sql`${table.passwordHash} LIKE '$argon2id$%'`),
  check('users_system_role_check', oneOf(table.systemRole, USER_SYSTEM_ROLES)),
  check('users_status_check', oneOf(table.status, USER_STATUSES)),
])

// spaces 模块的表（P3 设计 §3.2）：空间。M1 只有个人空间，每人一个，只有所有者可见。
import { SPACE_NAME_MAX_LENGTH, SPACE_STATUSES, SPACE_TYPES } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { lengthBetween, oneOf } from '../common/index.ts'
import { users } from '../users/index.ts'

export const spaces = pgTable('spaces', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  // enum 只收窄 TypeScript 的类型，数据库里仍是 text 加 CHECK
  type: text('type', { enum: SPACE_TYPES }).notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: SPACE_STATUSES }).notNull().default('active'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
  visibleToAll: boolean('visible_to_all').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('spaces_type_check', oneOf(table.type, SPACE_TYPES)),
  check('spaces_status_check', oneOf(table.status, SPACE_STATUSES)),
  check('spaces_name_check', lengthBetween(table.name, 1, SPACE_NAME_MAX_LENGTH)),
  // 个人空间必须有所有者，并且不能设为全员可见（00 号计划书 §5.1）
  check('spaces_personal_check', sql`${table.type} <> 'personal' OR (${table.ownerUserId} IS NOT NULL AND NOT ${table.visibleToAll})`),
  uniqueIndex('spaces_personal_owner_key').on(table.ownerUserId).where(sql`${table.type} = 'personal'`),
])

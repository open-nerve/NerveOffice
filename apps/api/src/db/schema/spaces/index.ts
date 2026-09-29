// spaces 模块的表：空间（M1-P3 设计 §3.2；M2-P2 设计 §3.2 加上团队空间、归档、创建人）与团队空间的成员（M2-P2）。
import { SPACE_NAME_MAX_LENGTH, SPACE_ROLES, SPACE_STATUSES, SPACE_TYPES } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
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
  // 团队空间的创建人（系统管理员）；个人空间随账户一起建，没有创建人
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('spaces_type_check', oneOf(table.type, SPACE_TYPES)),
  check('spaces_status_check', oneOf(table.status, SPACE_STATUSES)),
  check('spaces_name_check', lengthBetween(table.name, 1, SPACE_NAME_MAX_LENGTH)),
  // 个人空间必须有所有者，没有创建人，不能设为全员可见，也不能归档（00 号计划书 §5.1）
  check('spaces_personal_check', sql`${table.type} <> 'personal' OR (${table.ownerUserId} IS NOT NULL AND ${table.createdBy} IS NULL AND NOT ${table.visibleToAll} AND ${table.status} = 'active')`),
  // 团队空间归空间所有，没有所有者；由系统管理员创建（00 号计划书 §5.1）
  check('spaces_team_check', sql`${table.type} <> 'team' OR (${table.ownerUserId} IS NULL AND ${table.createdBy} IS NOT NULL)`),
  uniqueIndex('spaces_personal_owner_key').on(table.ownerUserId).where(sql`${table.type} = 'personal'`),
  // 团队空间的名称不区分大小写唯一，已归档的也算：导航里同名的空间无法区分（M2-P2 设计 §3.2）
  uniqueIndex('spaces_team_name_key').on(sql`lower(${table.name})`).where(sql`${table.type} = 'team'`),
])

/**
 * 团队空间的成员与空间角色（M2-P2 设计 §3.2）。只有团队空间有成员，由 spaces 的服务保证；
 * 访问策略计算个人空间时只看所有者，不看这张表。
 */
export const spaceMembers = pgTable('space_members', {
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  role: text('role', { enum: SPACE_ROLES }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: 'space_members_pkey', columns: [table.spaceId, table.userId] }),
  check('space_members_role_check', oneOf(table.role, SPACE_ROLES)),
  // 一个人所在的团队空间（导航、"可访问文档"）
  index('space_members_user_idx').on(table.userId),
])

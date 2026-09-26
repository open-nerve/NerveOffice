// documents 模块的表（P3 设计 §3.2）：文档的元数据。P4 按"只做加法"补上修订号、unitId、插件档案与内容表。
import { DOCUMENT_STATUSES, DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_TYPES } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { lengthBetween, oneOf } from '../common/index.ts'
import { spaces } from '../spaces/index.ts'
import { users } from '../users/index.ts'

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'restrict' }),
  // enum 只收窄 TypeScript 的类型，数据库里仍是 text 加 CHECK
  type: text('type', { enum: DOCUMENT_TYPES }).notNull(),
  title: text('title').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('documents_type_check', oneOf(table.type, DOCUMENT_TYPES)),
  check('documents_status_check', oneOf(table.status, DOCUMENT_STATUSES)),
  check('documents_title_check', lengthBetween(table.title, 1, DOCUMENT_TITLE_MAX_LENGTH)),
  // 列表按空间、更新时间从新到旧分页（keyset）
  index('documents_space_updated_idx').on(table.spaceId, table.updatedAt.desc(), table.id.desc()),
])

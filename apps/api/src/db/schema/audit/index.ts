// audit 模块的表（P2 设计 §3.8）：审计事件，只追加（UPDATE、DELETE、TRUNCATE 由触发器拒绝，见迁移）。
import { AUDIT_ACTIONS, AUDIT_ACTOR_TYPES, AUDIT_DETAILS_MAX_BYTES, AUDIT_SOURCES, AUDIT_TARGET_TYPES } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { check, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { oneOf } from '../common/index.ts'

/** details 的数据库兜底上限：写入前按 JSON 文本校验 AUDIT_DETAILS_MAX_BYTES；jsonb 转成文本时在冒号、逗号后加空格，比 JSON.stringify 的结果长，留出一倍的余量 */
const AUDIT_DETAILS_MAX_STORED_BYTES = AUDIT_DETAILS_MAX_BYTES * 2

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  action: text('action').notNull(),
  actorType: text('actor_type').notNull(),
  // 不设外键：审计记录不随账户的变化而变化
  actorId: uuid('actor_id'),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  source: text('source').notNull(),
  requestId: text('request_id'),
  clientIp: inet('client_ip'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
}, table => [
  check('audit_events_action_check', oneOf(table.action, AUDIT_ACTIONS)),
  check('audit_events_actor_type_check', oneOf(table.actorType, AUDIT_ACTOR_TYPES)),
  check('audit_events_actor_check', sql`(${table.actorType} = 'user') = (${table.actorId} IS NOT NULL)`),
  check('audit_events_target_type_check', oneOf(table.targetType, AUDIT_TARGET_TYPES)),
  check('audit_events_target_check', sql`(${table.targetType} IS NULL) = (${table.targetId} IS NULL)`),
  check('audit_events_source_check', oneOf(table.source, AUDIT_SOURCES)),
  check('audit_events_http_request_id_check', sql`${table.source} <> 'http' OR ${table.requestId} IS NOT NULL`),
  check('audit_events_client_ip_check', sql`${table.source} = 'http' OR ${table.clientIp} IS NULL`),
  check('audit_events_details_check', sql`jsonb_typeof(${table.details}) = 'object' AND octet_length(${table.details}::text) <= ${sql.raw(String(AUDIT_DETAILS_MAX_STORED_BYTES))}`),
  index('audit_events_occurred_at_idx').on(table.occurredAt),
  index('audit_events_actor_idx').on(table.actorId, table.occurredAt).where(sql`${table.actorId} IS NOT NULL`),
  index('audit_events_target_idx').on(table.targetType, table.targetId, table.occurredAt).where(sql`${table.targetId} IS NOT NULL`),
])

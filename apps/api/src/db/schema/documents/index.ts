// documents 模块的表：文档的元数据（P3 设计 §3.2），当前内容与修订记录（P4 设计 §3.2，只做加法）。
import { DOCUMENT_PROFILES, DOCUMENT_STATUSES, DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_TYPES, PLATFORM_FORMAT_VERSIONS, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { bytea, lengthBetween, oneOf } from '../common/index.ts'
import { spaces } from '../spaces/index.ts'
import { users } from '../users/index.ts'

/** 修订记录的种类：新建（修订号 1）、保存。新增取值时同时用迁移更新 CHECK 约束。 */
export const DOCUMENT_REVISION_KINDS = ['created', 'saved'] as const
export type DocumentRevisionKind = (typeof DOCUMENT_REVISION_KINDS)[number]

/** SDK 版本号的长度上限：只是兜底，版本号由平台写入。 */
const SDK_VERSION_MAX_LENGTH = 64

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
  // 当前修订号：新建为 1，每次保存加一（P4 设计 §3.5.2）
  revision: integer('revision').notNull().default(1),
  // Univer 的 unitId：新建时由服务端生成，写进快照的顶层 id，终身不变（00 号计划书 §8.3）。
  // 不唯一：复制文档时快照原样复制，不改写 unitId，两份文档的 unitId 相同（计划书 §8.3，Codex 评审 CX5）
  unitId: text('unit_id').notNull(),
  profile: text('profile', { enum: DOCUMENT_PROFILES }).notNull(),
  formatVersion: integer('format_version').notNull(),
  // 最近一次写入时的 Univer 版本
  sdkVersion: text('sdk_version').notNull(),
  // 写入代次（00 号计划书 §6.4，M2-P2 设计 §3.7）：删除与跨空间移动在同一个事务里加一；M3 的租约与保存按它与修订号条件写入
  writeEpoch: integer('write_epoch').notNull().default(0),
}, table => [
  check('documents_type_check', oneOf(table.type, DOCUMENT_TYPES)),
  check('documents_status_check', oneOf(table.status, DOCUMENT_STATUSES)),
  check('documents_title_check', lengthBetween(table.title, 1, DOCUMENT_TITLE_MAX_LENGTH)),
  check('documents_revision_check', sql`${table.revision} >= 1`),
  check('documents_profile_check', oneOf(table.profile, DOCUMENT_PROFILES)),
  check('documents_format_version_check', sql`${table.formatVersion} IN (${sql.raw(PLATFORM_FORMAT_VERSIONS.join(', '))})`),
  check('documents_sdk_version_check', lengthBetween(table.sdkVersion, 1, SDK_VERSION_MAX_LENGTH)),
  check('documents_write_epoch_check', sql`${table.writeEpoch} >= 0`),
  // 列表按空间、更新时间从新到旧分页（keyset）
  index('documents_space_updated_idx').on(table.spaceId, table.updatedAt.desc(), table.id.desc()),
])

/** 每份文档一份当前快照：gzip 压缩的快照 JSON 字节，读取时原样下发（00 号计划书 §8.1，不用 jsonb）。 */
export const documentContents = pgTable('document_contents', {
  documentId: uuid('document_id').primaryKey().references(() => documents.id, { onDelete: 'cascade' }),
  snapshot: bytea('snapshot').notNull(),
  // 解压后与压缩后的字节数：容量统计不必解压
  rawBytes: integer('raw_bytes').notNull(),
  storedBytes: integer('stored_bytes').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('document_contents_raw_bytes_check', sql`${table.rawBytes} BETWEEN 1 AND ${sql.raw(String(SNAPSHOT_MAX_RAW_BYTES))}`),
  check('document_contents_stored_bytes_check', sql`${table.storedBytes} = octet_length(${table.snapshot}) AND ${table.storedBytes} BETWEEN 1 AND ${sql.raw(String(SNAPSHOT_MAX_RAW_BYTES))}`),
])

/** 每次新建或保存一行（不存正文）：修订号的来源与 requestId 的幂等（P4 设计 §3.5）。 */
export const documentRevisions = pgTable('document_revisions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  kind: text('kind', { enum: DOCUMENT_REVISION_KINDS }).notNull(),
  // 客户端为每次新建、每次保存尝试生成；相同的 requestId 按负载摘要判断是不是同一个请求
  requestId: uuid('request_id').notNull(),
  payloadDigest: bytea('payload_digest').notNull(),
  // 保存的来源：编辑器页的实例与捕获时的本地修改序号；新建没有来源
  clientInstanceId: uuid('client_instance_id'),
  localSeq: integer('local_seq'),
  savedBy: uuid('saved_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('document_revisions_document_revision_key').on(table.documentId, table.revision),
  unique('document_revisions_request_id_key').on(table.requestId),
  check('document_revisions_revision_check', sql`${table.revision} >= 1`),
  check('document_revisions_kind_check', oneOf(table.kind, DOCUMENT_REVISION_KINDS)),
  // 新建的就是修订号 1，之后的都是保存
  check('document_revisions_created_check', sql`(${table.kind} = 'created') = (${table.revision} = 1)`),
  check('document_revisions_payload_digest_check', sql`octet_length(${table.payloadDigest}) = 32`),
  check('document_revisions_local_seq_check', sql`${table.localSeq} >= 0`),
  // 保存有来源（两项同时有），新建没有
  check('document_revisions_source_check', sql`(${table.clientInstanceId} IS NULL) = (${table.kind} = 'created') AND (${table.clientInstanceId} IS NULL) = (${table.localSeq} IS NULL)`),
])

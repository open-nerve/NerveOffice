// documents 模块的表：文档的元数据（P3 设计 §3.2），当前内容与修订记录（P4 设计 §3.2，只做加法），
// 文件夹与删除单元（M2-P4 设计 §3.3：与文档共用有效权限、空间事实与审计，所以放在同一个模块里）。
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { DOCUMENT_PROFILES, DOCUMENT_STATUSES, DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_TYPES, FOLDER_MAX_DEPTH, FOLDER_NAME_MAX_LENGTH, PLATFORM_FORMAT_VERSIONS, SNAPSHOT_MAX_RAW_BYTES, TRASH_ENTRY_KINDS } from '@nerve-office/contracts'
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

/**
 * 回收站里的一个删除单元（M2-P4 设计 §3.3）：一次删除操作生成一条，子树里的每一行都指向它。
 * 原位置（origin_space_id、origin_parent_id）只是记录，不做外键：原来的空间或父文件夹可能已经不在了，
 * 恢复时按它当前是否还在判断（与审计表的 actor_id 同样的理由）。
 */
export const trashEntries = pgTable('trash_entries', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  // 现在在哪个空间的回收站里：跨空间移动过的文档删除后，进的是它当时所在的空间
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'restrict' }),
  kind: text('kind', { enum: TRASH_ENTRY_KINDS }).notNull(),
  deletedBy: uuid('deleted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  // 到期自动永久删除的时刻（删除时的时间加 30 天）
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  originSpaceId: uuid('origin_space_id').notNull(),
  originParentId: uuid('origin_parent_id'),
  // 删除时的标题或名称：回收站的列表不必去联表读已经在回收站里的行
  title: text('title').notNull(),
}, table => [
  check('trash_entries_kind_check', oneOf(table.kind, TRASH_ENTRY_KINDS)),
  check('trash_entries_title_check', lengthBetween(table.title, 1, DOCUMENT_TITLE_MAX_LENGTH)),
  check('trash_entries_expires_check', sql`${table.expiresAt} > ${table.deletedAt}`),
  // 按空间列出回收站，删除时间从新到旧分页（keyset）
  index('trash_entries_space_deleted_idx').on(table.spaceId, table.deletedAt.desc(), table.id.desc()),
  // 到期清理按这个取一批
  index('trash_entries_expires_idx').on(table.expiresAt),
])

/**
 * 空间里的多级目录（M2-P4 设计 §3.3）。层数（depth）存在列里，不靠递归算：
 * 新建与移动时在事务里算好并校验，移动子树时整棵加上差值，"最多 FOLDER_MAX_DEPTH 层"因此是一条 CHECK。
 * 同一个文件夹里允许同名（M2 总设计 §6.8）：(space_id, parent_id, name) 只是索引，不是唯一约束。
 */
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'restrict' }),
  // 父文件夹；在空间的根目录下时为空。自引用要写出列的类型，否则类型推断成环
  parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('active'),
  trashEntryId: uuid('trash_entry_id').references(() => trashEntries.id, { onDelete: 'restrict' }),
  // 第几层：空间根目录下的文件夹是 1
  depth: integer('depth').notNull(),
  // 客户端为每一次新建生成：同一个文件夹里允许同名，重试重发时只能靠它判断是不是同一次新建（P4 设计 §3.2）
  requestId: uuid('request_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('folders_name_check', lengthBetween(table.name, 1, FOLDER_NAME_MAX_LENGTH)),
  check('folders_status_check', oneOf(table.status, DOCUMENT_STATUSES)),
  check('folders_depth_check', sql`${table.depth} BETWEEN 1 AND ${sql.raw(String(FOLDER_MAX_DEPTH))}`),
  // 根目录下的文件夹一定是第 1 层；有父文件夹时至少是第 2 层（父子的层差由服务保证）
  check('folders_root_depth_check', sql`(${table.parentId} IS NULL) = (${table.depth} = 1)`),
  // 在回收站里（trashed）与属于某个删除单元是同一件事（M2-P4 设计 §3.4 第 3 条）
  check('folders_trash_entry_check', sql`(${table.trashEntryId} IS NULL) = (${table.status} = 'active')`),
  unique('folders_request_id_key').on(table.requestId),
  // 列出一层：某个空间里某个父文件夹的直接子文件夹，按名称排序
  index('folders_space_parent_name_idx').on(table.spaceId, table.parentId, table.name),
  // 恢复与永久删除时按删除单元取出整棵子树
  index('folders_trash_entry_idx').on(table.trashEntryId).where(sql`${table.trashEntryId} IS NOT NULL`),
])

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'restrict' }),
  // 所在的文件夹；空间的根目录下时为空（M2-P4 设计 §3.3）
  folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'restrict' }),
  // 在回收站里时指向所属的删除单元；正常状态时为空（由下面的 CHECK 保证两者一致）
  trashEntryId: uuid('trash_entry_id').references(() => trashEntries.id, { onDelete: 'restrict' }),
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
  // 在回收站里（trashed）与属于某个删除单元是同一件事（M2-P4 设计 §3.4 第 3 条）
  check('documents_trash_entry_check', sql`(${table.trashEntryId} IS NULL) = (${table.status} = 'active')`),
  // 列表按空间、更新时间从新到旧分页（keyset）；folderId=all 时用它
  index('documents_space_updated_idx').on(table.spaceId, table.updatedAt.desc(), table.id.desc()),
  // 同上，按目录过滤时用它（省略 folderId 表示空间的根目录，folder_id IS NULL）
  index('documents_space_folder_updated_idx').on(table.spaceId, table.folderId, table.updatedAt.desc(), table.id.desc()),
  // 恢复与永久删除时按删除单元取出全部文档
  index('documents_trash_entry_idx').on(table.trashEntryId).where(sql`${table.trashEntryId} IS NOT NULL`),
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

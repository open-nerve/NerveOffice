// documents 模块的表：文档的元数据（P3 设计 §3.2），当前内容与修订记录（P4 设计 §3.2，只做加法），
// 文件夹与删除单元（M2-P4 设计 §3.3：与文档共用有效权限、空间事实与审计，所以放在同一个模块里），
// 单独授权（M2-P5 设计 §3.3：有效权限并上授权，唯一入口在 documents），
// 编辑租约（M3-P1 设计 §3.1、§3.3：保存在文档行的锁下核对它，按空间收回写入权要把它与文档连起来查，所以也在这里），
// 保存的回执（M3-P3 设计 §3.4、§3.7：内容相同、修订号没变的确认，与修订记录一起做 requestId 的幂等）。
import type { EditLeaseLostReason } from '@nerve-office/contracts'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { CLIENT_BUILD_MAX_LENGTH, DOCUMENT_PROFILES, DOCUMENT_STATUSES, DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_TYPES, FOLDER_MAX_DEPTH, FOLDER_NAME_MAX_LENGTH, GRANT_ROLES, PLATFORM_FORMAT_VERSIONS, SNAPSHOT_MAX_RAW_BYTES, TRASH_ENTRY_KINDS } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { allOrNone, bytea, lengthBetween, oneOf } from '../common/index.ts'
import { spaces } from '../spaces/index.ts'
import { users } from '../users/index.ts'

/** 修订记录的种类：新建（修订号 1）、保存。新增取值时同时用迁移更新 CHECK 约束。 */
export const DOCUMENT_REVISION_KINDS = ['created', 'saved'] as const
export type DocumentRevisionKind = (typeof DOCUMENT_REVISION_KINDS)[number]

/** SDK 版本号的长度上限：只是兜底，版本号是客户端上报、服务端核对过的（M3-P3 设计 §3.5）。 */
const SDK_VERSION_MAX_LENGTH = 64

/** 内容哈希与负载摘要的字节数：SHA-256 */
const SHA256_BYTES = 32

/**
 * 回收站里的一个删除单元（M2-P4 设计 §3.3）：一次删除操作生成一条，子树里的每一行都指向它。
 * 原位置只记父文件夹（origin_parent_id），不做外键：父文件夹之后可能被永久删除，恢复时按它当前是否还在判断
 * （与审计表的 actor_id 同样的理由）。原来的空间不另记：删除单元总在它的行所在的空间里，跨空间移动时随子树一起搬
 * （M2-P6 复核 B 的 G4 删掉了总是等于 space_id、也没有人读的 origin_space_id）。
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
  // 新建请求的摘要（空间、父文件夹、名称，documents 的 folderCreatedPayloadDigest）：新建时写入、之后不改。
  // 同一个 requestId 的重试按它判断是不是同一个请求，不拿请求与现在的名称、位置比较——建好之后改名或移动过，原样的重试照样是重放
  // （M2 Codex 评审 CX6，与修订记录的 payload_digest 同一个做法）
  payloadDigest: bytea('payload_digest').notNull(),
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
  check('folders_payload_digest_check', sql`octet_length(${table.payloadDigest}) = 32`),
  unique('folders_request_id_key').on(table.requestId),
  // 列出一层：索引定位"某个空间里某个父文件夹的直接子文件夹"这一段行。
  // 排序用不上它：列表按 lower(name) 排（不区分大小写），要走索引得另建一个 lower(name) 的表达式索引。
  // 本版不建这个表达式索引。理由不是"一层的行数有上限"：DEF-030 的 500 条只是一次响应最多给多少条，
  // 服务端并不限制一层能存多少个文件夹。理由是本版的规模——单租户、一个团队自己用，一层不会有多到让内存排序成为瓶颈的文件夹。
  // 真要支持很大的一层，得同时加 lower(name) 的表达式索引与按这个顺序的分页（只加索引不分页仍然要把整层读出来），
  // 两件事一起做，记在 DEF-030 下（M2-P4 复验 G1 的注释订正）
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
  // 最近一次写入时的 Univer 版本（M3-P3 起是客户端上报、服务端核对过等于自己的；新建是服务端内置的）
  sdkVersion: text('sdk_version').notNull(),
  // 最近一次写入的客户端构建（M3-P3 设计 §3.4、§3.5，00 号计划书 §8.1 的信封）：x.y.z，可带 + 之后的诊断信息；
  // 新建（服务端写模板）与 P3 之前的为空，复制照源文档
  clientBuild: text('client_build'),
  // "公式待更新"（M3-P3 设计 §3.8）：最近一次写入的快照里公式结果可能还没算完。每次成功的写入（包括内容相同、修订号不变的保存）
  // 设成请求里的值；编辑状态、申请编辑权与详情直接读它，不联表。存量一律没有标记
  formulasPending: boolean('formulas_pending').notNull().default(false),
  // 写入代次（00 号计划书 §6.4，M2-P2 设计 §3.7）：删除与跨空间移动在同一个事务里加一；M3 的租约与保存按它与修订号条件写入。
  // 只增不减由迁移里手写的触发器 documents_write_epoch_monotonic 兜底（M2-P6 复核 B 的 G5），表定义里写不出触发器
  writeEpoch: integer('write_epoch').notNull().default(0),
}, table => [
  check('documents_type_check', oneOf(table.type, DOCUMENT_TYPES)),
  check('documents_status_check', oneOf(table.status, DOCUMENT_STATUSES)),
  check('documents_title_check', lengthBetween(table.title, 1, DOCUMENT_TITLE_MAX_LENGTH)),
  check('documents_revision_check', sql`${table.revision} >= 1`),
  check('documents_profile_check', oneOf(table.profile, DOCUMENT_PROFILES)),
  check('documents_format_version_check', sql`${table.formatVersion} IN (${sql.raw(PLATFORM_FORMAT_VERSIONS.join(', '))})`),
  check('documents_sdk_version_check', lengthBetween(table.sdkVersion, 1, SDK_VERSION_MAX_LENGTH)),
  check('documents_client_build_check', lengthBetween(table.clientBuild, 1, CLIENT_BUILD_MAX_LENGTH)),
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
  // 规范化的内容哈希（M3-P3 设计 §3.2、§3.7：contracts 的规范化文字的 SHA-256）："内容相同不递增"拿它与上传的比较。
  // 存量（P3 之前写的）为空，比较时按"不同"处理，第一次写入时补上（不回填：要解压、解析每一份快照，只能在应用里做）
  contentHash: bytea('content_hash'),
  // 这一版里非空的资源名（按名称排序，M3-P3 设计 §3.3）：下一次保存的"不缩水"按它核对，事务里不必解析上一版。与内容哈希同时写，
  // 存量同样为空——那时解析上一版得到
  resourceNames: text('resource_names').array(),
}, table => [
  check('document_contents_raw_bytes_check', sql`${table.rawBytes} BETWEEN 1 AND ${sql.raw(String(SNAPSHOT_MAX_RAW_BYTES))}`),
  check('document_contents_stored_bytes_check', sql`${table.storedBytes} = octet_length(${table.snapshot}) AND ${table.storedBytes} BETWEEN 1 AND ${sql.raw(String(SNAPSHOT_MAX_RAW_BYTES))}`),
  check('document_contents_content_hash_check', sql`octet_length(${table.contentHash}) = ${sql.raw(String(SHA256_BYTES))}`),
  // 两列是同一次写入的结果：同时为空（存量）或同时有值
  check('document_contents_envelope_check', sql`(${table.contentHash} IS NULL) = (${table.resourceNames} IS NULL)`),
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
  // 这一版的信封（M3-P3 设计 §3.4）：规范化的内容哈希，与写入它的页面的构建（新建、复制是服务端写的，没有构建）。存量为空
  contentHash: bytea('content_hash'),
  clientBuild: text('client_build'),
}, table => [
  unique('document_revisions_document_revision_key').on(table.documentId, table.revision),
  unique('document_revisions_request_id_key').on(table.requestId),
  check('document_revisions_revision_check', sql`${table.revision} >= 1`),
  check('document_revisions_kind_check', oneOf(table.kind, DOCUMENT_REVISION_KINDS)),
  // 新建的就是修订号 1，之后的都是保存
  check('document_revisions_created_check', sql`(${table.kind} = 'created') = (${table.revision} = 1)`),
  check('document_revisions_payload_digest_check', sql`octet_length(${table.payloadDigest}) = 32`),
  check('document_revisions_content_hash_check', sql`octet_length(${table.contentHash}) = ${sql.raw(String(SHA256_BYTES))}`),
  check('document_revisions_client_build_check', lengthBetween(table.clientBuild, 1, CLIENT_BUILD_MAX_LENGTH)),
  check('document_revisions_local_seq_check', sql`${table.localSeq} >= 0`),
  // 保存有来源（两项同时有），新建没有
  check('document_revisions_source_check', sql`(${table.clientInstanceId} IS NULL) = (${table.kind} = 'created') AND (${table.clientInstanceId} IS NULL) = (${table.localSeq} IS NULL)`),
  // 保留期的清理（M3-P3 设计 §3.9）按创建时间取一批
  index('document_revisions_created_idx').on(table.createdAt),
])

/**
 * 保存的回执（M3-P3 设计 §3.7）：内容与当前相同、修订号没有增加的那次保存的确认——不写修订记录，所以另记在这里，
 * 结果未知之后的重试照样拿到原来的结果（A07）。requestId 与修订记录的一起做幂等：保存的重放先查两边（document-content.service.ts）。
 * - revision 与 saved_at 是那次确认给出的结果（当前修订与它的时间），重放原样给出，不依赖那一行修订记录还在不在（保留期）；
 * - 负载摘要与保存的人：同一个人对同一份文档的同一次保存（摘要一致）才算重放；
 * - 永久删除文档时随外键级联删除；保存的人 restrict（账户不删除）；
 * - 按创建时间的索引给保留期的清理（§3.9），按文档的索引给级联删除。
 * 只有不递增的确认写在这里；写入了新修订的保存仍以修订记录为准
 */
export const documentSaveReceipts = pgTable('document_save_receipts', {
  requestId: uuid('request_id').primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  payloadDigest: bytea('payload_digest').notNull(),
  savedBy: uuid('saved_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('document_save_receipts_revision_check', sql`${table.revision} >= 1`),
  check('document_save_receipts_payload_digest_check', sql`octet_length(${table.payloadDigest}) = ${sql.raw(String(SHA256_BYTES))}`),
  index('document_save_receipts_created_idx').on(table.createdAt),
  index('document_save_receipts_document_idx').on(table.documentId),
])

/**
 * 单独授权（M2-P5 设计 §3.3）：空间管理员或个人空间的所有者把一份文档分享给一个同事，角色是查看者或编辑者。
 * 一个人在一份文档上至多一条（主键）：调整就是改角色，取消就是删行——不做软删除，历史在审计里。
 * - 永久删除文档时随之消失（document_id 的外键 ON DELETE CASCADE，ADR-016 的连带）：删除的本体（TrashEntryPurger）因此不必另删；
 * - 移动文档（空间内、跨空间）、移出空间、归档、停用、停用者文档的转移都不动这张表：授权跟着文档走；
 * - 账户不删除（停用可以撤回），user_id 与 granted_by 的外键 restrict。
 * granted_by 是最后设置这个角色的人（新建或调整），updated_at 是那一次的时间。
 * 不能给自己（M2-P5 设计 §3.2：PUT 给自己是 400）：被授权人与最后设置它的人不是同一个，由 CHECK 兜底——granted_by 只记
 * 最后设置它的人，而被授权人设置不了自己的那一条，所以这一条对每一行都成立。
 * 主键覆盖"这份文档的授权列表"与"这个人在这份文档上的授权"；(user_id) 索引给"与我共享"与"可访问文档"的授权那一半
 */
export const documentGrants = pgTable('document_grants', {
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  // enum 只收窄 TypeScript 的类型，数据库里仍是 text 加 CHECK
  role: text('role', { enum: GRANT_ROLES }).notNull(),
  grantedBy: uuid('granted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: 'document_grants_pkey', columns: [table.documentId, table.userId] }),
  check('document_grants_role_check', oneOf(table.role, GRANT_ROLES)),
  check('document_grants_not_self_check', sql`${table.userId} <> ${table.grantedBy}`),
  index('document_grants_user_idx').on(table.userId),
])

/**
 * 编辑租约明确结束的原因（M3-P1 设计 §3.3）：释放（released）、收回写入权（revoked）、交给了请求编辑的人（handed_over，M3-P5 设计 §3.2）。
 * 到期、空闲、登录失效、代次过时不写进这一列，用到时按有效条件算出来（documents 模块的 edit-lease-rules.ts）。这些取值同时是编辑权失效的原因
 * （contracts 的 EDIT_LEASE_LOST_REASONS，有效条件的第 2 条原样给出它）。新增取值时同时用迁移更新 CHECK 约束
 */
export const EDIT_LEASE_END_REASONS = ['released', 'revoked', 'handed_over'] as const satisfies readonly EditLeaseLostReason[]
export type EditLeaseEndReason = (typeof EDIT_LEASE_END_REASONS)[number]

/**
 * 这一代接管了上一代的方式（M3-P5 设计 §3.2，库里的写法）：本人接管（self）、空间管理员强制接管（forced）。旧令牌据此得到失效原因
 * taken_over 与 forced（申请时写的是 contracts 的 EDIT_TAKEOVER_MODES 的 self / force，记下的是结果）。新增取值时同时用迁移更新 CHECK 约束
 */
export const EDIT_LEASE_TAKEOVERS = ['self', 'forced'] as const
export type EditLeaseTakeover = (typeof EDIT_LEASE_TAKEOVERS)[number]

/**
 * 编辑租约（M3-P1 设计 §3.3）：同一时刻只有一个标签页能写一份文档（00 号计划书 §6.2）。每份文档至多一行（主键），
 * 新的申请改写这一行，成为新的一代；租约在数据库里、不在进程内存里，令牌只存摘要，时间一律取数据库的 now()。
 * - document_id 外键级联删除：永久删除文档时随之消失（与内容、修订记录、单独授权一样，ADR-016 的连带）；
 * - holder_id：账户不删除（停用可以撤回），外键 restrict；按它的索引给"按人收回写入权"（停用、移出空间、取消授权）；
 * - session_id 不做外键：会话行过期之后会被清理，绑定的登录还在不在经 auth 判断（SessionService.isActive）；
 * - client_instance_id：编辑器页每次加载生成的标识（保存一直带着它），租约绑定这个标签页；
 * - write_epoch：这一代的代次，申请时文档的写入代次（documents.write_epoch）加一之后的值，所以至少是 1；
 * - 时间：申请时 acquired_at、renewed_at 是 now()，last_active_at 是 now() 减去续上的页面带来的空闲时长（别的申请是 now()，
 *   M3-P5 设计 §3.5），expires_at 是 now() 加有效期；续租时 renewed_at 与 expires_at 一起前进，last_active_at 是 now() 减去页面上报的
 *   空闲时长，只前进不后退（不早于原来的值）、不晚于 now()。
 *   表上兜底同一条语句里写下的两个不等式：到期晚于续租、最后活动不晚于续租。"只前进"比较的是两个事务的 now()，
 *   数据库的时钟往回调时可能不成立，不写成拒绝写入的约束；
 * - 明确结束（释放、收回、交出）记下 ended_at 与 end_reason，两列同时为空或同时有值；到期、空闲、登录失效、代次过时不写，
 *   按有效条件算出来；
 * - 请求编辑（M3-P5 设计 §3.2、§3.6）：单槽，记在租约行上。request_id、requested_by（请求方，外键 restrict）、request_session_id
 *   （请求方的登录，同 session_id 不做外键）、requested_at、request_expires_at（请求方每次续期往后推）五列同时为空或同时有值；
 *   request_declined_at（持有者选了"继续编辑"）只在有请求时有值；到期晚于发出；请求方不是持有者（新的持有者就是请求方时，请求已经实现，清掉）；
 * - 交出之后的保留：reserved_for（外键 restrict）、reserved_until 两列同时为空或同时有值，只在交出（end_reason 是 handed_over）之后有；
 *   交出之后请求方取消时只清保留，handed_over 留着；
 * - 接管标记：这一代接管的那一代的令牌摘要（taken_over_token_digest，32 字节）与方式（takeover：self、forced），两列同时为空或同时有值，
 *   旧令牌据此得到 taken_over。
 *   "同时为空或同时有值"与取值的组合由 CHECK 兜底。"到期晚于发出"在续期时比较的是两个事务的 now()（发出时写下发出的时刻，
 *   续期时把到期推到 now() 加有效期）：中间隔着十分钟的有效期，只有数据库的时钟往回调超过十分钟时才可能不成立，按设计写成约束。
 *   这几组列都按主键找，不另建索引；存量都是空的。
 * 有效条件与它们的顺序在 documents 模块的 edit-lease-rules.ts；锁的顺序是文档行（FOR UPDATE，代次在那里）→ 租约行（ADR-014）
 */
export const documentEditLeases = pgTable('document_edit_leases', {
  documentId: uuid('document_id').primaryKey().references(() => documents.id, { onDelete: 'cascade' }),
  holderId: uuid('holder_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  sessionId: uuid('session_id').notNull(),
  clientInstanceId: uuid('client_instance_id').notNull(),
  tokenDigest: bytea('token_digest').notNull(),
  writeEpoch: integer('write_epoch').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  // enum 只收窄 TypeScript 的类型，数据库里仍是 text 加 CHECK
  endReason: text('end_reason', { enum: EDIT_LEASE_END_REASONS }),
  // 请求编辑（M3-P5）
  requestId: uuid('request_id'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'restrict' }),
  requestSessionId: uuid('request_session_id'),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  requestExpiresAt: timestamp('request_expires_at', { withTimezone: true }),
  requestDeclinedAt: timestamp('request_declined_at', { withTimezone: true }),
  // 交出之后的保留（M3-P5）
  reservedFor: uuid('reserved_for').references(() => users.id, { onDelete: 'restrict' }),
  reservedUntil: timestamp('reserved_until', { withTimezone: true }),
  // 接管标记（M3-P5）
  takenOverTokenDigest: bytea('taken_over_token_digest'),
  takeover: text('takeover', { enum: EDIT_LEASE_TAKEOVERS }),
}, table => [
  check('document_edit_leases_token_digest_check', sql`octet_length(${table.tokenDigest}) = 32`),
  check('document_edit_leases_write_epoch_check', sql`${table.writeEpoch} >= 1`),
  check('document_edit_leases_expiry_check', sql`${table.expiresAt} > ${table.renewedAt}`),
  check('document_edit_leases_last_active_check', sql`${table.lastActiveAt} <= ${table.renewedAt}`),
  check('document_edit_leases_end_reason_check', oneOf(table.endReason, EDIT_LEASE_END_REASONS)),
  check('document_edit_leases_ended_check', sql`(${table.endedAt} IS NULL) = (${table.endReason} IS NULL)`),
  check('document_edit_leases_request_check', allOrNone(table.requestId, table.requestedBy, table.requestSessionId, table.requestedAt, table.requestExpiresAt)),
  check('document_edit_leases_request_declined_check', sql`${table.requestDeclinedAt} IS NULL OR ${table.requestId} IS NOT NULL`),
  check('document_edit_leases_request_expiry_check', sql`${table.requestExpiresAt} > ${table.requestedAt}`),
  check('document_edit_leases_requester_check', sql`${table.requestedBy} <> ${table.holderId}`),
  check('document_edit_leases_reservation_check', allOrNone(table.reservedFor, table.reservedUntil)),
  // 没有明确结束时 end_reason 为空，"= 'handed_over'"的结果是 NULL、CHECK 会放过，所以用 IS NOT DISTINCT FROM（空也算不相等）
  check('document_edit_leases_reservation_end_check', sql`${table.reservedFor} IS NULL OR ${table.endReason} IS NOT DISTINCT FROM 'handed_over'`),
  check('document_edit_leases_taken_over_check', allOrNone(table.takenOverTokenDigest, table.takeover)),
  check('document_edit_leases_taken_over_token_digest_check', sql`octet_length(${table.takenOverTokenDigest}) = ${sql.raw(String(SHA256_BYTES))}`),
  check('document_edit_leases_takeover_check', oneOf(table.takeover, EDIT_LEASE_TAKEOVERS)),
  index('document_edit_leases_holder_idx').on(table.holderId),
])

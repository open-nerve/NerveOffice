// assets 域：字节预留跨文件发布持久存在，转正不增加字节；每份上传单独计记录。
import type { AssetMimeType } from '@nerve-office/contracts'
import { ASSET_MIME_TYPES } from '@nerve-office/contracts'
import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { oneOf } from '../common/index.ts'
import { users } from '../users/index.ts'

/** 首次预留时插入 id=1；所有预留/转正先锁此行，跨实例也不能透支。 */
export const assetQuota = pgTable('asset_quota', {
  id: integer('id').primaryKey(),
  usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
  usedAssets: integer('used_assets').notNull().default(0),
}, table => [
  check('asset_quota_singleton_check', sql`${table.id} = 1`),
  check('asset_quota_bytes_check', sql`${table.usedBytes} BETWEEN 0 AND 1099511627776`),
  check('asset_quota_count_check', sql`${table.usedAssets} BETWEEN 0 AND 1000000`),
])

/** 失败/未知提交时不释放预留；同 hash 重试可以接续，不提供任意清账接口。 */
export const assetObjectClaims = pgTable('asset_object_claims', {
  sha256: text('sha256').primaryKey(),
  generation: uuid('generation'),
  bytes: integer('bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  unreferencedAt: timestamp('unreferenced_at', { withTimezone: true }),
}, table => [
  check('asset_object_claims_candidate_time_check', sql`${table.unreferencedAt} IS NULL OR isfinite(${table.unreferencedAt})`),
  check('asset_object_claims_hash_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check('asset_object_claims_bytes_check', sql`${table.bytes} BETWEEN 1 AND 5242880`),
])

export const assetObjects = pgTable('asset_objects', {
  sha256: text('sha256').primaryKey(),
  generation: uuid('generation'),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').$type<AssetMimeType>().notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  frames: integer('frames').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  unreferencedAt: timestamp('unreferenced_at', { withTimezone: true }),
}, table => [
  check('asset_objects_candidate_time_check', sql`${table.unreferencedAt} IS NULL OR isfinite(${table.unreferencedAt})`),
  check('asset_objects_hash_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check('asset_objects_key_check', sql`${table.storageKey} = 'objects/' || left(${table.sha256}, 2) || '/' || ${table.sha256} || CASE WHEN ${table.generation} IS NULL THEN '' ELSE '.' || ${table.generation}::text END`),
  check('asset_objects_mime_check', oneOf(table.mimeType, ASSET_MIME_TYPES)),
  check('asset_objects_bytes_check', sql`${table.bytes} BETWEEN 1 AND 5242880`),
  check('asset_objects_dimensions_check', sql`${table.width} BETWEEN 1 AND 8192 AND ${table.height} BETWEEN 1 AND 8192`),
  check('asset_objects_frames_check', sql`${table.frames} BETWEEN 1 AND 100 AND (${table.mimeType} IN ('image/gif', 'image/webp') OR ${table.frames} = 1)`),
  check('asset_objects_pixels_check', sql`${table.width}::bigint * ${table.height} <= 16000000 AND ${table.width}::bigint * ${table.height} * ${table.frames} <= 32000000`),
])

/** 退休路径不可复用；完成回执永久保留，只有 pending 的 bytes 仍计入配额。 */
export const assetObjectDeletions = pgTable('asset_object_deletions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  sha256: text('sha256').notNull(),
  generation: uuid('generation'),
  storageKey: text('storage_key').notNull(),
  bytes: integer('bytes').notNull(),
  unreferencedAt: timestamp('unreferenced_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [
  unique('asset_object_deletions_key_key').on(table.storageKey),
  check('asset_object_deletions_hash_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check('asset_object_deletions_key_check', sql`${table.storageKey} = 'objects/' || left(${table.sha256}, 2) || '/' || ${table.sha256} || CASE WHEN ${table.generation} IS NULL THEN '' ELSE '.' || ${table.generation}::text END`),
  check('asset_object_deletions_bytes_check', sql`${table.bytes} BETWEEN 1 AND 5242880`),
  check('asset_object_deletions_time_check', sql`isfinite(${table.unreferencedAt}) AND isfinite(${table.createdAt}) AND ${table.unreferencedAt} <= ${table.createdAt} AND (${table.completedAt} IS NULL OR (isfinite(${table.completedAt}) AND ${table.completedAt} >= ${table.createdAt}))`),
  index('asset_object_deletions_pending_idx').on(table.id).where(sql`${table.completedAt} IS NULL`),
])

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  uploaderId: uuid('uploader_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  objectHash: text('object_hash').notNull().references(() => assetObjects.sha256, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  unreferencedAt: timestamp('unreferenced_at', { withTimezone: true }),
}, table => [
  check('assets_candidate_time_check', sql`${table.unreferencedAt} IS NULL OR isfinite(${table.unreferencedAt})`),
  index('assets_uploader_created_idx').on(table.uploaderId, table.createdAt),
  index('assets_object_idx').on(table.objectHash),
])

/** 插入真实引用时追加，每资源每事务一次；GC 持资源排他锁后消费，不升级引用方的共享锁。 */
export const assetReferenceActivity = pgTable('asset_reference_activity', {
  assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  transactionId: bigint('transaction_id', { mode: 'bigint' }).notNull(),
}, table => [
  primaryKey({ columns: [table.assetId, table.transactionId] }),
  check('asset_reference_activity_transaction_check', sql`${table.transactionId} > 0`),
])

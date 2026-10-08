// local-keys 模块的表（M3-P6 设计 §3.2）：每人的本机密钥，用主密钥包装之后保存。
import { sql } from 'drizzle-orm'
import { check, integer, pgTable, primaryKey, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { allOrNone, bytea } from '../common/index.ts'
import { users } from '../users/index.ts'

/** 主密钥的标识（HKDF 按用途从主密钥派生的 16 字节，不是机密）与包装之后的密钥（IV 12 ‖ 密文 32 ‖ 标签 16）的字节数 */
const MASTER_KEY_ID_BYTES = 16
const WRAPPED_KEY_BYTES = 60

/**
 * 本机密钥（M3-P6 设计 §3.2，M3 总设计 §6.6）：每人任一时刻至多一把当前的（revoked_at 为空），带版本号。
 * - 主键 (user_id, version)：版本按人从 1 起、吊销一次加一，不另设 id。第一次取用时插第 1 版（ON CONFLICT DO NOTHING 接住并发的第一次取用），
 *   之后的各版在吊销的事务里插（账户行的锁把同一个人的吊销串起来）；
 * - user_id：账户只停用不删除，外键 restrict（与 auth_sessions 等一致）；
 * - master_key_id、wrapped_key：包装它的主密钥的标识与包装结果，两列同时为空或同时有值；当前的有密钥材料，吊销的没有——
 *   吊销时把这两列擦成 NULL（crypto-shredding），库里不再留能解开旧草稿的东西，行只剩版本与时刻（M4 按版本区分"已吊销"与"被篡改"）。
 *   残留：MVCC 的旧元组在 VACUUM 之前、WAL 归档与备份的保留期内仍有旧值（部署说明的已知局限）；
 * - 时间一律取数据库的：第 1 版的 created_at 是插入它的事务的 now()（默认值）；revoked_at 是吊销语句执行时的 clock_timestamp()，
 *   不是事务开始的 now()——吊销开了事务、在锁上等着的时候，别的事务可能生成并提交了当前的那一把（本人第一次取用，或者另一个吊销生成的
 *   下一版），它的 created_at 晚于吊销的事务开始的时刻（审查 A1）；之后的各版的 created_at 取上一版被吊销的那一刻（下一版生成于
 *   上一版被吊销的那一刻；插入的语句在 SQL 里取上一版的 revoked_at，时刻不经应用传，复验 C2）。吊销看得到的那一行，插入它的事务已经提交，执行时的时刻必然晚于它的生成，所以 revoked_at 不早于 created_at
 *   写成约束：只有数据库的时钟往回调时它才可能失败；
 * - 部分唯一索引兜住"每人至多一把当前的"：第一次取用的插入撞上它（或主键）时由 ON CONFLICT DO NOTHING 接住，取用改读赢的那一把。
 * 只由 local-keys 的仓储读写；解包、生成与主密钥环都在 local-keys 模块内部（M3-P6 设计 §3.3）。
 * 只由服务保证、库里没有约束的不变量（集成测试删库之前扫一遍）：每个人的版本从 1 起连续（I19）；有过任何一行的人恰好有一把当前的、
 * 而且是版本最大的那一把（I20）；下一版的 created_at 等于上一版的 revoked_at（I21）
 */
export const userLocalKeys = pgTable('user_local_keys', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),
  masterKeyId: bytea('master_key_id'),
  wrappedKey: bytea('wrapped_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [
  primaryKey({ name: 'user_local_keys_pkey', columns: [table.userId, table.version] }),
  // 每人至多一把当前的；取用、心跳的版本与管理界面的摘要都按它找当前的那一把
  uniqueIndex('user_local_keys_current_key').on(table.userId).where(sql`${table.revokedAt} IS NULL`),
  check('user_local_keys_version_check', sql`${table.version} >= 1`),
  check('user_local_keys_master_key_id_check', sql`octet_length(${table.masterKeyId}) = ${sql.raw(String(MASTER_KEY_ID_BYTES))}`),
  check('user_local_keys_wrapped_key_check', sql`octet_length(${table.wrappedKey}) = ${sql.raw(String(WRAPPED_KEY_BYTES))}`),
  check('user_local_keys_material_check', allOrNone(table.wrappedKey, table.masterKeyId)),
  // 当前的有密钥材料，吊销的没有
  check('user_local_keys_current_check', sql`(${table.revokedAt} IS NULL) = (${table.wrappedKey} IS NOT NULL)`),
  check('user_local_keys_revoked_at_check', sql`${table.revokedAt} >= ${table.createdAt}`),
])

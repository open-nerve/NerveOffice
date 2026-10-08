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
 * - 时间一律取数据库的 now()。revoked_at 不早于 created_at：两者是不同事务的 now()，只有数据库的时钟往回调、而且吊销紧跟在生成之后时
 *   才可能不成立（这时吊销失败、可以再试），按设计写成约束；
 * - 部分唯一索引兜住"每人至多一把当前的"：第一次取用的插入撞上它（或主键）时由 ON CONFLICT DO NOTHING 接住，取用改读赢的那一把。
 * 只由 local-keys 的仓储读写；解包、生成与主密钥环都在 local-keys 模块内部（M3-P6 设计 §3.3）。
 * 只由服务保证、库里没有约束的不变量（集成测试删库之前扫一遍）：每个人的版本从 1 起连续（I19）；有过任何一行的人恰好有一把当前的、
 * 而且是版本最大的那一把（I20）
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

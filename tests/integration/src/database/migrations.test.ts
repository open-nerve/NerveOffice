// 迁移（P2 设计 §3.7，ADR-005）：从零执行、重复执行、并发执行、等锁超时、库里不一致时拒绝；个别迁移在旧库上的效果。
// 迁移建出的库与表定义逐项一致见 schema-parity.test.ts，从各阶段有数据的库一路迁移到最新见 migrations-with-data.test.ts
import type { Buffer } from 'node:buffer'
import type { TestDatabase } from '../support/database.ts'
import { MigrationError, readExpectedMigrations, runMigrations } from '@nerve-office/api'
import { afterEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { migrationsUpTo, removeMigrationFolders } from '../support/migration-folders.ts'
import { postLogin } from '../support/session-client.ts'

/** 与迁移命令用的是同一把锁（apps/api/src/modules/database/migrations.ts）。 */
const MIGRATION_LOCK = 'SELECT pg_advisory_lock(hashtextextended(\'nerve-office:migrations\', 0))'
const MIGRATIONS = readExpectedMigrations()

const databases: TestDatabase[] = []

async function emptyDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrated: false })
  databases.push(database)
  return database
}

async function migrateDatabase(database: TestDatabase, lockTimeoutMs = 10_000): ReturnType<typeof runMigrations> {
  return runMigrations({ connectionString: database.url, lockTimeoutMs })
}

async function appliedCount(database: TestDatabase): Promise<number> {
  return database.query(async (client) => {
    const result = await client.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations')
    return Number(result.rows[0]?.count)
  })
}

afterEach(async () => {
  for (const database of databases.splice(0))
    await database.drop()
  removeMigrationFolders()
})

describe('迁移', () => {
  it('从零执行：建出全部的表与触发器；再执行一次什么也不做', async () => {
    const database = await emptyDatabase()
    expect(await migrateDatabase(database)).toEqual({ status: 'applied', applied: MIGRATIONS.length })
    const objects = await database.query(async client => (await client.query<{ tables: string | null, trigger: string | null }>(
      'SELECT to_regclass(\'public.audit_events\')::text AS tables, (SELECT tgname FROM pg_trigger WHERE tgname = \'audit_events_append_only\') AS trigger',
    )).rows[0])
    expect(objects).toEqual({ tables: 'audit_events', trigger: 'audit_events_append_only' })
    expect(await migrateDatabase(database)).toEqual({ status: 'current' })
    expect(await appliedCount(database)).toBe(MIGRATIONS.length)
  })

  it('两个迁移同时执行：只执行一次，另一个等到锁之后发现已是最新', async () => {
    const database = await emptyDatabase()
    const outcomes = await Promise.all([migrateDatabase(database), migrateDatabase(database)])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['applied', 'current'])
    expect(await appliedCount(database)).toBe(MIGRATIONS.length)
  })

  it('等不到 advisory lock 时失败，说明另一个迁移正在执行', async () => {
    const database = await emptyDatabase()
    await database.query(async (client) => {
      await client.query(MIGRATION_LOCK)
      const failure = await migrateDatabase(database, 200).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MigrationError)
      expect(failure).toMatchObject({ reason: 'locked' })
    })
    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
  })

  it('已执行的迁移被改动过（哈希不同）时拒绝执行', async () => {
    const database = await emptyDatabase()
    await migrateDatabase(database)
    await database.query(async client => client.query('UPDATE drizzle.__drizzle_migrations SET hash = \'tampered\' WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)'))
    await expect(migrateDatabase(database)).rejects.toMatchObject({ name: 'MigrationError', reason: 'diverged' })
  })

  it('数据库比应用新（有这个版本不认识的迁移）时拒绝执行', async () => {
    const database = await emptyDatabase()
    await migrateDatabase(database)
    await database.query(async client => client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (\'future\', 9999999999999)'))
    await expect(migrateDatabase(database)).rejects.toMatchObject({ name: 'MigrationError', reason: 'diverged' })
  })
})

describe('0006_document_content', () => {
  it('已有的文档按默认值补齐（修订号 1、档案、格式版本、SDK 版本，unit_id 各不相同）；补齐之后新写入的文档必须写明这些列', async () => {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0005_login_throttle_reservations') })
    const owner = await database.query(async (client) => {
      const user = await client.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'old\', \'old\', \'$argon2id$x\', \'member\') RETURNING id')
      const userId = user.rows[0]?.id ?? ''
      const space = await client.query<{ id: string }>('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', \'old\', $1) RETURNING id', [userId])
      await client.query('INSERT INTO documents (space_id, type, title, created_by) SELECT $1, \'sheet\', \'旧文档 \' || n, $2 FROM generate_series(1, 3) AS n', [space.rows[0]?.id, userId])
      return { userId, spaceId: space.rows[0]?.id ?? '' }
    })

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const rows = await database.query(async client => (await client.query<{ revision: number, unit_id: string, profile: string, format_version: number, sdk_version: string }>(
      'SELECT revision, unit_id, profile, format_version, sdk_version FROM documents',
    )).rows)
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(row => row.unit_id)).size).toBe(3)
    for (const row of rows)
      expect(row).toMatchObject({ revision: 1, profile: 'sheet@1', format_version: 1, sdk_version: '1.0.1' })

    const missingUnitId = await database.query(async client => client.query(
      'INSERT INTO documents (space_id, type, title, created_by, profile, format_version, sdk_version) VALUES ($1, \'sheet\', \'新\', $2, \'sheet@1\', 1, \'1.0.1\')',
      [owner.spaceId, owner.userId],
    ).then(() => undefined, (error: unknown) => error))
    expect(missingUnitId).toMatchObject({ code: '23502' })
  })
})

describe('0008_m2_accounts（M2-P6 复核 G-3）', () => {
  it('M1 的库执行之后：账户、会话、审计原样保留，凭据的版本从 1 开始；M2-P1 的新取值与新表的约束生效', async () => {
    const database = await emptyDatabase()
    // M1 的最后一个迁移（v0.1-m1）
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0007_document_unit_id_not_unique') })
    const owner = await database.query(async (client) => {
      const user = await client.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'old\', \'老账户\', \'$argon2id$x\', \'admin\') RETURNING id')
      const userId = user.rows[0]?.id ?? ''
      await client.query('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', \'老账户\', $1)', [userId])
      // 一条有效的会话、一条退出的会话
      await client.query(
        `INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at, revoked_at, revoked_reason)
         VALUES ($1, sha256('live'), now() + interval '1 hour', now() + interval '1 day', NULL, NULL),
                ($1, sha256('gone'), now(), now() + interval '1 day', now(), 'logout')`,
        [userId],
      )
      await client.query('INSERT INTO audit_events (action, actor_type, actor_id, target_type, target_id, source, request_id) VALUES (\'auth.login_succeeded\', \'user\', $1, \'user\', $1, \'http\', \'m1-request\')', [userId])
      return { userId }
    })

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const state = await database.query(async client => ({
      users: (await client.query('SELECT username, status, password_version FROM users')).rows,
      sessions: (await client.query('SELECT revoked_reason FROM auth_sessions ORDER BY revoked_reason NULLS FIRST')).rows,
      audits: (await client.query('SELECT action, request_id FROM audit_events')).rows,
    }))
    expect(state).toEqual({
      users: [{ username: 'old', status: 'active', password_version: 1 }],
      sessions: [{ revoked_reason: null }, { revoked_reason: 'logout' }],
      audits: [{ action: 'auth.login_succeeded', request_id: 'm1-request' }],
    })

    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    // M2-P1 的新取值：账户停用、会话按人撤销的原因、审计的新动作与对象类型
    expect(await violation('UPDATE users SET status = \'disabled\' WHERE id = $1', [owner.userId])).toBeUndefined()
    expect(await violation('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = \'password_reset\' WHERE revoked_at IS NULL')).toBeUndefined()
    expect(await violation('INSERT INTO audit_events (action, actor_type, source, target_type, target_id) VALUES (\'users.invited\', \'system\', \'cli\', \'invitation\', $1)', [owner.userId])).toBeUndefined()
    expect(await violation('UPDATE users SET status = \'deleted\' WHERE id = $1', [owner.userId])).toMatchObject({ code: '23514', constraint: 'users_status_check' })
    // 邀请：同一个登录名最多一条待接受的；接受与作废最多有一个
    const invite = 'INSERT INTO auth_invitations (username, display_name, token_hash, created_by, expires_at) VALUES ($1, $1, sha256($2::bytea), $3, now() + interval \'7 days\') RETURNING id'
    const pending = await database.query(async client => (await client.query<{ id: string }>(invite, ['newbie', 'first', owner.userId])).rows[0]?.id)
    expect(await violation(invite, ['newbie', 'second', owner.userId])).toMatchObject({ code: '23505', constraint: 'auth_invitations_open_username_key' })
    expect(await violation('UPDATE auth_invitations SET accepted_at = now(), accepted_user_id = $1, revoked_at = now(), revoked_by = $1 WHERE id = $2', [owner.userId, pending])).toMatchObject({ code: '23514', constraint: 'auth_invitations_outcome_check' })
    // 重置：同一个账户最多一条未用的
    const reset = 'INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, sha256($2::bytea), now() + interval \'1 day\')'
    expect(await violation(reset, [owner.userId, 'reset-1'])).toBeUndefined()
    expect(await violation(reset, [owner.userId, 'reset-2'])).toMatchObject({ code: '23505', constraint: 'auth_password_resets_open_user_key' })
  })
})

describe('0014_m2_p6_accounts_hardening（M2-P6 复核 G-4、C3）', () => {
  it('P4 的库执行之后：已有的数据照常；凭据的版本不能小于 1，一个账户至多由一条邀请建成，审计的新动作能写', async () => {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0013_m2_audit_job_source') })
    const ids = await database.query(async (client) => {
      const admin = (await client.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, system_role, password_version) VALUES (\'root\', \'root\', \'$argon2id$x\', \'admin\', 3) RETURNING id')).rows[0]?.id ?? ''
      const member = (await client.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'amy\', \'amy\', \'$argon2id$x\', \'member\') RETURNING id')).rows[0]?.id ?? ''
      // 一条已接受的邀请（建成了 amy）、两条待接受的（accepted_user_id 都是空的）
      await client.query(
        `INSERT INTO auth_invitations (username, display_name, token_hash, created_by, expires_at, accepted_at, accepted_user_id)
         VALUES ('amy', 'amy', sha256('a'), $1, now() + interval '7 days', now(), $2),
                ('bea', 'bea', sha256('b'), $1, now() + interval '7 days', NULL, NULL),
                ('cai', 'cai', sha256('c'), $1, now() + interval '7 days', NULL, NULL)`,
        [admin, member],
      )
      return { admin, member }
    })

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    expect(await database.query(async client => (await client.query<{ username: string, password_version: number }>('SELECT username, password_version FROM users ORDER BY username')).rows)).toEqual([
      { username: 'amy', password_version: 1 },
      { username: 'root', password_version: 3 },
    ])

    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    expect(await violation('UPDATE users SET password_version = 0 WHERE id = $1', [ids.member])).toMatchObject({ code: '23514', constraint: 'users_password_version_check' })
    // 已经建成 amy 的邀请之外，另一条邀请不能也记成建成了 amy
    expect(await violation('UPDATE auth_invitations SET accepted_at = now(), accepted_user_id = $1 WHERE username = \'bea\'', [ids.member])).toMatchObject({ code: '23505', constraint: 'auth_invitations_accepted_user_key' })
    expect(await violation(
      'INSERT INTO audit_events (action, actor_type, actor_id, source, target_type, target_id, details) VALUES (\'users.password_reset_revoked\', \'user\', $1, \'cli\', \'user\', $2, $3)',
      [ids.admin, ids.member, { passwordResetId: ids.member, reason: 'reissued' }],
    )).toBeUndefined()
  })
})

describe('0015_m2_p6_login_throttle_accounts（M2-P6 复核 A1）', () => {
  it('0014 的库上已有旧键的计数行（其中一行正在锁定）与审计：执行之后原样保留、所属账户为空，旧键不再生效；新列的约束、部分索引与新动作生效', async () => {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0014_m2_p6_accounts_hardening') })
    await database.query(async (client) => {
      // M2-P6 之前的键：只按用户名（user:）锁着 amy、按地址、一次性链接按地址
      await client.query(
        `INSERT INTO auth_login_throttles (key_hash, failures, window_started_at, locked_until) VALUES
           (sha256(convert_to('user:amy', 'UTF8')), 5, now(), now() + interval '15 minutes'),
           (sha256(convert_to('ip:203.0.113.9', 'UTF8')), 3, now(), NULL),
           (sha256(convert_to('link:ip:203.0.113.9', 'UTF8')), 1, now() - interval '1 hour', NULL)`,
      )
      await client.query('INSERT INTO audit_events (action, actor_type, source) VALUES (\'auth.login_failed\', \'anonymous\', \'cli\')')
    })

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const state = await database.query(async client => ({
      rows: (await client.query<{ failures: number, locked: boolean, account_hash: Buffer | null }>('SELECT failures, locked_until IS NOT NULL AS locked, account_hash FROM auth_login_throttles ORDER BY failures DESC')).rows,
      index: (await client.query<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE indexname = \'auth_login_throttles_account_hash_idx\'')).rows,
      audits: (await client.query<{ action: string }>('SELECT action FROM audit_events')).rows,
    }))
    expect(state.rows).toEqual([
      { failures: 5, locked: true, account_hash: null },
      { failures: 3, locked: false, account_hash: null },
      { failures: 1, locked: false, account_hash: null },
    ])
    expect(state.index[0]?.indexdef).toContain('WHERE (account_hash IS NOT NULL)')
    expect(state.audits).toEqual([{ action: 'auth.login_failed' }])

    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    expect(await violation('INSERT INTO auth_login_throttles (key_hash, failures, window_started_at, account_hash) VALUES (sha256(\'x\'::bytea), 1, now(), \'\\x00\'::bytea)'))
      .toMatchObject({ code: '23514', constraint: 'auth_login_throttles_account_hash_check' })
    expect(await violation('INSERT INTO audit_events (action, actor_type, source) VALUES (\'users.login_unlocked\', \'system\', \'cli\')')).toBeUndefined()

    // 旧键不再被认作任何维度（ADR-007）：升级之前锁着 amy 的那一行不再挡住她；它原样留着，过期后照常清理
    const amy = await createAccount(database, { username: 'amy' })
    const app = await startTestApp({ databaseUrl: database.url })
    try {
      expect((await postLogin(app.baseUrl, { username: 'amy', password: amy.password })).status).toBe(200)
    }
    finally {
      await app.close()
    }
    expect(await database.query(async client => (await client.query<{ failures: number }>('SELECT failures FROM auth_login_throttles WHERE key_hash = sha256(convert_to(\'user:amy\', \'UTF8\'))')).rows)).toEqual([{ failures: 5 }])
  })
})

describe('0016_m2_p6_space_name_key（M2-P6 复核 B 的 M-1）', () => {
  /** 0015 的库：一个系统管理员，返回他的 id（建团队空间要有创建人） */
  async function databaseAt0015(): Promise<{ database: TestDatabase, adminId: string }> {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0015_m2_p6_login_throttle_accounts') })
    const adminId = await database.query(async client => (await client.query<{ id: string }>(
      'INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'root\', \'root\', \'$argon2id$x\', \'admin\') RETURNING id',
    )).rows[0]?.id ?? '')
    return { database, adminId }
  }

  async function insertTeam(database: TestDatabase, name: string, createdBy: string, status = 'active'): Promise<string> {
    return database.query(async client => (await client.query<{ id: string }>(
      'INSERT INTO spaces (type, name, created_by, status) VALUES (\'team\', $1, $2, $3) RETURNING id',
      [name, createdBy, status],
    )).rows[0]?.id ?? '')
  }

  it('0015 的库上已有的空间：加列时补上判重键；之后看起来一样的团队空间名称撞上唯一索引，个人空间不受约束', async () => {
    const { database, adminId } = await databaseAt0015()
    // 0015 之前允许的写法：中间两个空格、全角空格、希腊字母词尾的 ς、带零宽连接符（都与别的不重名）；一个归档的；个人空间与团队空间同名
    const ids = {
      spaced: await insertTeam(database, 'Finance  Team', adminId),
      wide: await insertTeam(database, '研发\u3000二部', adminId),
      greek: await insertTeam(database, '\u039F\u0394\u039F\u03C2', adminId, 'archived'),
      joined: await insertTeam(database, '财\u200D务部', adminId),
    }
    await database.query(async client => client.query('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', \'Finance Team\', $1)', [adminId]))

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const keys = await database.query(async client => Object.fromEntries((await client.query<{ id: string, name: string, name_key: string }>(
      'SELECT id, name, name_key FROM spaces WHERE type = \'team\'',
    )).rows.map(row => [row.id, { name: row.name, key: row.name_key }])))
    // 名称原样保留，判重键按规则算好
    expect(keys).toEqual({
      [ids.spaced]: { name: 'Finance  Team', key: 'finance team' },
      [ids.wide]: { name: '研发\u3000二部', key: '研发 二部' },
      [ids.greek]: { name: '\u039F\u0394\u039F\u03C2', key: '\u03BF\u03B4\u03BF\u03C3' },
      [ids.joined]: { name: '财\u200D务部', key: '财务部' },
    })
    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    const team = 'INSERT INTO spaces (type, name, created_by) VALUES (\'team\', $1, $2)'
    for (const lookalike of ['FINANCE TEAM', 'Finance\u00A0Team', '财务部', '研发 二部', '\u039F\u0394\u039F\u03A3'])
      expect(await violation(team, [lookalike, adminId]), JSON.stringify(lookalike)).toMatchObject({ code: '23505', constraint: 'spaces_team_name_key' })
    expect(await violation(team, ['Finance Team 2', adminId])).toBeUndefined()
    // 判重键是生成列：写不进去
    expect(await violation('UPDATE spaces SET name_key = \'x\' WHERE id = $1', [ids.spaced])).toMatchObject({ code: '428C9' })
  })

  it('0015 的库上已有看起来一样的团队空间：迁移中止并列出冲突的空间，整个回滚，库还是 0015 的样子', async () => {
    const { database, adminId } = await databaseAt0015()
    const first = await insertTeam(database, '财务部', adminId)
    const second = await insertTeam(database, '财\u200D务部', adminId, 'archived')
    await insertTeam(database, '人事部', adminId)

    const failure: unknown = await migrateDatabase(database).then(() => undefined, (error: unknown) => error)
    // drizzle 的迁移器把数据库的错误包一层（Failed query），RAISE 的说明在 cause 里
    const raised = failure instanceof Error ? failure.cause : undefined
    expect(raised).toMatchObject({ code: 'P0001' })
    const message = (raised as Error).message
    expect(message).toMatch(/^团队空间的名称按新的判重规则有重名（看起来一样的名称算同一个名字），先改名再执行迁移：/)
    // 列出冲突的那一组（id 与名称），不相干的空间不在里面
    expect(message).toContain(first)
    expect(message).toContain(second)
    expect(message).toContain('\'财务部\'')
    expect(message).not.toContain('人事部')
    // 回滚：没有记下 0016，没有新列，原来的唯一索引还在
    expect(await appliedCount(database)).toBe(MIGRATIONS.findIndex(migration => migration.tag === '0016_m2_p6_space_name_key'))
    const state = await database.query(async client => (await client.query<{ column: string | null, index: string | null }>(
      `SELECT (SELECT column_name FROM information_schema.columns WHERE table_name = 'spaces' AND column_name = 'name_key') AS column,
              (SELECT indexdef FROM pg_indexes WHERE indexname = 'spaces_team_name_key') AS index`,
    )).rows[0])
    expect(state?.column).toBeNull()
    expect(state?.index).toContain('lower(name)')
  })
})

describe('0017_m2_p6_space_name_key_blanks（M2-P6 复验 R-M1）', () => {
  /** 0016 的库：一个系统管理员，返回他的 id */
  async function databaseAt0016(): Promise<{ database: TestDatabase, adminId: string }> {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0016_m2_p6_space_name_key') })
    const adminId = await database.query(async client => (await client.query<{ id: string }>(
      'INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'root\', \'root\', \'$argon2id$x\', \'admin\') RETURNING id',
    )).rows[0]?.id ?? '')
    return { database, adminId }
  }

  async function insertTeam(database: TestDatabase, name: string, createdBy: string): Promise<string> {
    return database.query(async client => (await client.query<{ id: string }>(
      'INSERT INTO spaces (type, name, created_by) VALUES (\'team\', $1, $2) RETURNING id',
      [name, createdBy],
    )).rows[0]?.id ?? '')
  }

  async function keysOf(database: TestDatabase, ids: readonly string[]): Promise<string[]> {
    return database.query(async client => (await client.query<{ name_key: string }>(
      'SELECT name_key FROM spaces WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)',
      [ids],
    )).rows.map(row => row.name_key))
  }

  it('0016 的库上已有夹着盲文空白、契丹小字填充符、乐谱的空符头的名称（入口拒绝之前写进去的）：判重键按新的表达式重算，把它们当空白；之后看起来一样的名称撞上唯一索引', async () => {
    const { database, adminId } = await databaseAt0016()
    const ids = [
      await insertTeam(database, '研发\u2800二部', adminId),
      await insertTeam(database, '市场部\u{1D159}', adminId),
      await insertTeam(database, '\u{16FE4}Ops\u2800\u2800 Center', adminId),
    ]
    // 0016 的判重键不认它们：原样留在键里
    expect(await keysOf(database, ids)).toEqual(['研发\u2800二部', '市场部\u{1D159}', '\u{16FE4}ops\u2800\u2800 center'])

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    // 名称原样保留；判重键里它们与空白一起合成一个空格，首尾的去掉
    expect(await keysOf(database, ids)).toEqual(['研发 二部', '市场部', 'ops center'])
    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    const team = 'INSERT INTO spaces (type, name, created_by) VALUES (\'team\', $1, $2)'
    for (const lookalike of ['研发 二部', '市场部', 'Ops Center', '研发\u{16FE4}二部', '市场部\u2800'])
      expect(await violation(team, [lookalike, adminId]), JSON.stringify(lookalike)).toMatchObject({ code: '23505', constraint: 'spaces_team_name_key' })
    expect(await violation(team, ['研发三部', adminId])).toBeUndefined()
    // 仍是生成列，唯一索引照旧只管团队空间
    expect(await violation('UPDATE spaces SET name_key = \'x\' WHERE id = $1', [ids[0]])).toMatchObject({ code: '428C9' })
    const index = await database.query(async client => (await client.query<{ indexdef: string }>(
      'SELECT indexdef FROM pg_indexes WHERE indexname = \'spaces_team_name_key\'',
    )).rows[0]?.indexdef)
    expect(index).toMatch(/UNIQUE INDEX spaces_team_name_key ON public\.spaces USING btree \(name_key\) WHERE \(type = 'team'::text\)/)
  })

  it('0016 的库上已有只差一个盲文空白（或者用它代替空格）的团队空间：迁移中止并列出冲突的空间，整个回滚，库还是 0016 的样子', async () => {
    const { database, adminId } = await databaseAt0016()
    const first = await insertTeam(database, '财务部', adminId)
    const second = await insertTeam(database, '财务部\u2800', adminId)
    const spaced = await insertTeam(database, '财 务', adminId)
    const braille = await insertTeam(database, '财\u2800务', adminId)
    await insertTeam(database, '人事部', adminId)

    const failure: unknown = await migrateDatabase(database).then(() => undefined, (error: unknown) => error)
    // drizzle 的迁移器把数据库的错误包一层（Failed query），RAISE 的说明在 cause 里
    const raised = failure instanceof Error ? failure.cause : undefined
    expect(raised).toMatchObject({ code: 'P0001' })
    const message = (raised as Error).message
    expect(message).toMatch(/^团队空间的名称按新的判重规则有重名（看起来一样的名称算同一个名字），先改名再执行迁移：/)
    // 两组冲突都列出来（id 与名称），不相干的空间不在里面
    for (const id of [first, second, spaced, braille])
      expect(message).toContain(id)
    expect(message).not.toContain('人事部')
    // 回滚：没有记下 0017；判重键还是 0016 的表达式（不认盲文空白），唯一索引还在
    expect(await appliedCount(database)).toBe(MIGRATIONS.findIndex(migration => migration.tag === '0017_m2_p6_space_name_key_blanks'))
    expect(await keysOf(database, [second, braille])).toEqual(['财务部\u2800', '财\u2800务'])
    const index = await database.query(async client => (await client.query<{ indexdef: string }>(
      'SELECT indexdef FROM pg_indexes WHERE indexname = \'spaces_team_name_key\'',
    )).rows[0]?.indexdef)
    expect(index).toContain('(name_key)')
  })
})

describe('0009_m2_team_spaces', () => {
  it('P1 的库执行之后：个人空间照样满足约束、没有创建人，已有文档的写入代次为 0；团队空间与成员的约束生效', async () => {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0008_m2_accounts') })
    const owner = await database.query(async (client) => {
      const user = await client.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'old\', \'old\', \'$argon2id$x\', \'admin\') RETURNING id')
      const userId = user.rows[0]?.id ?? ''
      const space = await client.query<{ id: string }>('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', \'old\', $1) RETURNING id', [userId])
      await client.query(
        'INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version) VALUES ($1, \'sheet\', \'旧文档\', $2, \'unit\', \'sheet@1\', 1, \'1.0.1\')',
        [space.rows[0]?.id, userId],
      )
      return { userId, spaceId: space.rows[0]?.id ?? '' }
    })

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const state = await database.query(async client => ({
      spaces: (await client.query('SELECT type, status, created_by, visible_to_all FROM spaces')).rows,
      epochs: (await client.query('SELECT write_epoch FROM documents')).rows,
    }))
    expect(state).toEqual({ spaces: [{ type: 'personal', status: 'active', created_by: null, visible_to_all: false }], epochs: [{ write_epoch: 0 }] })

    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    // 团队空间要有创建人、不能有所有者
    expect(await violation('INSERT INTO spaces (type, name) VALUES (\'team\', \'市场部\')')).toMatchObject({ code: '23514', constraint: 'spaces_team_check' })
    expect(await violation('INSERT INTO spaces (type, name, created_by, owner_user_id) VALUES (\'team\', \'市场部\', $1, $1)', [owner.userId])).toMatchObject({ code: '23514', constraint: 'spaces_team_check' })
    // 个人空间不能归档，也没有创建人
    expect(await violation('UPDATE spaces SET status = \'archived\' WHERE id = $1', [owner.spaceId])).toMatchObject({ code: '23514', constraint: 'spaces_personal_check' })
    expect(await violation('UPDATE spaces SET created_by = owner_user_id WHERE id = $1', [owner.spaceId])).toMatchObject({ code: '23514', constraint: 'spaces_personal_check' })
    // 团队空间的名称不区分大小写唯一，已归档的也算
    const teamId = await database.query(async client => (await client.query<{ id: string }>(
      'INSERT INTO spaces (type, name, created_by, status) VALUES (\'team\', \'Market\', $1, \'archived\') RETURNING id',
      [owner.userId],
    )).rows[0]?.id)
    expect(await violation('INSERT INTO spaces (type, name, created_by) VALUES (\'team\', \'MARKET\', $1)', [owner.userId])).toMatchObject({ code: '23505', constraint: 'spaces_team_name_key' })
    // 成员：角色只有三种，同一个人在一个空间里只有一行；写入代次不能为负
    expect(await violation('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, \'owner\')', [teamId, owner.userId])).toMatchObject({ code: '23514', constraint: 'space_members_role_check' })
    await database.query(async client => client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, \'admin\')', [teamId, owner.userId]))
    expect(await violation('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, \'viewer\')', [teamId, owner.userId])).toMatchObject({ code: '23505', constraint: 'space_members_pkey' })
    // 写入代次不能为负：新写入一行时由 CHECK 拦下（更新时先被 0019 的"只增不减"触发器拦下，见下面 0019 的用例）
    expect(await violation(
      'INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version, write_epoch) VALUES ($1, \'sheet\', \'负的\', $2, \'unit\', \'sheet@1\', 1, \'1.0.1\', -1)',
      [owner.spaceId, owner.userId],
    )).toMatchObject({ code: '23514', constraint: 'documents_write_epoch_check' })
  })
})

/** 一个系统管理员与他的个人空间（直接写库，按最新的结构） */
async function seedOwner(database: TestDatabase): Promise<{ userId: string, spaceId: string }> {
  return database.query(async (client) => {
    const userId = (await client.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, system_role) VALUES (\'root\', \'root\', \'$argon2id$x\', \'admin\') RETURNING id')).rows[0]?.id ?? ''
    const spaceId = (await client.query<{ id: string }>('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', \'root\', $1) RETURNING id', [userId])).rows[0]?.id ?? ''
    return { userId, spaceId }
  })
}

describe('0018_m2_p6_trash_entries_origin_space（M2-P6 复核 B 的 G4）', () => {
  it('0017 的库上已有删除单元：执行之后多余的原空间一列没了，删除单元的其余各列原样保留', async () => {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0017_m2_p6_space_name_key_blanks') })
    const { userId, spaceId } = await seedOwner(database)
    const entries = 'SELECT id, space_id, kind, deleted_by, deleted_at, expires_at, origin_parent_id, title FROM trash_entries ORDER BY id'
    const before = await database.query(async (client) => {
      await client.query(
        `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_space_id, origin_parent_id, title)
         VALUES ($1, 'document', $2, now() + interval '30 days', $1, NULL, '删掉的文档'),
                ($1, 'folder', $2, now() + interval '3 days', $1, gen_random_uuid(), '删掉的文件夹')`,
        [spaceId, userId],
      )
      return (await client.query<Record<string, unknown>>(entries)).rows
    })
    expect(before).toHaveLength(2)

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const after = await database.query(async client => ({
      rows: (await client.query<Record<string, unknown>>(entries)).rows,
      columns: (await client.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = \'trash_entries\' ORDER BY column_name')).rows.map(row => row.column_name),
    }))
    expect(after.rows).toEqual(before)
    expect(after.columns).toEqual(['deleted_at', 'deleted_by', 'expires_at', 'id', 'kind', 'origin_parent_id', 'space_id', 'title'])
  })
})

describe('0019_m2_p6_write_epoch_monotonic（M2-P6 复核 B 的 G5）', () => {
  it('0018 的库上已有代次不为 0 的文档：执行之后原样；之后直接写库减小代次被拒、整条语句回滚，不变、加一与只改别的列照常', async () => {
    const database = await emptyDatabase()
    await runMigrations({ connectionString: database.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo('0018_m2_p6_trash_entries_origin_space') })
    const { userId, spaceId } = await seedOwner(database)
    const insertDocument = 'INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version, write_epoch) VALUES ($1, \'sheet\', $3, $2, \'unit\', \'sheet@1\', 1, \'1.0.1\', $4) RETURNING id'
    const [moved, fresh] = await database.query(async client => [
      (await client.query<{ id: string }>(insertDocument, [spaceId, userId, '搬过三次的', 3])).rows[0]?.id ?? '',
      (await client.query<{ id: string }>(insertDocument, [spaceId, userId, '新的', 0])).rows[0]?.id ?? '',
    ])

    expect(await migrateDatabase(database)).toMatchObject({ status: 'applied' })
    const epochs = async (): Promise<Record<string, number>> => database.query(async client => Object.fromEntries(
      (await client.query<{ id: string, write_epoch: number }>('SELECT id, write_epoch FROM documents')).rows.map(row => [row.id, row.write_epoch]),
    ))
    expect(await epochs()).toEqual({ [moved]: 3, [fresh]: 0 })

    const violation = async (text: string, values: unknown[] = []): Promise<unknown> => database.query(async client => client.query(text, values).then(() => undefined, (error: unknown) => error))
    const rejected = { code: '23514', constraint: 'documents_write_epoch_monotonic', table: 'documents', column: 'write_epoch' }
    expect(await violation('UPDATE documents SET write_epoch = write_epoch - 1 WHERE id = $1', [moved])).toMatchObject(rejected)
    // 一条语句里只要有一行变小，整条语句回滚：另一行不变（0 → 0）也没有写进去
    expect(await violation('UPDATE documents SET write_epoch = 0, title = \'改过\'')).toMatchObject(rejected)
    expect(await database.query(async client => (await client.query<{ title: string }>('SELECT title FROM documents ORDER BY title')).rows)).toEqual([{ title: '搬过三次的' }, { title: '新的' }])
    // 不变（只改别的列、写回原值）与变大照常
    expect(await violation('UPDATE documents SET title = \'改名\' WHERE id = $1', [moved])).toBeUndefined()
    expect(await violation('UPDATE documents SET write_epoch = write_epoch WHERE id = $1', [moved])).toBeUndefined()
    expect(await violation('UPDATE documents SET write_epoch = write_epoch + 1')).toBeUndefined()
    expect(await epochs()).toEqual({ [moved]: 4, [fresh]: 1 })
  })
})

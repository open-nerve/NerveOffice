// 迁移（P2 设计 §3.7，ADR-005）：从零执行、重复执行、并发执行、等锁超时、库里不一致时拒绝。
import type { TestDatabase } from '../support/database.ts'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MigrationError, MIGRATIONS_FOLDER, readExpectedMigrations, runMigrations } from '@nerve-office/api'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../support/database.ts'

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

const folders: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    await database.drop()
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true })
})

/** 只含到 lastTag 为止的迁移的目录：先把库迁移到那个版本，写入旧结构的数据，再执行之后的迁移。 */
function migrationsUpTo(lastTag: string): string {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }
  const end = journal.entries.findIndex(entry => entry.tag === lastTag)
  if (end < 0)
    throw new Error(`没有迁移 ${lastTag}`)
  const folder = mkdtempSync(path.join(tmpdir(), 'nerve-migrations-'))
  folders.push(folder)
  mkdirSync(path.join(folder, 'meta'))
  const entries = journal.entries.slice(0, end + 1)
  for (const entry of entries)
    copyFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`))
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return folder
}

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

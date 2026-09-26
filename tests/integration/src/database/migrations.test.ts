// 迁移（P2 设计 §3.7，ADR-005）：从零执行、重复执行、并发执行、等锁超时、库里不一致时拒绝。
import type { TestDatabase } from '../support/database.ts'
import { MigrationError, readExpectedMigrations, runMigrations } from '@nerve-office/api'
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

afterEach(async () => {
  for (const database of databases.splice(0))
    await database.drop()
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

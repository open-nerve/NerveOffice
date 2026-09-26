import type { ExpectedMigration } from './migrations.ts'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { describe, expect, it } from 'vitest'
import { compareMigrations, MIGRATIONS_FOLDER, readExpectedMigrations } from './migrations.ts'

const expected: ExpectedMigration[] = [
  { tag: '0000_a', when: 100, hash: 'h0' },
  { tag: '0001_b', when: 200, hash: 'h1' },
]

describe('compareMigrations', () => {
  it('已执行的与带来的一致', () => {
    expect(compareMigrations(expected, [{ hash: 'h0', createdAt: 100 }, { hash: 'h1', createdAt: 200 }])).toEqual({ status: 'current' })
  })

  it('已执行的是前缀：还有待执行的迁移', () => {
    expect(compareMigrations(expected, [])).toEqual({ status: 'pending', pending: 2 })
    expect(compareMigrations(expected, [{ hash: 'h0', createdAt: 100 }])).toEqual({ status: 'pending', pending: 1 })
  })

  it('数据库比应用新：不一致', () => {
    const result = compareMigrations(expected.slice(0, 1), [{ hash: 'h0', createdAt: 100 }, { hash: 'h1', createdAt: 200 }])
    expect(result).toMatchObject({ status: 'diverged', reason: expect.any(String) as unknown })
  })

  it('已执行的迁移被改动过（哈希不同）：不一致', () => {
    expect(compareMigrations(expected, [{ hash: 'changed', createdAt: 100 }])).toEqual({ status: 'diverged', reason: '迁移 0000_a 的内容与数据库里的记录不同（已执行的迁移被改动过）' })
  })

  it('时间戳不同（例如乱序合并）：不一致', () => {
    expect(compareMigrations(expected, [{ hash: 'h0', createdAt: 150 }])).toEqual({ status: 'diverged', reason: '迁移 0000_a 的时间戳与数据库里的记录不同' })
  })
})

describe('readExpectedMigrations', () => {
  it('按 journal 的顺序读出仓库里的迁移，哈希与 drizzle 的迁移器记录的相同', () => {
    const migrations = readExpectedMigrations()
    expect(migrations.map(migration => migration.tag)).toEqual(['0000_audit_events', '0001_audit_events_append_only'])
    const drizzle = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
    expect(migrations.map(migration => [migration.hash, migration.when])).toEqual(drizzle.map(migration => [migration.hash, migration.folderMillis]))
  })
})

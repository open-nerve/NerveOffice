import type { ExpectedMigration } from './migrations.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { describe, expect, it } from 'vitest'
import { compareMigrations, migrationClientConfig, MigrationError, MIGRATIONS_FOLDER, readExpectedMigrations } from './migrations.ts'

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

describe('migrationClientConfig', () => {
  it('迁移连接：10 秒的连接时限；TCP keepalive 从空闲 10 秒开始探测（审查 A8、复验 N2）', () => {
    expect(migrationClientConfig('postgres://nerve@127.0.0.1:1/nerve')).toEqual({
      connectionString: 'postgres://nerve@127.0.0.1:1/nerve',
      application_name: 'nerve-office-migrate',
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
  })
})

describe('readExpectedMigrations', () => {
  it('按 journal 的顺序读出仓库里的迁移，哈希与 drizzle 的迁移器记录的相同', () => {
    const migrations = readExpectedMigrations()
    // 不列出全部迁移：每加一个迁移都要改这里。序号从 0000 起连续，最早的两个是审计表
    expect(migrations.slice(0, 2).map(migration => migration.tag)).toEqual(['0000_audit_events', '0001_audit_events_append_only'])
    expect(migrations.map(migration => migration.tag.slice(0, 4))).toEqual(migrations.map((_, index) => String(index).padStart(4, '0')))
    const drizzle = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
    expect(migrations.map(migration => [migration.hash, migration.when])).toEqual(drizzle.map(migration => [migration.hash, migration.folderMillis]))
  })
})

describe('readExpectedMigrations：迁移文件本身不合法时拒绝', () => {
  function folderWith(entries: { idx: number, when: number, tag: string }[]): string {
    const folder = mkdtempSync(join(tmpdir(), 'nerve-migrations-'))
    mkdirSync(join(folder, 'meta'))
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries }))
    for (const entry of entries)
      writeFileSync(join(folder, `${entry.tag}.sql`), 'SELECT 1')
    return folder
  }

  it.each([
    ['时间戳没有递增', [{ idx: 0, when: 200, tag: '0000_a' }, { idx: 1, when: 100, tag: '0001_b' }]],
    ['序号不连续', [{ idx: 0, when: 100, tag: '0000_a' }, { idx: 2, when: 200, tag: '0002_b' }]],
  ])('%s', (_case, entries) => {
    const folder = folderWith(entries)
    try {
      expect(() => readExpectedMigrations(folder)).toThrow(MigrationError)
    }
    finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

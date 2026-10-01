// 只含前面一部分迁移的目录（迁移的集成测试用）：先把库迁移到某个历史版本，按当时的结构写入数据，再执行之后的迁移，
// 核对迁移在有数据的库上能执行、数据原样保留。目录建在系统的临时目录里，用例结束后由 removeMigrationFolders 删掉。
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MIGRATIONS_FOLDER } from '@nerve-office/api'

interface Journal {
  readonly entries: readonly { readonly tag: string }[]
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as Journal
}

/** 全部迁移的名字（journal 的顺序） */
export const MIGRATION_TAGS: readonly string[] = readJournal().entries.map(entry => entry.tag)

/** 某个迁移在 journal 里的位置；没有这个迁移时报错（迁移改名之后用例要跟着改） */
export function migrationIndexOf(tag: string): number {
  const index = MIGRATION_TAGS.indexOf(tag)
  if (index < 0)
    throw new Error(`没有迁移 ${tag}`)
  return index
}

const created: string[] = []

/** 只含到 lastTag 为止（含它）的迁移的目录：交给 runMigrations 的 migrationsFolder */
export function migrationsUpTo(lastTag: string): string {
  const journal = readJournal()
  const entries = journal.entries.slice(0, migrationIndexOf(lastTag) + 1)
  const folder = mkdtempSync(path.join(tmpdir(), 'nerve-migrations-'))
  created.push(folder)
  mkdirSync(path.join(folder, 'meta'))
  for (const entry of entries)
    copyFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`))
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return folder
}

/** 删掉 migrationsUpTo 建的目录（afterEach 里调用） */
export function removeMigrationFolders(): void {
  for (const folder of created.splice(0))
    rmSync(folder, { recursive: true, force: true })
}

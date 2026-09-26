// 迁移只向前（规范 §5，ADR-005）：合并到 main 的迁移不再修改，新迁移只追加在末尾、时间戳递增。
// drizzle 的迁移器只按时间戳判断是否执行，乱序的迁移会被静默跳过，所以顺序也要检查。
// 这里只做判断；读取当前与基准版本的文件由调用方完成（本机的基准是与 main 的分叉点，CI 是合并前的 main）。
import type { Violation } from './types.ts'
import { z } from 'zod'

export const MIGRATIONS_DIR = 'apps/api/src/db/migrations'
const JOURNAL = 'meta/_journal.json'

/** 迁移目录的一个版本：相对迁移目录的路径 → 文件内容。 */
export type MigrationFiles = ReadonlyMap<string, string>

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), when: z.number().int(), tag: z.string().min(1) })),
})

/** drizzle-kit 为每个迁移保存的表结构快照，按 journal 的序号命名。 */
function snapshotOf(entry: JournalEntry): string {
  return `meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`
}

/** 读出 journal；目录里还没有任何迁移时为空。 */
function readJournal(files: MigrationFiles): JournalEntry[] | string {
  const text = files.get(JOURNAL)
  if (text === undefined)
    return [...files.keys()].some(path => path.endsWith('.sql')) ? `缺少 ${JOURNAL}` : []
  try {
    return journalSchema.parse(JSON.parse(text)).entries
  }
  catch {
    return `${JOURNAL} 不是合法的 drizzle-kit journal`
  }
}

function checkSequence(entries: readonly JournalEntry[]): Violation[] {
  const violations: Violation[] = []
  const tags = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    if (entry.idx !== index)
      violations.push({ rule: 'migrations/sequence', subject: entry.tag, detail: `序号是 ${entry.idx}，应为 ${index}：序号必须从 0 起连续` })
    const previous = entries[index - 1]
    if (previous !== undefined && entry.when <= previous.when)
      violations.push({ rule: 'migrations/sequence', subject: entry.tag, detail: `时间戳没有大于上一个迁移 ${previous.tag}：drizzle 的迁移器会静默跳过它` })
    if (tags.has(entry.tag))
      violations.push({ rule: 'migrations/sequence', subject: entry.tag, detail: '名称重复' })
    tags.add(entry.tag)
  }
  return violations
}

function checkFiles(files: MigrationFiles, entries: readonly JournalEntry[]): Violation[] {
  const violations: Violation[] = []
  for (const entry of entries) {
    for (const path of [`${entry.tag}.sql`, snapshotOf(entry)]) {
      if (!files.has(path))
        violations.push({ rule: 'migrations/files', subject: entry.tag, detail: `缺少 ${path}` })
    }
  }
  const listed = new Set(entries.map(entry => `${entry.tag}.sql`))
  for (const path of files.keys()) {
    if (path.endsWith('.sql') && !listed.has(path))
      violations.push({ rule: 'migrations/files', subject: path, detail: '不在 journal 里：drizzle 的迁移器不会执行它' })
  }
  return violations
}

function checkAppendOnly(current: MigrationFiles, entries: readonly JournalEntry[], base: MigrationFiles): Violation[] {
  const baseEntries = readJournal(base)
  if (typeof baseEntries === 'string')
    return [{ rule: 'migrations/base', subject: JOURNAL, detail: `基准版本的 ${baseEntries}` }]
  const violations: Violation[] = []
  for (const [index, baseEntry] of baseEntries.entries()) {
    const entry = entries[index]
    if (entry?.tag !== baseEntry.tag || entry.when !== baseEntry.when)
      violations.push({ rule: 'migrations/immutable', subject: baseEntry.tag, detail: '已合并的迁移被删除、改名、调整了顺序或时间戳；新迁移只能追加在末尾' })
  }
  for (const [path, content] of base) {
    if (path !== JOURNAL && current.get(path) !== content)
      violations.push({ rule: 'migrations/immutable', subject: path, detail: '已合并的文件被修改或删除；需要改动时，新增一个迁移' })
  }
  return violations
}

/** 检查当前的迁移目录；给出基准版本时，再检查已合并的部分没有变化。 */
export function checkMigrations(current: MigrationFiles, base: MigrationFiles | undefined): Violation[] {
  const entries = readJournal(current)
  if (typeof entries === 'string')
    return [{ rule: 'migrations/journal', subject: JOURNAL, detail: entries }]
  return [
    ...checkSequence(entries),
    ...checkFiles(current, entries),
    ...(base === undefined ? [] : checkAppendOnly(current, entries, base)),
  ]
}

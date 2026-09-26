// 迁移（P2 设计 §3.7，ADR-005）：由单独的命令执行，advisory lock 防止并发执行；
// 执行前比较数据库里已执行的迁移与这次带来的迁移，不一致就拒绝，不交给 drizzle 的迁移器去猜。
import type { ClientBase, Pool } from 'pg'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { z } from 'zod'

/** 迁移文件：源码在 src/db/migrations，构建时由 Nest CLI 复制到 dist/db/migrations，与本文件的相对位置相同。 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../db/migrations', import.meta.url))

/** drizzle 迁移器的记录表，沿用默认名，与 drizzle-kit 一致。 */
const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations'
/** 迁移的 advisory lock：键由固定的名字算出。 */
const LOCK = 'SELECT pg_advisory_lock(hashtextextended(\'nerve-office:migrations\', 0))'
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended(\'nerve-office:migrations\', 0))'
/** PostgreSQL 的 lock_not_available：等锁超过 lock_timeout。 */
const LOCK_NOT_AVAILABLE = '55P03'
/** 迁移命令建立连接的时限。 */
const CONNECT_TIMEOUT_MS = 10_000

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), when: z.number().int(), tag: z.string().min(1) })),
})

export interface ExpectedMigration {
  readonly tag: string
  readonly when: number
  /** 整个 SQL 文件的 SHA-256，与 drizzle 的迁移器记录的哈希算法相同 */
  readonly hash: string
}

export interface AppliedMigration {
  readonly hash: string
  readonly createdAt: number
}

export type SchemaStatus
  = | { readonly status: 'current' }
    | { readonly status: 'pending', readonly pending: number }
    | { readonly status: 'diverged', readonly reason: string }

/**
 * 这次带来的迁移，按 journal 的顺序。序号必须从 0 起连续、时间戳必须严格递增：
 * drizzle 的迁移器只执行时间戳大于最后一条记录的迁移，乱序的会被静默跳过（审查 A7；门禁 migrations 也检查）。
 */
export function readExpectedMigrations(folder: string = MIGRATIONS_FOLDER): ExpectedMigration[] {
  const journal = journalSchema.parse(JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')))
  for (const [index, entry] of journal.entries.entries()) {
    const previous = journal.entries[index - 1]
    if (entry.idx !== index || (previous !== undefined && entry.when <= previous.when))
      throw new MigrationError('invalid', `迁移 ${entry.tag} 的序号或时间戳不对：序号必须从 0 起连续，时间戳必须严格递增`)
  }
  return journal.entries.map(entry => ({
    tag: entry.tag,
    when: entry.when,
    hash: createHash('sha256').update(readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')).digest('hex'),
  }))
}

/**
 * 比较数据库里已执行的迁移与这次带来的迁移：已执行的必须是它的前缀，哈希与时间戳逐个一致。
 * drizzle 的迁移器只按时间戳判断是否执行：时间戳乱序的迁移会被静默跳过，已执行的迁移被改动也发现不了。
 */
export function compareMigrations(expected: readonly ExpectedMigration[], applied: readonly AppliedMigration[]): SchemaStatus {
  if (applied.length > expected.length)
    return { status: 'diverged', reason: `数据库里有 ${applied.length - expected.length} 个这个版本不认识的迁移（数据库比应用新）` }
  for (const [index, record] of applied.entries()) {
    const migration = expected[index]
    if (migration === undefined)
      break
    if (record.hash !== migration.hash)
      return { status: 'diverged', reason: `迁移 ${migration.tag} 的内容与数据库里的记录不同（已执行的迁移被改动过）` }
    if (record.createdAt !== migration.when)
      return { status: 'diverged', reason: `迁移 ${migration.tag} 的时间戳与数据库里的记录不同` }
  }
  const pending = expected.length - applied.length
  return pending === 0 ? { status: 'current' } : { status: 'pending', pending }
}

/** 数据库里已执行的迁移，按执行顺序；还没有记录表时为空。 */
export async function readAppliedMigrations(queryable: ClientBase | Pool): Promise<AppliedMigration[]> {
  const table = await queryable.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [MIGRATIONS_TABLE])
  if (table.rows[0]?.exists !== true)
    return []
  const records = await queryable.query<{ hash: string, created_at: string }>('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id')
  // created_at 是 bigint，pg 按文本返回
  return records.rows.map(row => ({ hash: row.hash, createdAt: Number(row.created_at) }))
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError'

  /** locked：另一个迁移正在执行；diverged：数据库与这次带来的迁移不一致；invalid：迁移文件本身不合法 */
  constructor(readonly reason: 'locked' | 'diverged' | 'invalid', message: string) {
    super(message)
  }
}

export interface RunMigrationsOptions {
  connectionString: string
  /** 等待 advisory lock 的上限；迁移语句等锁也受它限制 */
  lockTimeoutMs: number
  migrationsFolder?: string
}

export type MigrationOutcome
  = | { readonly status: 'current' }
    | { readonly status: 'applied', readonly applied: number }

async function acquireLock(client: pg.Client): Promise<void> {
  try {
    await client.query(LOCK)
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === LOCK_NOT_AVAILABLE)
      throw new MigrationError('locked', '另一个迁移正在执行：等待 advisory lock 超时')
    throw error
  }
}

/**
 * 执行迁移：独立的连接 → 等锁 → 比较 → 在一个事务里执行剩下的迁移 → 释放锁。
 * 数据库里的迁移与这次带来的不一致时拒绝执行（MigrationError）。
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationOutcome> {
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER
  const expected = readExpectedMigrations(folder)
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'nerve-office-migrate',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    keepAlive: true,
  })
  // 连接在两条语句之间被断开时，pg 在客户端上触发 error；没有监听者会让进程直接退出。
  // 错误会从下一条语句上抛出，这里只防止它成为未监听的事件（审查 A1）
  client.on('error', () => {})
  await client.connect()
  try {
    await client.query('SELECT set_config(\'lock_timeout\', $1, false)', [`${options.lockTimeoutMs}ms`])
    await acquireLock(client)
    try {
      const status = compareMigrations(expected, await readAppliedMigrations(client))
      if (status.status === 'current')
        return { status: 'current' }
      if (status.status === 'diverged')
        throw new MigrationError('diverged', `拒绝执行迁移：${status.reason}`)
      await migrate(drizzle({ client }), { migrationsFolder: folder })
      // 复核：drizzle 的迁移器按时间戳决定执行哪些，执行之后库里必须与这次带来的完全一致（审查 A7）
      const after = compareMigrations(expected, await readAppliedMigrations(client))
      if (after.status !== 'current')
        throw new MigrationError('diverged', `执行迁移之后库结构仍不一致：${after.status === 'pending' ? `还有 ${after.pending} 个迁移没有执行` : after.reason}`)
      return { status: 'applied', applied: status.pending }
    }
    finally {
      // 解锁失败不能掩盖原来的错误；会话结束时锁会自动释放（审查 A14）
      await client.query(UNLOCK).catch(() => {})
    }
  }
  finally {
    await client.end()
  }
}

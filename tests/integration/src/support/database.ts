// 集成测试的数据库（规范 §8.1）：每个测试文件使用独立的数据库，不 mock 数据库。
// 已迁移的库从模板库复制：模板按迁移的哈希命名，迁移不变时跨运行复用，第一次需要时在 advisory lock 下创建。
// 删库之前扫一遍只由服务保证的数据不变量（invariants.ts，M2-P6 复核 B 的 B5）：违反了就让这个测试文件失败。
import { createHash, randomBytes } from 'node:crypto'
import process from 'node:process'
import { readExpectedMigrations, runMigrations } from '@nerve-office/api'
import pg from 'pg'
import { describeViolations, invariantViolations } from './invariants.ts'

/** 本机开发数据库（deploy/dev/compose.yaml）；CI 用环境变量指向服务容器。建库、删库都经它（维护库）执行。 */
const LOCAL_DEVELOPMENT_URL = 'postgres://nerve:nerve_dev_only@127.0.0.1:54318/nerve_office'

/** 模板库与测试库的名字前缀，便于识别与清理。 */
const TEMPLATE_PREFIX = 'nerve_it_tpl_'
const DATABASE_PREFIX = 'nerve_it_'
/** 创建模板与复制都在这把锁下进行：并行的测试文件不会同时建模板，复制时模板上也没有别的连接。 */
const TEMPLATE_LOCK = 'SELECT pg_advisory_lock(hashtextextended(\'nerve-office:integration-template\', 0))'
const TEMPLATE_UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended(\'nerve-office:integration-template\', 0))'

export function testDatabaseUrl(): string {
  return process.env.NERVE_TEST_DATABASE_URL ?? LOCAL_DEVELOPMENT_URL
}

/** 同一台数据库服务器上另一个库的连接串。 */
export function databaseUrl(name: string): string {
  const url = new URL(testDatabaseUrl())
  url.pathname = `/${name}`
  return url.toString()
}

/** 用一个独立的连接执行 fn，结束后关闭连接；默认连维护库。 */
export async function withClient<T>(fn: (client: pg.Client) => Promise<T>, connectionString: string = testDatabaseUrl()): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    return await fn(client)
  }
  finally {
    await client.end()
  }
}

export interface TestDatabase {
  readonly name: string
  readonly url: string
  /** 在这个库上执行 fn（独立的连接） */
  query: <T>(fn: (client: pg.Client) => Promise<T>) => Promise<T>
  /**
   * 删掉这个库。迁移好的库删之前先扫一遍数据不变量：有违反时库照样删掉，再抛出错误列出违反的行，
   * 让这个测试文件失败（afterAll 里调用）。用例自己造出的违反（例如核对永久删除拒绝删除不一致的数据）要在用例结束前收拾好
   */
  drop: () => Promise<void>
}

function templateName(): string {
  const digest = createHash('sha256')
  // 名称、内容与时间戳都算进去：迁移器与就绪检查按这三项比较，任何一项变了都要重建模板
  for (const migration of readExpectedMigrations())
    digest.update(`${migration.tag}\n${migration.hash}\n${migration.when}\n`)
  return `${TEMPLATE_PREFIX}${digest.digest('hex').slice(0, 12)}`
}

/** 进程还在的测试库属于正在运行的测试文件（可能在别的 worktree 里）；进程已经不在的，是中断的测试运行留下的。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 测试库的名字：带着进程号，中断的测试运行留下的库可以识别出来。 */
export function testDatabaseName(): string {
  return `${DATABASE_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`
}

/**
 * 删除中断的测试运行留下的库（名字里带着创建它的进程号，审查 A15），
 * 以及角色（bootstrap 脚本的测试建的，名字是库名加 _owner、_app）：角色拥有的库先删掉，角色才能删。
 */
async function dropAbandoned(client: pg.Client): Promise<void> {
  const databases = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [DATABASE_PREFIX])
  for (const { datname } of databases.rows) {
    const pid = /^nerve_it_(\d+)_[\da-f]+$/.exec(datname)?.[1]
    if (pid !== undefined && !isAlive(Number(pid)))
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`)
  }
  const roles = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE starts_with(rolname, $1)', [DATABASE_PREFIX])
  for (const { rolname } of roles.rows) {
    const pid = /^nerve_it_(\d+)_[\da-f]+_(?:owner|app)$/.exec(rolname)?.[1]
    if (pid !== undefined && !isAlive(Number(pid)))
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(rolname)}`)
  }
}

/** 确保当前迁移的模板存在：先用临时名创建并迁移，完成后再改名，半成品永远不会被复用；顺带删除旧模板。 */
async function ensureTemplate(client: pg.Client): Promise<string> {
  const template = templateName()
  const existing = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [TEMPLATE_PREFIX])
  if (!existing.rows.some(row => row.datname === template)) {
    const building = `${template}_building`
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(building)} WITH (FORCE)`)
    await client.query(`CREATE DATABASE ${pg.escapeIdentifier(building)}`)
    await runMigrations({ connectionString: databaseUrl(building), lockTimeoutMs: 30_000 })
    await client.query(`ALTER DATABASE ${pg.escapeIdentifier(building)} RENAME TO ${pg.escapeIdentifier(template)}`)
  }
  for (const { datname } of existing.rows) {
    if (datname !== template)
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`)
  }
  return template
}

/** PostgreSQL 的 SQLSTATE 3D000：库不存在（已经删过了） */
const INVALID_CATALOG_NAME = '3D000'

/**
 * 删库之前扫一遍数据不变量（M2-P6 复核 B 的 B5）。库已经不在（删过一次）时没有可扫的。
 * 成本：每个测试文件一个连接、十几条查询（测试库里的行很少）
 */
async function sweepInvariants(url: string): Promise<string | undefined> {
  try {
    const violations = await withClient(invariantViolations, url)
    return violations.length === 0 ? undefined : describeViolations(violations)
  }
  catch (error) {
    if ((error as { code?: unknown }).code === INVALID_CATALOG_NAME)
      return undefined
    throw error
  }
}

/**
 * 为当前测试文件创建一个独立的数据库。
 * - migrated（默认）：从模板复制，已执行全部迁移；删之前扫一遍数据不变量；
 * - 否则是空库，用于"迁移从零执行"一类的测试：没有那些表，或者只迁移到某一步，不扫。
 */
export async function createTestDatabase(options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const name = testDatabaseName()
  await withClient(async (client) => {
    await client.query(TEMPLATE_LOCK)
    try {
      await dropAbandoned(client)
      const template = options.migrated === false ? undefined : await ensureTemplate(client)
      await client.query(template === undefined
        ? `CREATE DATABASE ${pg.escapeIdentifier(name)}`
        : `CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE ${pg.escapeIdentifier(template)}`)
    }
    finally {
      await client.query(TEMPLATE_UNLOCK)
    }
  })
  const url = databaseUrl(name)
  return {
    name,
    url,
    query: async fn => withClient(fn, url),
    drop: async () => {
      const violations = options.migrated === false ? undefined : await sweepInvariants(url)
      await withClient(async client => client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`))
      if (violations !== undefined)
        throw new Error(`测试留下的数据违反了只由服务保证的不变量（${name}，库已删掉）：\n${violations}`)
    },
  }
}

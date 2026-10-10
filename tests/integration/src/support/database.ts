// 集成测试的数据库（规范 §8.1）：每个测试文件使用独立的数据库，不 mock 数据库。
// 已迁移的库从模板库复制：模板按迁移的哈希命名，迁移不变时跨运行复用，第一次需要时在 advisory lock 下创建。
// 别的迁移（别的检出、别的分支）的模板只删没人在用的，不用 FORCE：两个迁移不同的检出同时跑集成测试时各用各的模板（M4-P1 S7）。
// 删库之前扫一遍只由服务保证的数据不变量（invariants.ts，M2-P6 复核 B 的 B5）：违反了就让这个测试文件失败。
import { createHash, randomBytes } from 'node:crypto'
import process from 'node:process'
import { readExpectedMigrations, runMigrations } from '@nerve-office/api'
import pg from 'pg'
import { abandonedNames, hostScopedName } from '../../../shared/test-databases.ts'
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

/** 准备模板、清理和复制共用这把锁；造模板的夹具也要等持有连接建立后再放锁，避免准备到一半被清理。 */
export async function withTemplateLock<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query(TEMPLATE_LOCK)
    try {
      return await fn(client)
    }
    finally {
      await client.query(TEMPLATE_UNLOCK)
    }
  })
}

export interface TestDatabase {
  readonly name: string
  readonly url: string
  /** 在这个库上执行 fn（独立的连接） */
  query: <T>(fn: (client: pg.Client) => Promise<T>) => Promise<T>
  /**
   * 删掉这个库。迁移好的库删之前先扫一遍数据不变量：有违反时库照样删掉，再抛出错误列出违反的行，
   * 让这个测试文件失败（afterAll 里调用）。扫描本身出错时同样先删库，再把扫描的错误抛出来（M2-P6 第 3 片复验）。
   * 用例自己造出的违反（例如核对永久删除拒绝删除不一致的数据）要在用例结束前收拾好
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

/**
 * 测试库的名字：nerve_it_<主机标识>_<进程号>_<随机>。主机标识与进程号让中断的测试运行留下的库认得出来、只由本主机清理
 * （tests/shared/test-databases.ts，M4-P1 S7 的事故之后）；随机的部分区分同一个进程里的多个库
 */
export function testDatabaseName(): string {
  return `${hostScopedName(DATABASE_PREFIX)}_${randomBytes(4).toString('hex')}`
}

/**
 * 删除中断的测试运行留下的库（审查 A15），以及角色（bootstrap 脚本的测试建的，名字是库名加 _owner、_app）：角色拥有的库先删掉，角色才能删。
 * 只认本主机建的、按本主机的进程号判断：别的主机（容器、别的机器）连同一个库服务器时，它们正在用的库与角色不动。模板库不在此列
 */
async function dropAbandoned(client: pg.Client): Promise<void> {
  const databases = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [DATABASE_PREFIX])
  for (const datname of abandonedNames(databases.rows.map(row => row.datname), { prefix: DATABASE_PREFIX, suffix: '_[0-9a-f]+' }))
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`)
  const roles = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE starts_with(rolname, $1)', [DATABASE_PREFIX])
  for (const rolname of abandonedNames(roles.rows.map(row => row.rolname), { prefix: DATABASE_PREFIX, suffix: '_[0-9a-f]+_(?:owner|app)' }))
    await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(rolname)}`)
}

/** 别的迁移（别的检出、别的分支）的模板与它们没建完的半成品：当前的模板与当前的半成品除外 */
export function otherTemplates(names: readonly string[], current: string): string[] {
  return names.filter(name => name !== current && name !== `${current}_building`)
}

/** PostgreSQL 的 SQLSTATE：55006 库正被别的连接使用；55P03 等锁超时（正以它为模板复制，CREATE DATABASE 持有它的锁） */
const OBJECT_IN_USE = '55006'
const LOCK_NOT_AVAILABLE = '55P03'

/** 删不掉是因为有人在用：跳过，留给下一次；别的错误照常抛出 */
export function isInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === OBJECT_IN_USE || code === LOCK_NOT_AVAILABLE
}

/** 删模板时等锁的时限：正以它为模板复制时，DROP 要等复制完；不等，留给下一次 */
const TEMPLATE_DROP_LOCK_TIMEOUT = '1s'

/** 执行语句的连接（单元测试换成假的，记下发出的语句） */
export interface Queryable {
  readonly query: (text: string, values?: unknown[]) => Promise<{ readonly rowCount: number | null }>
}

/**
 * 删掉一个别的迁移的模板，只在没人在用时：有连到它的会话（pg_stat_activity）就跳过——不发 DROP：不用 FORCE 的 DROP 遇到连接时
 * 要在 advisory lock 下等 5 秒才报错，挡住所有测试文件；没有连接时不用 FORCE 地删，删的那一刻有人连上（55006）或正以它为模板复制
 * （等锁超时，55P03）同样跳过
 */
export async function dropUnusedTemplate(client: Queryable, name: string): Promise<void> {
  const connected = await client.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1 LIMIT 1', [name])
  if (connected.rowCount !== 0)
    return
  await client.query(`SET lock_timeout = '${TEMPLATE_DROP_LOCK_TIMEOUT}'`)
  try {
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`)
  }
  catch (error) {
    if (!isInUse(error))
      throw error
  }
  finally {
    await client.query('RESET lock_timeout')
  }
}

/**
 * 确保当前迁移的模板存在：先用临时名创建并迁移，完成后再改名，半成品永远不会被复用。当前迁移的半成品只可能是中断的运行留下的
 * （建模板在 advisory lock 下进行），直接删；别的迁移的模板只删没人在用的（dropUnusedTemplate）
 */
async function ensureTemplate(client: pg.Client): Promise<string> {
  const template = templateName()
  const existing = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [TEMPLATE_PREFIX])
  const names = existing.rows.map(row => row.datname)
  if (!names.includes(template)) {
    const building = `${template}_building`
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(building)} WITH (FORCE)`)
    await client.query(`CREATE DATABASE ${pg.escapeIdentifier(building)}`)
    await runMigrations({ connectionString: databaseUrl(building), lockTimeoutMs: 30_000 })
    await client.query(`ALTER DATABASE ${pg.escapeIdentifier(building)} RENAME TO ${pg.escapeIdentifier(template)}`)
  }
  for (const name of otherTemplates(names, template))
    await dropUnusedTemplate(client, name)
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
  await withTemplateLock(async (client) => {
    await dropAbandoned(client)
    const template = options.migrated === false ? undefined : await ensureTemplate(client)
    await client.query(template === undefined
      ? `CREATE DATABASE ${pg.escapeIdentifier(name)}`
      : `CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE ${pg.escapeIdentifier(template)}`)
  })
  const url = databaseUrl(name)
  return {
    name,
    url,
    query: async fn => withClient(fn, url),
    drop: async () => {
      // 扫描的结果或错误先记下：不论扫描结果如何都要删库，不留下孤儿库
      const swept = options.migrated === false
        ? { violations: undefined }
        : await sweepInvariants(url).then(violations => ({ violations }), (error: unknown) => ({ error }))
      await withClient(async client => client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`))
      if ('error' in swept)
        throw swept.error
      if (swept.violations !== undefined)
        throw new Error(`测试留下的数据违反了只由服务保证的不变量（${name}，库已删掉）：\n${swept.violations}`)
    },
  }
}

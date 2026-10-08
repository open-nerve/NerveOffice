import type { ConfigIssue, ServerConfig } from './config.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { APP_CONFIG, ConfigModule, LOCAL_KEYS_CONFIG } from './config.module.ts'
import { ConfigError, loadConfig, loadServerConfig } from './config.ts'

const DATABASE_URL = 'postgres://nerve:s3cret-password@db.internal:5432/nerve_office'
const PUBLIC_ORIGIN = 'https://docs.example.com'
/** 两个必填项 */
const REQUIRED = { NERVE_DATABASE_URL: DATABASE_URL, NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }

function issuesOf(action: () => unknown): readonly ConfigIssue[] {
  try {
    action()
  }
  catch (error) {
    if (error instanceof ConfigError)
      return error.issues
    throw error
  }
  throw new Error('没有抛出 ConfigError')
}

describe('loadConfig', () => {
  it('只给必填项时，其余取默认值', () => {
    const { database: { url, ...database }, ...rest } = loadConfig({ ...REQUIRED })
    expect(url.reveal()).toBe(DATABASE_URL)
    expect({ database, ...rest }).toEqual({
      database: {
        poolMax: 10,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 10_000,
        migrationLockTimeoutMs: 60_000,
      },
      http: {
        publicOrigin: PUBLIC_ORIGIN,
        host: '0.0.0.0',
        port: 3_000,
        jsonBodyLimitBytes: 262_144,
        requestTimeoutMs: 60_000,
        headersTimeoutMs: 20_000,
        keepAliveTimeoutMs: 5_000,
        trustProxy: false,
      },
      session: { idleTimeoutMinutes: 720, absoluteTimeoutMinutes: 10_080 },
      login: { maxFailures: 5, accountMaxFailures: 50, ipMaxFailures: 50, windowMinutes: 15, lockoutMinutes: 15 },
      oneTimeLinks: { recordMaxFailures: 10 },
      web: { root: undefined },
      shutdown: { timeoutMs: 8_000 },
      log: { level: 'info' },
      password: { argon2: { memoryKib: 19_456, iterations: 2, parallelism: 1 }, hashConcurrency: 2, hashQueue: { maxWaiting: 64, maxWaitMs: 5_000 } },
      // 回收站的自动清理默认开着：每小时一轮，一轮最多 50 个删除单元；
      // 修订记录与回执的保留期清理默认开着：每小时一轮，一批最多 1000 条，保留 30 天（M3-P3 设计 §3.9）
      jobs: {
        trashPurge: { enabled: true, intervalMs: 3_600_000, batchSize: 50 },
        revisionPurge: { enabled: true, intervalMs: 3_600_000, batchSize: 1_000 },
      },
      revisions: { retentionDays: 30 },
      // 页面的版本：默认不按构建拦（只按数据格式，M3-P3 设计 §3.5）
      clients: { minimumBuild: undefined },
      // 快照的检查：2 个子进程，排队 8 个、等 10 秒，一份 10 秒，每个子进程的堆 512 MiB（DEF-018 的测量）
      snapshotInspection: { processes: 2, queue: { maxWaiting: 8, maxWaitMs: 10_000 }, timeoutMs: 10_000, heapMb: 512 },
    })
  })

  it('每个变量都映射到对应的配置项', () => {
    const config = loadConfig({
      NERVE_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
      NERVE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      NERVE_DATABASE_POOL_MAX: '4',
      NERVE_DATABASE_CONNECT_TIMEOUT_MS: '1000',
      NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '2000',
      NERVE_DATABASE_LOCK_TIMEOUT_MS: '3000',
      NERVE_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '4000',
      NERVE_MIGRATION_LOCK_TIMEOUT_MS: '5000',
      NERVE_HTTP_HOST: '127.0.0.1',
      NERVE_HTTP_PORT: '0',
      NERVE_HTTP_JSON_BODY_LIMIT_BYTES: '4096',
      NERVE_HTTP_REQUEST_TIMEOUT_MS: '30000',
      NERVE_HTTP_HEADERS_TIMEOUT_MS: '10000',
      NERVE_HTTP_KEEP_ALIVE_TIMEOUT_MS: '65000',
      NERVE_TRUST_PROXY: '1',
      NERVE_SHUTDOWN_TIMEOUT_MS: '9000',
      NERVE_LOG_LEVEL: 'debug',
      NERVE_PASSWORD_ARGON2_MEMORY_KIB: '47104',
      NERVE_PASSWORD_ARGON2_ITERATIONS: '1',
      NERVE_PASSWORD_ARGON2_PARALLELISM: '2',
      NERVE_PASSWORD_HASH_CONCURRENCY: '8',
      NERVE_PASSWORD_HASH_QUEUE_MAX: '0',
      NERVE_PASSWORD_HASH_QUEUE_TIMEOUT_MS: '2500',
      UV_THREADPOOL_SIZE: '16',
      NERVE_SESSION_IDLE_TIMEOUT_MINUTES: '30',
      NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: '600',
      NERVE_LOGIN_MAX_FAILURES: '3',
      NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '40',
      NERVE_LOGIN_IP_MAX_FAILURES: '1000',
      NERVE_LOGIN_WINDOW_MINUTES: '10',
      NERVE_LOGIN_LOCKOUT_MINUTES: '20',
      NERVE_LINK_RECORD_MAX_FAILURES: '7',
      NERVE_WEB_ROOT: '/srv/nerve-office/web',
      NERVE_TRASH_PURGE_ENABLED: 'false',
      NERVE_TRASH_PURGE_INTERVAL_MS: '900000',
      NERVE_TRASH_PURGE_BATCH: '10',
      NERVE_REVISION_RETENTION_DAYS: '45',
      NERVE_REVISION_PURGE_ENABLED: 'false',
      NERVE_REVISION_PURGE_INTERVAL_MS: '600000',
      NERVE_REVISION_PURGE_BATCH: '250',
      NERVE_SNAPSHOT_INSPECTION_PROCESSES: '4',
      NERVE_SNAPSHOT_INSPECTION_QUEUE_MAX: '0',
      NERVE_SNAPSHOT_INSPECTION_QUEUE_TIMEOUT_MS: '1500',
      NERVE_SNAPSHOT_INSPECTION_TIMEOUT_MS: '20000',
      NERVE_SNAPSHOT_INSPECTION_HEAP_MB: '1024',
      NERVE_MIN_CLIENT_BUILD: '0.2.10',
    })
    const { url, ...database } = config.database
    expect(url.reveal()).toBe('postgresql://u:p@127.0.0.1:5432/db')
    expect(database).toEqual({
      poolMax: 4,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 2_000,
      lockTimeoutMs: 3_000,
      idleInTransactionTimeoutMs: 4_000,
      migrationLockTimeoutMs: 5_000,
    })
    expect(config.http).toEqual({
      publicOrigin: 'http://127.0.0.1:5173',
      host: '127.0.0.1',
      port: 0,
      jsonBodyLimitBytes: 4_096,
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 65_000,
      trustProxy: 1,
    })
    expect(config.shutdown.timeoutMs).toBe(9_000)
    expect(config.log.level).toBe('debug')
    expect(config.password).toEqual({ argon2: { memoryKib: 47_104, iterations: 1, parallelism: 2 }, hashConcurrency: 8, hashQueue: { maxWaiting: 0, maxWaitMs: 2_500 } })
    expect(config.session).toEqual({ idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 600 })
    expect(config.login).toEqual({ maxFailures: 3, accountMaxFailures: 40, ipMaxFailures: 1_000, windowMinutes: 10, lockoutMinutes: 20 })
    expect(config.oneTimeLinks).toEqual({ recordMaxFailures: 7 })
    expect(config.web.root).toBe('/srv/nerve-office/web')
    expect(config.jobs).toEqual({
      trashPurge: { enabled: false, intervalMs: 900_000, batchSize: 10 },
      revisionPurge: { enabled: false, intervalMs: 600_000, batchSize: 250 },
    })
    expect(config.revisions).toEqual({ retentionDays: 45 })
    expect(config.snapshotInspection).toEqual({ processes: 4, queue: { maxWaiting: 0, maxWaitMs: 1_500 }, timeoutMs: 20_000, heapMb: 1_024 })
    expect(config.clients).toEqual({ minimumBuild: '0.2.10' })
  })

  it('最低客户端构建（M3-P3 设计 §3.5）只认 x.y.z：前导零、少一段、多一段、带 + 之后的诊断信息与别的写法都拒绝启动', () => {
    for (const value of ['1.0', '1.0.0.0', '01.0.0', '1.0.0+abc', 'v1.0.0', '1.0.0-rc.1', 'latest', ' 1.0.0'])
      expect(issuesOf(() => loadConfig({ ...REQUIRED, NERVE_MIN_CLIENT_BUILD: value })), value).toEqual([{ variable: 'NERVE_MIN_CLIENT_BUILD', problem: '必须是 x.y.z 的版本号（例如 0.1.3：不带前导零，不带 + 之后的诊断信息）' }])
    expect(loadConfig({ ...REQUIRED, NERVE_MIN_CLIENT_BUILD: '0.0.0' }).clients.minimumBuild).toBe('0.0.0')
    // 空值视为没有设置（编排文件里 VAR= 的写法）
    expect(loadConfig({ ...REQUIRED, NERVE_MIN_CLIENT_BUILD: '' }).clients.minimumBuild).toBeUndefined()
  })

  it('快照检查的子进程按整数范围校验；每个子进程的堆至少 128 MiB（5 MiB 的真实形状要 96 MiB，更低时大表格被误拒为过于复杂，DEF-018）', () => {
    const variablesOf = (extra: Record<string, string>) => issuesOf(() => loadConfig({ ...REQUIRED, ...extra })).map(issue => issue.variable)
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_PROCESSES: '0' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_PROCESSES'])
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_PROCESSES: '65' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_PROCESSES'])
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_QUEUE_MAX: '1001' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_QUEUE_MAX'])
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_QUEUE_TIMEOUT_MS: '99' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_QUEUE_TIMEOUT_MS'])
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_TIMEOUT_MS: '999' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_TIMEOUT_MS'])
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_HEAP_MB: '127' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_HEAP_MB'])
    expect(variablesOf({ NERVE_SNAPSHOT_INSPECTION_HEAP_MB: '16385' })).toEqual(['NERVE_SNAPSHOT_INSPECTION_HEAP_MB'])
    expect(loadConfig({ ...REQUIRED, NERVE_SNAPSHOT_INSPECTION_HEAP_MB: '128', NERVE_SNAPSHOT_INSPECTION_PROCESSES: '1' }).snapshotInspection).toEqual({
      processes: 1,
      queue: { maxWaiting: 8, maxWaitMs: 10_000 },
      timeoutMs: 10_000,
      heapMb: 128,
    })
  })

  it('开关只认 true 与 false：写错时拒绝启动，不静默当成关掉', () => {
    expect(loadConfig({ ...REQUIRED, NERVE_TRASH_PURGE_ENABLED: 'true' }).jobs.trashPurge.enabled).toBe(true)
    expect(loadConfig({ ...REQUIRED, NERVE_REVISION_PURGE_ENABLED: 'true' }).jobs.revisionPurge.enabled).toBe(true)
    for (const variable of ['NERVE_TRASH_PURGE_ENABLED', 'NERVE_REVISION_PURGE_ENABLED']) {
      for (const value of ['1', 'yes', 'on', 'True'])
        expect(issuesOf(() => loadConfig({ ...REQUIRED, [variable]: value }))).toEqual([{ variable, problem: '必须是 true 或 false' }])
    }
  })

  it('修订记录与回执的保留天数至少 15（M3-P3 设计 §3.9）：要长于本机发件箱一条记录的最长留存 14 天，说明里写明理由；上限 3650', () => {
    for (const value of ['14', '0', '3651', '30.5', 'thirty']) {
      const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_REVISION_RETENTION_DAYS: value }))
      expect(issues.map(issue => issue.variable), value).toEqual(['NERVE_REVISION_RETENTION_DAYS'])
      expect(issues[0]?.problem, value).toBe('必须是 15–3650 之间的整数：保留期要长于本机发件箱一条记录的最长留存（14 天，M4），否则发件箱里结果未知的保存重发时找不到原来的结果、重放不了')
    }
    expect(loadConfig({ ...REQUIRED, NERVE_REVISION_RETENTION_DAYS: '15' }).revisions.retentionDays).toBe(15)
    expect(loadConfig({ ...REQUIRED, NERVE_REVISION_RETENTION_DAYS: '3650' }).revisions.retentionDays).toBe(3_650)
  })

  it('保留期清理的间隔与一批的数量按整数范围校验（间隔与回收站的清理相同：1 秒到一天）', () => {
    const variablesOf = (extra: Record<string, string>) => issuesOf(() => loadConfig({ ...REQUIRED, ...extra })).map(issue => issue.variable)
    expect(variablesOf({ NERVE_REVISION_PURGE_INTERVAL_MS: '999' })).toEqual(['NERVE_REVISION_PURGE_INTERVAL_MS'])
    expect(variablesOf({ NERVE_REVISION_PURGE_INTERVAL_MS: '86400001' })).toEqual(['NERVE_REVISION_PURGE_INTERVAL_MS'])
    expect(variablesOf({ NERVE_REVISION_PURGE_BATCH: '0' })).toEqual(['NERVE_REVISION_PURGE_BATCH'])
    expect(variablesOf({ NERVE_REVISION_PURGE_BATCH: '10001' })).toEqual(['NERVE_REVISION_PURGE_BATCH'])
    expect(loadConfig({ ...REQUIRED, NERVE_REVISION_PURGE_INTERVAL_MS: '1000', NERVE_REVISION_PURGE_BATCH: '1' }).jobs.revisionPurge).toEqual({ enabled: true, intervalMs: 1_000, batchSize: 1 })
  })

  it('缺少必填项时失败', () => {
    expect(issuesOf(() => loadConfig({}))).toEqual([
      { variable: 'NERVE_DATABASE_URL', problem: '缺少' },
      { variable: 'NERVE_PUBLIC_ORIGIN', problem: '缺少' },
    ])
  })

  it('空字符串视为没有设置', () => {
    expect(issuesOf(() => loadConfig({ NERVE_DATABASE_URL: '', NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }))).toEqual([{ variable: 'NERVE_DATABASE_URL', problem: '缺少' }])
    expect(loadConfig({ ...REQUIRED, NERVE_HTTP_PORT: '' }).http.port).toBe(3_000)
  })

  it('一次列出全部问题，说明里只有变量名与原因，不含取值', () => {
    const error = (() => {
      try {
        loadConfig({
          NERVE_DATABASE_URL: 'mysql://root:hunter2@db/app',
          NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
          NERVE_HTTP_PORT: '80a',
          NERVE_DATABASE_POOL_MAX: '0',
          NERVE_LOG_LEVEL: 'verbose',
        })
      }
      catch (caught) {
        return caught
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(ConfigError)
    const configError = error as ConfigError
    expect(configError.code).toBe('CONFIG_INVALID')
    expect(configError.issues.map(issue => issue.variable).sort()).toEqual([
      'NERVE_DATABASE_POOL_MAX',
      'NERVE_DATABASE_URL',
      'NERVE_HTTP_PORT',
      'NERVE_LOG_LEVEL',
    ])
    const text = `${configError.message}\n${JSON.stringify(configError.issues)}`
    for (const value of ['hunter2', 'mysql://', '80a', 'verbose'])
      expect(text).not.toContain(value)
  })

  it.each([
    ['NERVE_HTTP_PORT', '65536'],
    ['NERVE_HTTP_PORT', '-1'],
    ['NERVE_HTTP_PORT', '1.5'],
    ['NERVE_DATABASE_POOL_MAX', '101'],
    ['NERVE_HTTP_JSON_BODY_LIMIT_BYTES', '10'],
    ['NERVE_DATABASE_URL', 'not a url'],
    ['NERVE_HTTP_HOST', '   '],
    ['NERVE_WEB_ROOT', 'apps/web/dist'],
  ])('拒绝超出范围或格式不对的取值：%s=%s', (variable, value) => {
    const env = { ...REQUIRED, [variable]: value }
    expect(issuesOf(() => loadConfig(env)).map(issue => issue.variable)).toEqual([variable])
  })

  it('请求时限本身不合法时只报它自己，不连带报请求头时限', () => {
    const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_HTTP_REQUEST_TIMEOUT_MS: '999999999' }))
    expect(issues.map(issue => issue.variable)).toEqual(['NERVE_HTTP_REQUEST_TIMEOUT_MS'])
  })

  it('接收请求头的时限不能超过接收完整请求的时限', () => {
    const issues = issuesOf(() => loadConfig({
      ...REQUIRED,
      NERVE_HTTP_REQUEST_TIMEOUT_MS: '10000',
      NERVE_HTTP_HEADERS_TIMEOUT_MS: '20000',
    }))
    expect(issues.map(issue => issue.variable)).toEqual(['NERVE_HTTP_HEADERS_TIMEOUT_MS'])
  })

  describe('NERVE_PUBLIC_ORIGIN', () => {
    it.each([
      ['https://docs.example.com', 'https://docs.example.com'],
      ['https://Docs.Example.com/', 'https://docs.example.com'],
      ['https://docs.example.com:443', 'https://docs.example.com'],
      ['https://docs.example.com:8443', 'https://docs.example.com:8443'],
      ['http://127.0.0.1:4174', 'http://127.0.0.1:4174'],
      ['http://localhost:5173', 'http://localhost:5173'],
      ['http://[::1]:5173', 'http://[::1]:5173'],
    ])('%s 规范成 %s', (value, expected) => {
      expect(loadConfig({ ...REQUIRED, NERVE_PUBLIC_ORIGIN: value }).http.publicOrigin).toBe(expected)
    })

    it.each([
      'http://docs.example.com',
      'http://10.0.0.5',
      'https://docs.example.com/app',
      'https://docs.example.com/?a=1',
      'https://docs.example.com/#x',
      'https://user:pw@docs.example.com',
      'ftp://docs.example.com',
      'docs.example.com',
    ])('拒绝 %s：不是站点的源，或者不是本机却用 http', (value) => {
      const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_PUBLIC_ORIGIN: value }))
      expect(issues.map(issue => issue.variable)).toEqual(['NERVE_PUBLIC_ORIGIN'])
      expect(issues[0]?.problem).toContain('只有本机调试')
    })
  })

  it('只按用户名的登录失败上限必须大于按用户名与来源的上限（M2-P6 复核 A1）：否则一个来源的失败就能把账户在所有来源上锁住', () => {
    const issuesWith = (extra: Record<string, string>) => issuesOf(() => loadConfig({ ...REQUIRED, ...extra }))
    for (const [perSource, account] of [['5', '5'], ['10', '6']] as const) {
      const issues = issuesWith({ NERVE_LOGIN_MAX_FAILURES: perSource, NERVE_LOGIN_ACCOUNT_MAX_FAILURES: account })
      expect(issues.map(issue => issue.variable), `${perSource}/${account}`).toEqual(['NERVE_LOGIN_ACCOUNT_MAX_FAILURES'])
      expect(issues[0]?.problem).toContain(`现在是 ${account}，必须大于 NERVE_LOGIN_MAX_FAILURES（现在是 ${perSource}）`)
    }
    // 只调了一边：说明里写出另一边用的是默认值
    expect(issuesWith({ NERVE_LOGIN_MAX_FAILURES: '60' })[0]?.problem).toContain('现在是 50（默认值），必须大于 NERVE_LOGIN_MAX_FAILURES（现在是 60）')
    expect(issuesWith({ NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '5' })[0]?.problem).toContain('（现在是 5（默认值））')
    expect(loadConfig({ ...REQUIRED, NERVE_LOGIN_MAX_FAILURES: '5', NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '6' }).login.accountMaxFailures).toBe(6)
  })

  it('开启回收站的自动清理时连接池至少 2 个连接（M2-P6 复核 A 的 G-3）：一个连接持着防重复执行的锁，删除在另一个连接上', () => {
    const issuesWith = (extra: Record<string, string>) => issuesOf(() => loadConfig({ ...REQUIRED, ...extra }))
    // 自动清理默认开启：只把连接池调成 1 就不行，说明里写出两边的值（以及哪个是默认值）与两种改法
    const issues = issuesWith({ NERVE_DATABASE_POOL_MAX: '1' })
    expect(issues.map(issue => issue.variable)).toEqual(['NERVE_DATABASE_POOL_MAX'])
    expect(issues[0]?.problem).toContain('现在是 1，开启回收站的自动清理时至少为 2（NERVE_TRASH_PURGE_ENABLED 现在是 true（默认值））')
    expect(issues[0]?.problem).toContain('或者把 NERVE_TRASH_PURGE_ENABLED 设为 false')
    expect(issuesWith({ NERVE_DATABASE_POOL_MAX: '1', NERVE_TRASH_PURGE_ENABLED: 'true' })[0]?.problem).toContain('NERVE_TRASH_PURGE_ENABLED 现在是 true）')
    // 关掉自动清理时一个连接也可以；两个连接时可以开
    expect(loadConfig({ ...REQUIRED, NERVE_DATABASE_POOL_MAX: '1', NERVE_TRASH_PURGE_ENABLED: 'false' }).database.poolMax).toBe(1)
    expect(loadConfig({ ...REQUIRED, NERVE_DATABASE_POOL_MAX: '2' }).jobs.trashPurge.enabled).toBe(true)
  })

  it('修订记录与回执的保留期清理不抬高连接池的下限（M3-P3 设计 §3.9）：每一批是一个短事务、只占一个连接，两个清理都开着时 2 个连接也够', () => {
    // 两个都开着（默认）：仍然是 2
    const both = loadConfig({ ...REQUIRED, NERVE_DATABASE_POOL_MAX: '2' })
    expect([both.jobs.trashPurge.enabled, both.jobs.revisionPurge.enabled]).toEqual([true, true])
    // 只开保留期清理：1 个连接也可以
    expect(loadConfig({ ...REQUIRED, NERVE_DATABASE_POOL_MAX: '1', NERVE_TRASH_PURGE_ENABLED: 'false', NERVE_REVISION_PURGE_ENABLED: 'true' }).jobs.revisionPurge.enabled).toBe(true)
    // 回收站的清理开着、连接池是 1：照旧只报回收站的那一条，不因为保留期清理多报
    expect(issuesOf(() => loadConfig({ ...REQUIRED, NERVE_DATABASE_POOL_MAX: '1' })).map(issue => issue.variable)).toEqual(['NERVE_DATABASE_POOL_MAX'])
  })

  it('登录与一次性链接的新上限按整数范围校验', () => {
    const variablesOf = (extra: Record<string, string>) => issuesOf(() => loadConfig({ ...REQUIRED, ...extra })).map(issue => issue.variable)
    expect(variablesOf({ NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '1' })).toEqual(['NERVE_LOGIN_ACCOUNT_MAX_FAILURES'])
    expect(variablesOf({ NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '100001' })).toEqual(['NERVE_LOGIN_ACCOUNT_MAX_FAILURES'])
    expect(variablesOf({ NERVE_LINK_RECORD_MAX_FAILURES: '0' })).toEqual(['NERVE_LINK_RECORD_MAX_FAILURES'])
    expect(variablesOf({ NERVE_LINK_RECORD_MAX_FAILURES: '1001' })).toEqual(['NERVE_LINK_RECORD_MAX_FAILURES'])
    expect(loadConfig({ ...REQUIRED, NERVE_LINK_RECORD_MAX_FAILURES: '1' }).oneTimeLinks.recordMaxFailures).toBe(1)
  })

  it('会话的空闲过期不能大于绝对过期', () => {
    const issues = issuesOf(() => loadConfig({
      ...REQUIRED,
      NERVE_SESSION_IDLE_TIMEOUT_MINUTES: '600',
      NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: '60',
    }))
    expect(issues.map(issue => issue.variable)).toEqual(['NERVE_SESSION_IDLE_TIMEOUT_MINUTES'])
  })

  it('Argon2id 的内存与迭代次数的乘积不能低于 OWASP 最低推荐里最弱的一组（7168 × 5）', () => {
    const cost = (memory: string, iterations: string) => issuesOf(() => loadConfig({
      ...REQUIRED,
      NERVE_PASSWORD_ARGON2_MEMORY_KIB: memory,
      NERVE_PASSWORD_ARGON2_ITERATIONS: iterations,
    }))
    expect(cost('8192', '4').map(issue => issue.variable)).toEqual(['NERVE_PASSWORD_ARGON2_MEMORY_KIB'])
    expect(cost('19456', '1')[0]?.problem).toContain('35840')
    for (const [memory, iterations] of [['47104', '1'], ['19456', '2'], ['12288', '3'], ['9216', '4'], ['8192', '5']])
      expect(loadConfig({ ...REQUIRED, NERVE_PASSWORD_ARGON2_MEMORY_KIB: memory, NERVE_PASSWORD_ARGON2_ITERATIONS: iterations }).password.argon2.memoryKib).toBe(Number(memory))
  })

  it('哈希的并发上限不超过 libuv 线程池（UV_THREADPOOL_SIZE，默认 4）的一半（复验 R11）', () => {
    const issuesWith = (extra: Record<string, string>) => issuesOf(() => loadConfig({ ...REQUIRED, ...extra }))
    expect(issuesWith({ NERVE_PASSWORD_HASH_CONCURRENCY: '3' }).map(issue => issue.variable)).toEqual(['NERVE_PASSWORD_HASH_CONCURRENCY'])
    expect(issuesWith({ NERVE_PASSWORD_HASH_CONCURRENCY: '3' })[0]?.problem).toContain('UV_THREADPOOL_SIZE 现在是 4（默认值）')
    // 说明里写出两边的现值（包括是不是默认值）与两种改法（复验 S4）
    const problem = issuesWith({ UV_THREADPOOL_SIZE: '3' })[0]?.problem ?? ''
    expect(problem).toContain('现在是 2（默认值）')
    expect(problem).toContain('UV_THREADPOOL_SIZE 现在是 3，哈希最多 1 个')
    expect(problem).toContain('调到至少 4')
    expect(loadConfig({ ...REQUIRED, NERVE_PASSWORD_HASH_CONCURRENCY: '8', UV_THREADPOOL_SIZE: '16' }).password.hashConcurrency).toBe(8)
    expect(loadConfig({ ...REQUIRED, NERVE_PASSWORD_HASH_CONCURRENCY: '1', UV_THREADPOOL_SIZE: '2' }).password.hashConcurrency).toBe(1)
  })

  it('UV_THREADPOOL_SIZE 要么不设，要么是 2–1024 的整数：libuv 把空值、非数字与 0 当作 1 个线程（复验 S1）', () => {
    for (const size of ['', '0', '1', '1025', 'four', '2.5', '8abc', ' 4']) {
      const issues = issuesOf(() => loadConfig({ ...REQUIRED, UV_THREADPOOL_SIZE: size }))
      expect(issues.map(issue => issue.variable), JSON.stringify(size)).toEqual(['UV_THREADPOOL_SIZE'])
      expect(issues[0]?.problem).toContain('1 个线程')
    }
  })

  it('UV_THREADPOOL_SIZE 不合法时，与别的变量的问题一起报出（复验 S3）', () => {
    const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_LOG_LEVEL: 'bad', UV_THREADPOOL_SIZE: 'four' }))
    expect(issues.map(issue => issue.variable).sort()).toEqual(['NERVE_LOG_LEVEL', 'UV_THREADPOOL_SIZE'])
  })

  it('不认识的 NERVE_ 变量（多半是拼写错误）让启动失败；NERVE_TEST_ 留给测试工具，其他前缀不管', () => {
    const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_DATABSE_POOL_MAX: '4' }))
    expect(issues.map(issue => issue.variable)).toEqual(['NERVE_DATABSE_POOL_MAX'])
    expect(issues[0]?.problem).toContain('不认识')
    expect(() => loadConfig({ ...REQUIRED, NERVE_TEST_DATABASE_URL: 'x', PATH: '/bin', DATABASE_URL: 'x' })).not.toThrow()
  })

  describe('机密可以用 <变量>_FILE 从文件读取', () => {
    it('读取文件内容，去掉末尾的换行', () => {
      const config = loadConfig({ NERVE_DATABASE_URL_FILE: '/run/secrets/db', NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }, path => (path === '/run/secrets/db' ? `${DATABASE_URL}\n` : ''))
      expect(config.database.url.reveal()).toBe(DATABASE_URL)
    })

    it('文件内容不合法时，问题记在 _FILE 变量上并说明原因；空文件单独说明', () => {
      const invalid = issuesOf(() => loadConfig({ NERVE_DATABASE_URL_FILE: '/run/secrets/db', NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }, () => 'mysql://root:hunter2@db/app\n'))
      expect(invalid).toEqual([{ variable: 'NERVE_DATABASE_URL_FILE', problem: '文件内容必须是 postgres:// 或 postgresql:// 开头的连接串' }])
      expect(JSON.stringify(invalid)).not.toContain('hunter2')
      expect(issuesOf(() => loadConfig({ NERVE_DATABASE_URL_FILE: '/run/secrets/db', NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }, () => '\n'))).toEqual([{ variable: 'NERVE_DATABASE_URL_FILE', problem: '指定的文件是空的' }])
    })

    it('变量与 _FILE 同时设置时失败', () => {
      const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_DATABASE_URL_FILE: '/run/secrets/db' }, () => DATABASE_URL))
      expect(issues.map(issue => issue.variable)).toEqual(['NERVE_DATABASE_URL'])
      expect(issues[0]?.problem).toContain('NERVE_DATABASE_URL_FILE')
    })

    it('文件读不到时失败，说明里没有路径以外的内容', () => {
      const issues = issuesOf(() => loadConfig({ NERVE_DATABASE_URL_FILE: '/run/secrets/missing', NERVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }, () => {
        throw new Error('ENOENT')
      }))
      expect(issues.map(issue => issue.variable)).toEqual(['NERVE_DATABASE_URL_FILE'])
      expect(issues[0]?.problem).toContain('读取失败')
    })

    it('只有登记为机密的变量支持 _FILE', () => {
      const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_HTTP_PORT_FILE: '/tmp/port' }, () => '3000'))
      expect(issues.map(issue => issue.variable)).toEqual(['NERVE_HTTP_PORT_FILE'])
    })
  })

  describe('NERVE_TRUST_PROXY', () => {
    it.each([
      ['1', 1],
      ['2', 2],
      ['loopback', ['loopback']],
      ['loopback, 10.0.0.0/8,fd00::/8, 172.18.0.2', ['loopback', '10.0.0.0/8', 'fd00::/8', '172.18.0.2']],
    ])('%s', (value, expected) => {
      expect(loadConfig({ ...REQUIRED, NERVE_TRUST_PROXY: value }).http.trustProxy).toEqual(expected)
    })

    it.each(['true', '0', '11', 'proxy.internal', '10.0.0.0/33', '10.0.0.0/8/1', '10.0.0.0/x', 'loopback,'])('拒绝 %s', (value) => {
      const issues = issuesOf(() => loadConfig({ ...REQUIRED, NERVE_TRUST_PROXY: value }))
      expect(issues.map(issue => issue.variable)).toEqual(['NERVE_TRUST_PROXY'])
    })
  })

  it('连接串是机密：整个配置被序列化时不带密码', () => {
    expect(JSON.stringify(loadConfig({ ...REQUIRED }))).not.toContain('s3cret-password')
  })

  it('返回的配置被冻结，运行中不能被改写', () => {
    const config = loadConfig({ ...REQUIRED, NERVE_TRUST_PROXY: 'loopback' })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.http)).toBe(true)
    expect(Object.isFrozen(config.http.trustProxy)).toBe(true)
  })
})

describe('本机密钥的主密钥（M3-P6 设计 §3.4）', () => {
  const MASTER_KEY = randomBytes(32).toString('base64')
  const SERVER = { ...REQUIRED, NERVE_LOCAL_KEYS_MASTER_KEY: MASTER_KEY }
  const PROBLEM = '必须是 32 字节随机数的标准 base64（44 个字符、以 = 结尾，例如 openssl rand -base64 32 的输出）'
  /** 可读的 32 字节（开发、测试用的那种） */
  const READABLE = Buffer.from('nerve-office-test-only-masterkey').toString('base64')

  it('应用进程的读法：主密钥用 Secret 包住，配置被冻结；其余与命令行的读法相同', () => {
    const config = loadServerConfig(SERVER)
    expect(config.localKeys.masterKey.reveal()).toBe(MASTER_KEY)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.localKeys)).toBe(true)
    const { localKeys, ...app } = config
    void localKeys
    const { database: { url, ...database }, ...rest } = app
    const { database: { url: commandUrl, ...commandDatabase }, ...commandRest } = loadConfig(SERVER)
    expect(url.reveal()).toBe(commandUrl.reveal())
    expect({ database, ...rest }).toEqual({ database: commandDatabase, ...commandRest })
  })

  it('应用进程缺主密钥：报"缺少"；别的变量也有问题时一起列出（它不依赖别的变量）', () => {
    expect(issuesOf(() => loadServerConfig({ ...REQUIRED }))).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: '缺少' }])
    expect(issuesOf(() => loadServerConfig({ ...REQUIRED, NERVE_LOCAL_KEYS_MASTER_KEY: '' }))).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: '缺少' }])
    expect(issuesOf(() => loadServerConfig({}))).toEqual([
      { variable: 'NERVE_DATABASE_URL', problem: '缺少' },
      { variable: 'NERVE_PUBLIC_ORIGIN', problem: '缺少' },
      { variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: '缺少' },
    ])
  })

  it('命令行的读法不要求它：没有时照常；给了也只校验写法，不带进配置（迁移、初始化管理员、签发重置链接拿不到它）', () => {
    expect(loadConfig({ ...REQUIRED })).not.toHaveProperty('localKeys')
    const config = loadConfig(SERVER)
    expect(config).not.toHaveProperty('localKeys')
    expect(JSON.stringify(config)).not.toContain(MASTER_KEY)
    expect(issuesOf(() => loadConfig({ ...REQUIRED, NERVE_LOCAL_KEYS_MASTER_KEY: MASTER_KEY.slice(0, -1) }))).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: PROBLEM }])
  })

  it.each([
    ['缺填充', (key: string) => key.slice(0, -1)],
    ['base64url 的字符', () => Buffer.alloc(32, 0xFB).toString('base64').replaceAll('+', '-').replaceAll('/', '_')],
    ['非规范的尾位（第 43 个字符的低 2 位不是 0）', () => `${'A'.repeat(42)}B=`],
    ['31 字节（两个等号的填充）', () => randomBytes(31).toString('base64')],
    ['33 字节', () => randomBytes(33).toString('base64')],
    ['开头有空白', (key: string) => ` ${key}`],
    ['结尾有空白', (key: string) => `${key} `],
    ['中间夹着换行', (key: string) => `${key.slice(0, 20)}\n${key.slice(20)}`],
    ['夹杂非法字符', (key: string) => `${key.slice(0, 10)}!${key.slice(11)}`],
    ['十六进制（64 个字符）', () => randomBytes(32).toString('hex')],
    ['48 字节（多抄了一段）', () => randomBytes(48).toString('base64')],
  ])('写法不对时拒绝启动（%s），说明里不带取值', (_case, alter) => {
    const value = alter(MASTER_KEY)
    for (const read of [loadServerConfig, loadConfig]) {
      const issues = issuesOf(() => read({ ...REQUIRED, NERVE_LOCAL_KEYS_MASTER_KEY: value }))
      expect(issues).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: PROBLEM }])
      expect(JSON.stringify(issues)).not.toContain(value.trim())
    }
  })

  it('openssl rand -base64 32 的各种输出都收：尾字符是 A E I M Q U Y c g k o s w 0 4 8 之一', () => {
    for (const last of 'AEIMQUYcgkosw048') {
      const key = `${'A'.repeat(42)}${last}=`
      expect(Buffer.from(key, 'base64')).toHaveLength(32)
      expect(loadServerConfig({ ...REQUIRED, NERVE_LOCAL_KEYS_MASTER_KEY: key }).localKeys.masterKey.reveal(), last).toBe(key)
    }
  })

  it('NERVE_LOCAL_KEYS_MASTER_KEY_FILE：读文件、去掉末尾的一个换行；空文件、读不到、与变量同时设置、内容不对时都拒绝，问题记在运维设置的变量上、不带取值', () => {
    const read = (content: string) => (path: string) => (path === '/run/secrets/master-key' ? content : '')
    const fileEnv = { ...REQUIRED, NERVE_LOCAL_KEYS_MASTER_KEY_FILE: '/run/secrets/master-key' }
    expect(loadServerConfig(fileEnv, read(`${MASTER_KEY}\n`)).localKeys.masterKey.reveal()).toBe(MASTER_KEY)
    expect(loadServerConfig(fileEnv, read(`${MASTER_KEY}\r\n`)).localKeys.masterKey.reveal()).toBe(MASTER_KEY)
    expect(issuesOf(() => loadServerConfig(fileEnv, read('\n')))).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY_FILE', problem: '指定的文件是空的' }])
    expect(issuesOf(() => loadServerConfig(fileEnv, () => {
      throw new Error('EACCES')
    }))).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY_FILE', problem: '指定的文件读取失败' }])
    const both = issuesOf(() => loadServerConfig({ ...fileEnv, NERVE_LOCAL_KEYS_MASTER_KEY: MASTER_KEY }, read(MASTER_KEY)))
    expect(both).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: '与 NERVE_LOCAL_KEYS_MASTER_KEY_FILE 只能设置一个' }])
    const hex = randomBytes(32).toString('hex')
    const invalid = issuesOf(() => loadServerConfig(fileEnv, read(`${hex}\n`)))
    expect(invalid).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY_FILE', problem: `文件内容${PROBLEM}` }])
    expect(JSON.stringify(invalid)).not.toContain(hex)
    // 文件里多一个换行（echo 之后又追加了一行）：只去掉一个，剩下的换行让写法不对
    expect(issuesOf(() => loadServerConfig(fileEnv, read(`${MASTER_KEY}\n\n`)))).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY_FILE', problem: `文件内容${PROBLEM}` }])
  })

  it('公开地址是 HTTPS 时拒绝全是可打印字符的主密钥（入库的开发、测试用密钥不会被抄进正式部署）；本机调试的 HTTP 照常收；随机的照常', () => {
    const https = { ...REQUIRED, NERVE_PUBLIC_ORIGIN: 'https://docs.example.com' }
    const issues = issuesOf(() => loadServerConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY: READABLE }))
    expect(issues.map(issue => issue.variable)).toEqual(['NERVE_LOCAL_KEYS_MASTER_KEY'])
    expect(issues[0]?.problem).toContain('不能用全是可打印字符的主密钥')
    expect(issues[0]?.problem).toContain('openssl rand -base64 32')
    expect(JSON.stringify(issues)).not.toContain(READABLE)
    // 从文件读的：问题记在 _FILE 上
    expect(issuesOf(() => loadServerConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY_FILE: '/run/secrets/master-key' }, () => READABLE)).map(issue => issue.variable)).toEqual(['NERVE_LOCAL_KEYS_MASTER_KEY_FILE'])
    // 命令行的读法同样（配置本身就是错的）
    expect(issuesOf(() => loadConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY: READABLE })).map(issue => issue.variable)).toEqual(['NERVE_LOCAL_KEYS_MASTER_KEY'])
    expect(loadServerConfig({ ...REQUIRED, NERVE_PUBLIC_ORIGIN: 'http://127.0.0.1:4100', NERVE_LOCAL_KEYS_MASTER_KEY: READABLE }).localKeys.masterKey.reveal()).toBe(READABLE)
    // 只有一个字节落在可打印范围之外：不算可读
    const almost = Buffer.from('nerve-office-test-only-masterkey')
    almost[31] = 0x80
    expect(loadServerConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY: almost.toString('base64') }).localKeys.masterKey.reveal()).toBe(almost.toString('base64'))
    expect(loadServerConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY: MASTER_KEY }).localKeys.masterKey.reveal()).toBe(MASTER_KEY)
  })

  it('可打印的边界（审查 A5）：0x20（空格）与 0x7E（~）算可打印，其余字节也可读时拒绝；0x1F 与 0x7F 不算，照常收', () => {
    const https = { ...REQUIRED, NERVE_PUBLIC_ORIGIN: 'https://docs.example.com' }
    /** 可读的 32 个字节，中间一个换成给定的字节 */
    const keyWith = (byte: number): string => {
      const bytes = Buffer.from('nerve-office-test-only-masterkey')
      bytes[15] = byte
      return bytes.toString('base64')
    }
    for (const byte of [0x20, 0x7E]) {
      const issues = issuesOf(() => loadServerConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY: keyWith(byte) }))
      expect(issues.map(issue => issue.problem), `0x${byte.toString(16)}`).toEqual([expect.stringContaining('不能用全是可打印字符的主密钥')])
    }
    for (const byte of [0x1F, 0x7F])
      expect(loadServerConfig({ ...https, NERVE_LOCAL_KEYS_MASTER_KEY: keyWith(byte) }).localKeys.masterKey.reveal(), `0x${byte.toString(16)}`).toBe(keyWith(byte))
  })

  it('主密钥是机密：整个配置被序列化、被打印时都不带它', () => {
    const config = loadServerConfig(SERVER)
    expect(JSON.stringify(config)).not.toContain(MASTER_KEY)
    expect(inspect(config, { depth: 10 })).not.toContain(MASTER_KEY)
    expect(String(config.localKeys.masterKey)).not.toContain(MASTER_KEY)
  })

  it('应用进程的组装（ConfigModule.forServer）：APP_CONFIG 里没有主密钥，主密钥只经 LOCAL_KEYS_CONFIG 给出', () => {
    const config: ServerConfig = loadServerConfig(SERVER)
    const providers = (ConfigModule.forServer(config).providers ?? []) as { provide: symbol, useValue: unknown }[]
    const app = providers.find(provider => provider.provide === APP_CONFIG)?.useValue
    const localKeys = providers.find(provider => provider.provide === LOCAL_KEYS_CONFIG)?.useValue
    expect(app).not.toHaveProperty('localKeys')
    expect(Object.isFrozen(app)).toBe(true)
    expect(app).toMatchObject({ http: config.http, database: config.database })
    expect(localKeys).toBe(config.localKeys)
    // 命令行的组装只有 APP_CONFIG
    expect((ConfigModule.forRoot(loadConfig(SERVER)).providers ?? []).map(provider => (provider as { provide: symbol }).provide)).toEqual([APP_CONFIG])
  })
})

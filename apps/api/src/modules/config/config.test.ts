import type { ConfigIssue } from './config.ts'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

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
      login: { maxFailures: 5, ipMaxFailures: 50, windowMinutes: 15, lockoutMinutes: 15 },
      web: { root: undefined },
      shutdown: { timeoutMs: 8_000 },
      log: { level: 'info' },
      password: { argon2: { memoryKib: 19_456, iterations: 2, parallelism: 1 }, hashConcurrency: 2 },
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
      NERVE_SESSION_IDLE_TIMEOUT_MINUTES: '30',
      NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: '600',
      NERVE_LOGIN_MAX_FAILURES: '3',
      NERVE_LOGIN_IP_MAX_FAILURES: '1000',
      NERVE_LOGIN_WINDOW_MINUTES: '10',
      NERVE_LOGIN_LOCKOUT_MINUTES: '20',
      NERVE_WEB_ROOT: '/srv/nerve-office/web',
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
    expect(config.password).toEqual({ argon2: { memoryKib: 47_104, iterations: 1, parallelism: 2 }, hashConcurrency: 8 })
    expect(config.session).toEqual({ idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 600 })
    expect(config.login).toEqual({ maxFailures: 3, ipMaxFailures: 1_000, windowMinutes: 10, lockoutMinutes: 20 })
    expect(config.web.root).toBe('/srv/nerve-office/web')
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

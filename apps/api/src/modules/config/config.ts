// 配置（规范 §7，P2 设计 §3.3）：全部来自环境变量，机密也可以用 <变量>_FILE 从文件读取。
// 启动时一次校验全部变量，不合法就列出变量名与原因（不含取值，取值可能是机密）后退出。
// api 里只有这个模块读取 process.env（lint 强制）。
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { Secret } from '../../shared/secret.ts'

/** 应用的变量都以它开头；不认识的视为拼写错误。 */
const PREFIX = 'NERVE_'
/** 留给测试工具的变量（例如集成测试的数据库地址）：应用不读取，也不当作拼写错误。 */
const RESERVED_FOR_TESTS = 'NERVE_TEST_'
const FILE_SUFFIX = '_FILE'
/** 可以用 `<变量>_FILE` 从文件读取的机密。 */
const SECRETS: ReadonlySet<string> = new Set(['NERVE_DATABASE_URL'])

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** 同 Express 的 `trust proxy`：不信任、信任的跳数，或者地址、网段与 loopback 等名称的列表。 */
export type TrustProxy = false | number | readonly string[]

export interface AppConfig {
  readonly database: {
    /** 连接串里有密码：只在建立连接时 reveal() */
    readonly url: Secret
    readonly poolMax: number
    readonly connectTimeoutMs: number
    readonly statementTimeoutMs: number
    readonly lockTimeoutMs: number
    readonly idleInTransactionTimeoutMs: number
    readonly migrationLockTimeoutMs: number
  }
  readonly http: {
    /**
     * 浏览器访问本站的源（协议、主机与端口），例如 https://docs.example.com。
     * 用于状态变更请求的 Origin 检查与会话 Cookie 的属性（P3 设计 §3.5）
     */
    readonly publicOrigin: string
    readonly host: string
    readonly port: number
    readonly jsonBodyLimitBytes: number
    readonly requestTimeoutMs: number
    readonly headersTimeoutMs: number
    readonly keepAliveTimeoutMs: number
    readonly trustProxy: TrustProxy
  }
  readonly session: {
    /** 空闲过期：随活动顺延，但不超过绝对过期 */
    readonly idleTimeoutMinutes: number
    readonly absoluteTimeoutMinutes: number
  }
  readonly login: {
    /** 按用户名：窗口内允许失败的次数，达到后锁定 */
    readonly maxFailures: number
    /** 按客户端地址：窗口内允许失败的次数，达到后锁定 */
    readonly ipMaxFailures: number
    readonly windowMinutes: number
    readonly lockoutMinutes: number
  }
  readonly web: {
    /** 前端构建目录的绝对路径；不设时不托管前端（开发时由 Vite 开发服务器提供，P3 设计 §3.8） */
    readonly root: string | undefined
  }
  readonly shutdown: { readonly timeoutMs: number }
  readonly log: { readonly level: LogLevel }
  readonly password: {
    /** Argon2id 的参数（00 号计划书 §11.1）：按部署机器的基准测试调整；改了之后，下次登录成功时重新哈希 */
    readonly argon2: { readonly memoryKib: number, readonly iterations: number, readonly parallelism: number }
    /**
     * 同时进行的哈希计算的上限。Argon2 在 libuv 的线程池里计算，线程池也负责读文件与解析域名：
     * 上限不超过线程池（UV_THREADPOOL_SIZE，默认 4）的一半；调大线程池时一并调大
     */
    readonly hashConcurrency: number
  }
}

export interface ConfigIssue {
  readonly variable: string
  readonly problem: string
}

/** 配置不合法。说明里只有变量名与原因，不含取值。 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  readonly code = 'CONFIG_INVALID'

  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`配置不合法：${issues.map(issue => `${issue.variable}（${issue.problem}）`).join('；')}`)
  }
}

function text() {
  return z.string({ error: issue => (issue.input === undefined ? '缺少' : '必须是文本') })
}

function integer(min: number, max: number) {
  const problem = `必须是 ${min}–${max} 之间的整数`
  return text()
    .regex(/^\d+$/, problem)
    .transform(Number)
    .pipe(z.number().int().min(min, problem).max(max, problem))
}

/** 只有本机调试时，公开地址可以是 HTTP（Cookie 这时不带 Secure）。URL 的 hostname 里 IPv6 带方括号 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
const PUBLIC_ORIGIN_PROBLEM = '必须是站点的源（协议、主机与端口，例如 https://docs.example.com），不带路径、查询串与账号；只有本机调试（127.0.0.1、localhost、::1）可以用 http'

/** 规范成 URL 的 origin（去掉末尾的斜杠、默认端口，主机名转成小写）。 */
const publicOrigin = text().transform((value, ctx): string => {
  const url = URL.canParse(value) ? new URL(value) : undefined
  const isOrigin = url !== undefined
    && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
    && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  if (url === undefined || !isOrigin) {
    ctx.issues.push({ code: 'custom', message: PUBLIC_ORIGIN_PROBLEM, input: value })
    return z.NEVER
  }
  return url.origin
})

const TRUST_PROXY_NAMES: ReadonlySet<string> = new Set(['loopback', 'linklocal', 'uniquelocal'])
const TRUST_PROXY_PROBLEM = '必须是 1–10 的跳数，或者由 IP 地址、网段与 loopback、linklocal、uniquelocal 组成的逗号分隔列表'

function isTrustedProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_NAMES.has(entry))
    return true
  const parts = entry.split('/')
  if (parts.length > 2)
    return false
  const [address = '', prefix] = parts
  const version = isIP(address)
  if (version === 0)
    return false
  return prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128))
}

// 不接受 true（信任任何来源）：客户端可以伪造 X-Forwarded-For，冒充任意地址
const trustProxy = text().transform((value, ctx): number | string[] => {
  if (/^\d+$/.test(value)) {
    const hops = Number(value)
    if (hops >= 1 && hops <= 10)
      return hops
  }
  else {
    const entries = value.split(',').map(entry => entry.trim())
    if (entries.every(isTrustedProxyEntry))
      return entries
  }
  ctx.issues.push({ code: 'custom', message: TRUST_PROXY_PROBLEM, input: value })
  return z.NEVER
})

const environmentSchema = z.object({
  NERVE_DATABASE_URL: text().pipe(z.url({ protocol: /^postgres(?:ql)?$/, error: '必须是 postgres:// 或 postgresql:// 开头的连接串' })),
  NERVE_DATABASE_POOL_MAX: integer(1, 100).default(10),
  NERVE_DATABASE_CONNECT_TIMEOUT_MS: integer(100, 60_000).default(5_000),
  NERVE_DATABASE_STATEMENT_TIMEOUT_MS: integer(100, 600_000).default(15_000),
  NERVE_DATABASE_LOCK_TIMEOUT_MS: integer(100, 600_000).default(5_000),
  NERVE_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: integer(100, 600_000).default(10_000),
  NERVE_MIGRATION_LOCK_TIMEOUT_MS: integer(100, 3_600_000).default(60_000),
  NERVE_PUBLIC_ORIGIN: publicOrigin,
  NERVE_HTTP_HOST: text().trim().min(1, '不能为空').default('0.0.0.0'),
  NERVE_HTTP_PORT: integer(0, 65_535).default(3_000),
  NERVE_HTTP_JSON_BODY_LIMIT_BYTES: integer(1_024, 16 * 1024 * 1024).default(262_144),
  NERVE_HTTP_REQUEST_TIMEOUT_MS: integer(1_000, 600_000).default(60_000),
  NERVE_HTTP_HEADERS_TIMEOUT_MS: integer(1_000, 600_000).default(20_000),
  NERVE_HTTP_KEEP_ALIVE_TIMEOUT_MS: integer(1_000, 600_000).default(5_000),
  NERVE_TRUST_PROXY: trustProxy.optional(),
  NERVE_WEB_ROOT: text().refine(isAbsolute, '必须是绝对路径').optional(),
  NERVE_SESSION_IDLE_TIMEOUT_MINUTES: integer(5, 43_200).default(720),
  NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: integer(5, 525_600).default(10_080),
  NERVE_LOGIN_MAX_FAILURES: integer(1, 100).default(5),
  NERVE_LOGIN_IP_MAX_FAILURES: integer(1, 100_000).default(50),
  NERVE_LOGIN_WINDOW_MINUTES: integer(1, 1_440).default(15),
  NERVE_LOGIN_LOCKOUT_MINUTES: integer(1, 1_440).default(15),
  NERVE_SHUTDOWN_TIMEOUT_MS: integer(100, 600_000).default(8_000),
  NERVE_LOG_LEVEL: z.enum(LOG_LEVELS, { error: `必须是 ${LOG_LEVELS.join('、')} 之一` }).default('info'),
  // 默认是 OWASP 的最低推荐（内存 19 MiB、迭代 2 次、并行度 1）；内存与迭代次数的乘积另有下限，见交叉检查
  NERVE_PASSWORD_ARGON2_MEMORY_KIB: integer(8_192, 1_048_576).default(19_456),
  NERVE_PASSWORD_ARGON2_ITERATIONS: integer(1, 20).default(2),
  NERVE_PASSWORD_ARGON2_PARALLELISM: integer(1, 16).default(1),
  NERVE_PASSWORD_HASH_CONCURRENCY: integer(1, 512).default(2),
})

type Environment = z.output<typeof environmentSchema>

/**
 * OWASP 给出的几组等强度的 Argon2id 最低参数（内存 KiB × 迭代次数）：47104 × 1、19456 × 2、12288 × 3、9216 × 4、7168 × 5。
 * 乘积最小的一组是 7168 × 5 = 35840：低于它，任何组合都比最低推荐弱。
 */
const ARGON2_MIN_COST = 35_840

/**
 * libuv 线程池的大小（UV_THREADPOOL_SIZE）：libuv 自己读这个变量。不设时 4 个线程；设了就按 atoi 解析，
 * 空值、非数字与 0 都变成 1 个线程，"2.5" 变成 2，不会回到默认值（复验 S1：编排文件里 `VAR=` 的写法会得到 1 个线程）。
 * 所以这里要求：不设，或者是 2–1024 的整数。1 个线程时哈希、读文件与解析域名只能互相等待，哈希"最多占一半"也做不到。
 */
const THREADPOOL_DEFAULT = 4
const THREADPOOL_VARIABLE = 'UV_THREADPOOL_SIZE'
const THREADPOOL_PROBLEM = '要么不设（默认 4 个线程），要么是 2–1024 之间的整数：libuv 把空值、非数字与 0 都当作 1 个线程，哈希、读文件与解析域名会互相等待'

interface Threadpool {
  readonly size: number
  /** 没设这个变量，用的是 libuv 的默认值 */
  readonly isDefault: boolean
}

/** 线程池的大小；设了但不合法时返回 undefined。 */
function threadpoolOf(value: string | undefined): Threadpool | undefined {
  if (value === undefined)
    return { size: THREADPOOL_DEFAULT, isDefault: true }
  if (!/^\d+$/.test(value))
    return undefined
  const size = Number(value)
  return size >= 2 && size <= 1_024 ? { size, isDefault: false } : undefined
}

/**
 * 变量之间的约束：只在每个变量各自合法之后检查，免得一个错误报两次。
 * threadpool 是 libuv 线程池的大小，不合法时为 undefined（它自己的问题另外报出，这里不再比较）；
 * defaults 是没有设置、用了默认值的变量。
 */
function crossChecks(env: Environment, threadpool: Threadpool | undefined, defaults: ReadonlySet<string>): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (env.NERVE_HTTP_HEADERS_TIMEOUT_MS > env.NERVE_HTTP_REQUEST_TIMEOUT_MS)
    issues.push({ variable: 'NERVE_HTTP_HEADERS_TIMEOUT_MS', problem: '不能大于 NERVE_HTTP_REQUEST_TIMEOUT_MS' })
  if (env.NERVE_SESSION_IDLE_TIMEOUT_MINUTES > env.NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES)
    issues.push({ variable: 'NERVE_SESSION_IDLE_TIMEOUT_MINUTES', problem: '不能大于 NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES' })
  if (env.NERVE_PASSWORD_ARGON2_MEMORY_KIB * env.NERVE_PASSWORD_ARGON2_ITERATIONS < ARGON2_MIN_COST) {
    issues.push({
      variable: 'NERVE_PASSWORD_ARGON2_MEMORY_KIB',
      problem: `与 NERVE_PASSWORD_ARGON2_ITERATIONS 的乘积不能低于 ${ARGON2_MIN_COST}（OWASP 的最低推荐，例如 19456 × 2、47104 × 1）`,
    })
  }
  // 哈希在 libuv 的线程池里计算，线程池也负责读文件与解析域名：哈希最多占一半（复验 R11）
  const concurrency = env.NERVE_PASSWORD_HASH_CONCURRENCY
  if (threadpool !== undefined && concurrency > Math.floor(threadpool.size / 2)) {
    const current = (value: number, isDefault: boolean): string => `${value}${isDefault ? '（默认值）' : ''}`
    issues.push({
      variable: 'NERVE_PASSWORD_HASH_CONCURRENCY',
      problem: `现在是 ${current(concurrency, defaults.has('NERVE_PASSWORD_HASH_CONCURRENCY'))}，不能超过 libuv 线程池的一半：`
        + `${THREADPOOL_VARIABLE} 现在是 ${current(threadpool.size, threadpool.isDefault)}，哈希最多 ${Math.floor(threadpool.size / 2)} 个（线程池也负责读文件与解析域名）。`
        + `把它调小，或者把 ${THREADPOOL_VARIABLE} 调到至少 ${concurrency * 2}`,
    })
  }
  return issues
}

function toAppConfig(env: Environment): AppConfig {
  return {
    database: {
      url: new Secret(env.NERVE_DATABASE_URL),
      poolMax: env.NERVE_DATABASE_POOL_MAX,
      connectTimeoutMs: env.NERVE_DATABASE_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: env.NERVE_DATABASE_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: env.NERVE_DATABASE_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: env.NERVE_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      migrationLockTimeoutMs: env.NERVE_MIGRATION_LOCK_TIMEOUT_MS,
    },
    http: {
      publicOrigin: env.NERVE_PUBLIC_ORIGIN,
      host: env.NERVE_HTTP_HOST,
      port: env.NERVE_HTTP_PORT,
      jsonBodyLimitBytes: env.NERVE_HTTP_JSON_BODY_LIMIT_BYTES,
      requestTimeoutMs: env.NERVE_HTTP_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: env.NERVE_HTTP_HEADERS_TIMEOUT_MS,
      keepAliveTimeoutMs: env.NERVE_HTTP_KEEP_ALIVE_TIMEOUT_MS,
      trustProxy: env.NERVE_TRUST_PROXY ?? false,
    },
    session: {
      idleTimeoutMinutes: env.NERVE_SESSION_IDLE_TIMEOUT_MINUTES,
      absoluteTimeoutMinutes: env.NERVE_SESSION_ABSOLUTE_TIMEOUT_MINUTES,
    },
    login: {
      maxFailures: env.NERVE_LOGIN_MAX_FAILURES,
      ipMaxFailures: env.NERVE_LOGIN_IP_MAX_FAILURES,
      windowMinutes: env.NERVE_LOGIN_WINDOW_MINUTES,
      lockoutMinutes: env.NERVE_LOGIN_LOCKOUT_MINUTES,
    },
    web: { root: env.NERVE_WEB_ROOT },
    shutdown: { timeoutMs: env.NERVE_SHUTDOWN_TIMEOUT_MS },
    log: { level: env.NERVE_LOG_LEVEL },
    password: {
      argon2: {
        memoryKib: env.NERVE_PASSWORD_ARGON2_MEMORY_KIB,
        iterations: env.NERVE_PASSWORD_ARGON2_ITERATIONS,
        parallelism: env.NERVE_PASSWORD_ARGON2_PARALLELISM,
      },
      hashConcurrency: env.NERVE_PASSWORD_HASH_CONCURRENCY,
    },
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value))
      deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

/**
 * 从给定的环境变量读取配置；不合法时抛出 ConfigError，一次列出全部问题。
 * 空字符串视为没有设置（编排文件里常见 `VAR=` 的写法）。
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readSecretFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): AppConfig {
  const issues: ConfigIssue[] = []
  /** 已经报告过问题的变量，校验时不再重复报告（例如文件读取失败的机密不再报"缺少"） */
  const reported = new Set<string>()
  /** 取自文件的机密 → 它的 _FILE 变量名：内容不合法时，问题记在运维实际设置的那个变量上 */
  const fromFile = new Map<string, string>()
  const input: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(PREFIX) && !name.startsWith(RESERVED_FOR_TESTS) && value !== undefined && value !== '')
      input[name] = value
  }

  for (const [name, path] of Object.entries(input)) {
    if (!name.endsWith(FILE_SUFFIX))
      continue
    delete input[name]
    const secret = name.slice(0, -FILE_SUFFIX.length)
    if (!SECRETS.has(secret)) {
      issues.push({ variable: name, problem: '不认识的变量（拼写错误？只有机密可以用 _FILE 从文件读取）' })
      continue
    }
    if (secret in input) {
      reported.add(secret)
      issues.push({ variable: secret, problem: `与 ${name} 只能设置一个` })
      continue
    }
    let content: string
    try {
      content = readSecretFile(path).replace(/\r?\n$/, '')
    }
    catch {
      reported.add(secret)
      issues.push({ variable: name, problem: '指定的文件读取失败' })
      continue
    }
    if (content === '') {
      reported.add(secret)
      issues.push({ variable: name, problem: '指定的文件是空的' })
      continue
    }
    input[secret] = content
    fromFile.set(secret, name)
  }

  for (const name of Object.keys(input)) {
    if (!(name in environmentSchema.shape))
      issues.push({ variable: name, problem: '不认识的变量（拼写错误？）' })
  }

  // 线程池的大小是 libuv 的变量，与别的变量是否合法无关，单独检查，一次列出全部问题（复验 S3）
  const threadpool = threadpoolOf(env[THREADPOOL_VARIABLE])
  if (threadpool === undefined)
    issues.push({ variable: THREADPOOL_VARIABLE, problem: THREADPOOL_PROBLEM })

  const result = environmentSchema.safeParse(input)
  if (!result.success) {
    for (const issue of result.error.issues) {
      const variable = String(issue.path[0] ?? '')
      const fileVariable = fromFile.get(variable)
      if (fileVariable !== undefined)
        issues.push({ variable: fileVariable, problem: `文件内容${issue.message}` })
      else if (!reported.has(variable))
        issues.push({ variable, problem: issue.message })
    }
  }
  else {
    const defaults = new Set(Object.keys(environmentSchema.shape).filter(name => !(name in input)))
    issues.push(...crossChecks(result.data, threadpool, defaults))
  }
  if (!result.success || issues.length > 0)
    throw new ConfigError(issues)
  return deepFreeze(toAppConfig(result.data))
}

/** 从进程的环境变量读取配置。 */
export function loadConfigFromEnvironment(): AppConfig {
  return loadConfig(process.env)
}

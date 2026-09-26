// 配置（规范 §7，P2 设计 §3.3）：全部来自环境变量，机密也可以用 <变量>_FILE 从文件读取。
// 启动时一次校验全部变量，不合法就列出变量名与原因（不含取值，取值可能是机密）后退出。
// api 里只有这个模块读取 process.env（lint 强制）。
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
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
    readonly host: string
    readonly port: number
    readonly jsonBodyLimitBytes: number
    readonly requestTimeoutMs: number
    readonly headersTimeoutMs: number
    readonly keepAliveTimeoutMs: number
    readonly trustProxy: TrustProxy
  }
  readonly shutdown: { readonly timeoutMs: number }
  readonly log: { readonly level: LogLevel }
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
  NERVE_HTTP_HOST: text().trim().min(1, '不能为空').default('0.0.0.0'),
  NERVE_HTTP_PORT: integer(0, 65_535).default(3_000),
  NERVE_HTTP_JSON_BODY_LIMIT_BYTES: integer(1_024, 16 * 1024 * 1024).default(262_144),
  NERVE_HTTP_REQUEST_TIMEOUT_MS: integer(1_000, 600_000).default(60_000),
  NERVE_HTTP_HEADERS_TIMEOUT_MS: integer(1_000, 600_000).default(20_000),
  NERVE_HTTP_KEEP_ALIVE_TIMEOUT_MS: integer(1_000, 600_000).default(5_000),
  NERVE_TRUST_PROXY: trustProxy.optional(),
  NERVE_SHUTDOWN_TIMEOUT_MS: integer(100, 600_000).default(8_000),
  NERVE_LOG_LEVEL: z.enum(LOG_LEVELS, { error: `必须是 ${LOG_LEVELS.join('、')} 之一` }).default('info'),
})

type Environment = z.output<typeof environmentSchema>

/** 变量之间的约束：只在每个变量各自合法之后检查，免得一个错误报两次。 */
function crossChecks(env: Environment): ConfigIssue[] {
  return env.NERVE_HTTP_HEADERS_TIMEOUT_MS > env.NERVE_HTTP_REQUEST_TIMEOUT_MS
    ? [{ variable: 'NERVE_HTTP_HEADERS_TIMEOUT_MS', problem: '不能大于 NERVE_HTTP_REQUEST_TIMEOUT_MS' }]
    : []
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
      host: env.NERVE_HTTP_HOST,
      port: env.NERVE_HTTP_PORT,
      jsonBodyLimitBytes: env.NERVE_HTTP_JSON_BODY_LIMIT_BYTES,
      requestTimeoutMs: env.NERVE_HTTP_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: env.NERVE_HTTP_HEADERS_TIMEOUT_MS,
      keepAliveTimeoutMs: env.NERVE_HTTP_KEEP_ALIVE_TIMEOUT_MS,
      trustProxy: env.NERVE_TRUST_PROXY ?? false,
    },
    shutdown: { timeoutMs: env.NERVE_SHUTDOWN_TIMEOUT_MS },
    log: { level: env.NERVE_LOG_LEVEL },
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
    issues.push(...crossChecks(result.data))
  }
  if (!result.success || issues.length > 0)
    throw new ConfigError(issues)
  return deepFreeze(toAppConfig(result.data))
}

/** 从进程的环境变量读取配置。 */
export function loadConfigFromEnvironment(): AppConfig {
  return loadConfig(process.env)
}

// 配置（规范 §7，P2 设计 §3.3）：全部来自环境变量，机密也可以用 <变量>_FILE 从文件读取。
// 启动时一次校验全部变量，不合法就列出变量名与原因（不含取值，取值可能是机密）后退出。
// api 里只有这个模块读取 process.env（lint 强制）。
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { LOCAL_DRAFT_RETENTION_DAYS, parseVersion } from '@nerve-office/contracts'
import { z } from 'zod'
import { Secret } from '../../shared/secret.ts'

/** 应用的变量都以它开头；不认识的视为拼写错误。 */
const PREFIX = 'NERVE_'
/** 留给测试工具的变量（例如集成测试的数据库地址）：应用不读取，也不当作拼写错误。 */
const RESERVED_FOR_TESTS = 'NERVE_TEST_'
const FILE_SUFFIX = '_FILE'
/** 本机密钥的主密钥（M3-P6 设计 §3.4）：只有应用进程要求它，迁移、初始化管理员与签发重置链接的命令都不需要 */
const MASTER_KEY_VARIABLE = 'NERVE_LOCAL_KEYS_MASTER_KEY'
/** 可以用 `<变量>_FILE` 从文件读取的机密。 */
const SECRETS: ReadonlySet<string> = new Set(['NERVE_DATABASE_URL', MASTER_KEY_VARIABLE])

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
    /** 按用户名与客户端地址的组合：窗口内允许失败的次数，达到后锁定这个组合（M2-P6 复核 A1：别人从他那里锁不住你） */
    readonly maxFailures: number
    /**
     * 只按用户名：窗口内允许失败的次数，比上面的宽得多，挡住从很多来源同时猜同一个账户；达到后这个账户在所有来源上都被锁定，
     * 系统管理员可以解除（M2-P6 复核 A1）
     */
    readonly accountMaxFailures: number
    /** 按客户端地址：窗口内允许失败的次数，达到后锁定 */
    readonly ipMaxFailures: number
    readonly windowMinutes: number
    readonly lockoutMinutes: number
  }
  readonly oneTimeLinks: {
    /**
     * 同一条链接"找到了但不能用"（过期、已用、已作废）的次数上限（M2-P6）：窗口与锁定时长沿用登录的。
     * 达到后这条链接一律 429、只记日志，不再写审计：拿着真实的旧链接反复打开，写不爆审计表
     */
    readonly recordMaxFailures: number
  }
  readonly web: {
    /** 前端构建目录的绝对路径；不设时不托管前端（开发时由 Vite 开发服务器提供，P3 设计 §3.8） */
    readonly root: string | undefined
  }
  readonly shutdown: { readonly timeoutMs: number }
  readonly log: { readonly level: LogLevel }
  readonly jobs: {
    /** 回收站里到期的删除单元的自动清理（M2-P4 设计 §3.4 第 6 条）：应用自己的定时器 */
    readonly trashPurge: {
      /** 关掉之后不再起定时器（应用照常提供回收站的人工操作），默认开启 */
      readonly enabled: boolean
      /** 两轮之间的间隔；实际触发时间带随机抖动 */
      readonly intervalMs: number
      /** 一轮最多清理多少个删除单元 */
      readonly batchSize: number
    }
    /** 修订记录与保存回执的保留期清理（M3-P3 设计 §3.9）：与回收站的清理同一个调度器 */
    readonly revisionPurge: {
      /** 关掉之后不再起定时器：过了保留期的修订记录与回执留着（不影响使用），重新打开之后下一轮一起清。默认开启 */
      readonly enabled: boolean
      /** 两轮之间的间隔；实际触发时间带随机抖动 */
      readonly intervalMs: number
      /** 一批最多删多少条（修订记录与回执各算）：每批一个短事务，一轮删到不满一批为止 */
      readonly batchSize: number
    }
  }
  /** 修订记录与保存回执（M3-P3 设计 §3.9） */
  readonly revisions: {
    /**
     * 保留多少天（每份文档当前修订的那一行一直保留）。保留期同时是保存、新建、复制、另存为副本的幂等窗口：这么多天之内
     * 重发同一个请求得到原来的结果，之后按新的请求处理。下限见 REVISION_RETENTION_MIN_DAYS
     */
    readonly retentionDays: number
  }
  readonly password: {
    /** Argon2id 的参数（00 号计划书 §11.1）：按部署机器的基准测试调整；改了之后，下次登录成功时重新哈希 */
    readonly argon2: { readonly memoryKib: number, readonly iterations: number, readonly parallelism: number }
    /**
     * 同时进行的哈希计算的上限。Argon2 在 libuv 的线程池里计算，线程池也负责读文件与解析域名：
     * 上限不超过线程池（UV_THREADPOOL_SIZE，默认 4）的一半；调大线程池时一并调大
     */
    readonly hashConcurrency: number
    /**
     * 等待哈希的排队（DEF-015）：排队的请求超过 maxWaiting，或者等待超过 maxWaitMs，立即返回 503，
     * 登录洪水下延迟与内存不再无限增长
     */
    readonly hashQueue: { readonly maxWaiting: number, readonly maxWaitMs: number }
  }
  /**
   * 页面（客户端）的版本（M3-P3 设计 §3.5，M3 总设计 §2.1 第 3 条）：数据格式不同的页面一律拦下（CLIENT_OUTDATED），
   * 另有这个运维开关——客户端有严重缺陷时，构建低于它的页面在保存、另存为副本、申请编辑权与心跳时都被拦下，提示刷新
   */
  readonly clients: {
    /** 最低的客户端构建（x.y.z）；不设时不按构建拦（只按数据格式）。改了要重启：严重缺陷本来就伴随一次修复发布 */
    readonly minimumBuild: string | undefined
    /** 本机草稿的部署开关：只影响页面新写入，已有草稿不会因关闭而删除 */
    readonly localDraftsEnabled: boolean
  }
  /**
   * 快照的检查（M3-P3 设计 §3.3，DEF-018）：保存与另存为副本的快照在子进程池里解析、检查与规范化，主进程的事件循环不被阻塞，
   * 子进程的内存超限不影响主进程
   */
  readonly snapshotInspection: {
    /**
     * 子进程数：同时检查的快照数的上限。子进程按需创建，空闲 60 秒之后退出；空闲时每个独占约 30 MiB，检查过一份 5 MiB 的
     * 真实快照之后约 120 MiB；最费的形状接近堆上限加 48 MiB 的新生代再加 Node 本身（DEF-018 的测量：堆上限 512 时约 600 MiB）
     */
    readonly processes: number
    /**
     * 等待检查的排队：排队的请求超过 maxWaiting，或者等待超过 maxWaitMs，立即返回 503（带 Retry-After）。
     * 排队的请求各自占着上传的正文（压缩前后各最多 5 MiB），所以排队的上限也是内存的上限
     */
    readonly queue: { readonly maxWaiting: number, readonly maxWaitMs: number }
    /** 一份快照的检查时限（子进程的加载另有同样的时限）：超时就结束那个子进程，这次返回 503 */
    readonly timeoutMs: number
    /** 每个子进程的堆上限（MiB，V8 的 --max-old-space-size）：超出时 V8 中止那个子进程，这份快照按"过于复杂"拒绝 */
    readonly heapMb: number
  }
}

/**
 * 应用进程（HTTP 服务）的配置：在 AppConfig 之上多出本机密钥的主密钥（M3-P6 设计 §3.4）。只有服务端的读法（loadServerConfig）给出它，
 * 缺失或格式不对时拒绝启动；命令行的读法（loadConfig）不要求它，给了也只校验格式、不带进配置——迁移、初始化管理员与签发重置链接的配置里
 * 没有主密钥，命令也不用它（最小权限，与 ADR-012"迁移用所有者、应用用应用角色"同一个思路）。这只管到配置这一层：按部署说明在应用容器里
 * 执行初始化管理员、签发重置链接时，进程的环境里仍有它（审查 A7）；迁移的容器没有它
 */
export type ServerConfig = AppConfig & {
  readonly localKeys: {
    /** 主密钥：32 字节随机数的标准 base64（openssl rand -base64 32 的输出）。只由 local-keys 模块在启动时派生包装键与标识 */
    readonly masterKey: Secret
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

/** 整数的范围；reason 是范围的理由，跟在说明后面（例如下限为什么是它） */
function integer(min: number, max: number, reason?: string) {
  const problem = `必须是 ${min}–${max} 之间的整数${reason === undefined ? '' : `：${reason}`}`
  return text()
    .regex(/^\d+$/, problem)
    .transform(Number)
    .pipe(z.number().int().min(min, problem).max(max, problem))
}

/** 开关：只认 true 与 false，不认 1/0、yes/on 之类的写法（写错时宁可拒绝启动，也不要静默当成关掉）。 */
function flag() {
  return text().pipe(z.enum(['true', 'false'], { error: '必须是 true 或 false' })).transform(value => value === 'true')
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

/** 最低客户端构建的写法：x.y.z（不带前导零的十进制，与 contracts 的版本比较同一个写法）；不带 + 之后的诊断信息（比较时本来就不看） */
const MINIMUM_BUILD_PROBLEM = '必须是 x.y.z 的版本号（例如 0.1.3：不带前导零，不带 + 之后的诊断信息）'
const minimumBuild = text().refine(value => !value.includes('+') && parseVersion(value) !== undefined, MINIMUM_BUILD_PROBLEM)

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

/**
 * 修订记录与回执的保留期的下限（M3-P3 设计 §3.9）：比本机发件箱一条记录的最长留存（契约的 LOCAL_DRAFT_RETENTION_DAYS，前端按它清理，
 * M4-P1 设计 §3.3）多一天。保留期是保存的幂等窗口——发件箱里一次结果未知的保存在第 14 天重发时，服务端要还找得到原来的修订记录
 * 或回执，才能把原来的结果交回（A07）；找不到时它按一次新的保存处理，基准修订号多半已经落后，得到修订号冲突，页面会误以为"没有保存"
 */
const REVISION_RETENTION_MIN_DAYS = LOCAL_DRAFT_RETENTION_DAYS + 1
const REVISION_RETENTION_REASON = `保留期要长于本机发件箱一条记录的最长留存（${LOCAL_DRAFT_RETENTION_DAYS} 天，M4），否则发件箱里结果未知的保存重发时找不到原来的结果、重放不了`

/**
 * 主密钥的写法（M3-P6 设计 §3.4）：标准 base64、带填充、恰好 32 字节、规范写法，即 openssl rand -base64 32 的输出（44 个字符，以一个 = 结尾）。
 * Buffer.from(…, 'base64') 极其宽松（夹杂非法字符、缺填充、base64url、首尾空白、31 字节都照样解出东西），所以校验三步：
 * 正则（前 42 个字符各带 6 位，第 43 个字符只有高 4 位是数据、低 2 位必须是 0）→ 解出恰好 32 字节 → 回编码等于原文。
 * 只认这一种写法（不认十六进制等）：配错时说明简单。说明里不带取值
 */
const MASTER_KEY_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
const MASTER_KEY_BYTES = 32
const MASTER_KEY_PROBLEM = '必须是 32 字节随机数的标准 base64（44 个字符、以 = 结尾，例如 openssl rand -base64 32 的输出）'

/**
 * 主密钥的字节（写法已经校验过）；调用方用完清零。这两处清零（isCanonicalMasterKey、isPrintableMasterKey）是尽力而为、不测（审查 A2）：
 * 取值本身是配置里的字符串，进程存活期间一直在 JS 堆上，清掉临时解出来的这份字节不改变暴露面；要从测试里看出来只能拦下全局的 Buffer.from。
 * 主密钥环（派生用的字节、解包的明文）与服务层（交出的、生成的原始密钥）的清零有单元测试钉住
 */
function masterKeyBytesOf(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

function isCanonicalMasterKey(value: string): boolean {
  if (!MASTER_KEY_PATTERN.test(value))
    return false
  const bytes = masterKeyBytesOf(value)
  try {
    return bytes.length === MASTER_KEY_BYTES && bytes.toString('base64') === value
  }
  finally {
    bytes.fill(0)
  }
}

const masterKey = text().refine(isCanonicalMasterKey, MASTER_KEY_PROBLEM)

/**
 * 主密钥的 32 个字节都是可打印的 ASCII（0x20–0x7E）：入库的开发与测试用的主密钥是可读的一句话（一眼看得出不是真的），
 * 随机的 32 字节全落在这个范围里的概率约 (95/256)^32 ≈ 1.7×10⁻¹⁴
 */
function isPrintableMasterKey(value: string): boolean {
  const bytes = masterKeyBytesOf(value)
  try {
    return bytes.every(byte => byte >= 0x20 && byte <= 0x7E)
  }
  finally {
    bytes.fill(0)
  }
}

const READABLE_MASTER_KEY_PROBLEM = '公开地址是 HTTPS（正式部署）时不能用全是可打印字符的主密钥：开发与测试用的主密钥是可读的一句话，'
  + '多半是被抄进了正式部署。用 openssl rand -base64 32 生成一把随机的（见部署说明）'

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
  // 登录限流（ADR-007）：按用户名与来源、只按用户名（宽得多，M2-P6 复核 A1）、按来源三个维度，共用窗口与锁定时长
  NERVE_LOGIN_MAX_FAILURES: integer(1, 100).default(5),
  NERVE_LOGIN_ACCOUNT_MAX_FAILURES: integer(2, 100_000).default(50),
  NERVE_LOGIN_IP_MAX_FAILURES: integer(1, 100_000).default(50),
  NERVE_LOGIN_WINDOW_MINUTES: integer(1, 1_440).default(15),
  NERVE_LOGIN_LOCKOUT_MINUTES: integer(1, 1_440).default(15),
  // 同一条一次性链接"找到了但不能用"的次数上限（M2-P6）：窗口与锁定时长沿用登录的
  NERVE_LINK_RECORD_MAX_FAILURES: integer(1, 1_000).default(10),
  NERVE_SHUTDOWN_TIMEOUT_MS: integer(100, 600_000).default(8_000),
  NERVE_LOG_LEVEL: z.enum(LOG_LEVELS, { error: `必须是 ${LOG_LEVELS.join('、')} 之一` }).default('info'),
  // 默认是 OWASP 的最低推荐（内存 19 MiB、迭代 2 次、并行度 1）；内存与迭代次数的乘积另有下限，见交叉检查
  NERVE_PASSWORD_ARGON2_MEMORY_KIB: integer(8_192, 1_048_576).default(19_456),
  NERVE_PASSWORD_ARGON2_ITERATIONS: integer(1, 20).default(2),
  NERVE_PASSWORD_ARGON2_PARALLELISM: integer(1, 16).default(1),
  NERVE_PASSWORD_HASH_CONCURRENCY: integer(1, 512).default(2),
  // 哈希的排队（DEF-015）：容器里的基准测试（默认参数）一次约 8 毫秒，按慢几倍的机器算，排满 64 个也在 1 秒以内等到
  NERVE_PASSWORD_HASH_QUEUE_MAX: integer(0, 100_000).default(64),
  NERVE_PASSWORD_HASH_QUEUE_TIMEOUT_MS: integer(100, 60_000).default(5_000),
  // 回收站的自动清理（M2-P4 设计 §3.4 第 6 条）：默认每小时一轮，一轮最多 50 个删除单元。
  // 间隔的下限是 1 秒（集成测试用小间隔跑真实的定时器），上限是一天
  NERVE_TRASH_PURGE_ENABLED: flag().default(true),
  NERVE_TRASH_PURGE_INTERVAL_MS: integer(1_000, 86_400_000).default(3_600_000),
  NERVE_TRASH_PURGE_BATCH: integer(1, 1_000).default(50),
  // 修订记录与回执的保留期（M3-P3 设计 §3.9）：默认 30 天，下限见 REVISION_RETENTION_MIN_DAYS，上限 10 年只是兜底（要一直留着就关掉清理）
  NERVE_REVISION_RETENTION_DAYS: integer(REVISION_RETENTION_MIN_DAYS, 3_650, REVISION_RETENTION_REASON).default(30),
  // 保留期的清理：与回收站的清理同一个调度器，默认每小时一轮；一批最多 1000 条（修订记录与回执各算），一轮删到不满一批为止。
  // 自动保存每 2–15 秒写一版（M3 总设计 US-M3-02）：一轮只删一批跟不上，所以一轮之内分批删完，每批一个短事务
  NERVE_REVISION_PURGE_ENABLED: flag().default(true),
  NERVE_REVISION_PURGE_INTERVAL_MS: integer(1_000, 86_400_000).default(3_600_000),
  NERVE_REVISION_PURGE_BATCH: integer(1, 10_000).default(1_000),
  // 最低客户端构建（M3-P3 设计 §3.5）：运维开关，不设时不按构建拦
  NERVE_MIN_CLIENT_BUILD: minimumBuild.optional(),
  NERVE_LOCAL_DRAFTS_ENABLED: flag().default(true),
  // 快照的检查（M3-P3 设计 §3.3，DEF-018）：默认 2 个子进程。数字的依据是 DEF-018 的测量（apps/api/scripts/measure-snapshot-inspection.ts）：
  // 5 MiB 以内最费的形状检查一份约 0.6 秒；子进程的堆（老生代）要 96 MiB 才检查得完 5 MiB 的真实形状，数量上限之内最费的形状要 256 MiB。
  // 堆超限时 V8 中止的只是那个子进程（这一份按"过于复杂"拒绝），服务照常：下限 128 保证真实形状的大表格不被误拒，
  // 默认 512 给数量上限之内最费的形状留两倍余量
  NERVE_SNAPSHOT_INSPECTION_PROCESSES: integer(1, 64).default(2),
  NERVE_SNAPSHOT_INSPECTION_QUEUE_MAX: integer(0, 1_000).default(8),
  NERVE_SNAPSHOT_INSPECTION_QUEUE_TIMEOUT_MS: integer(100, 600_000).default(10_000),
  NERVE_SNAPSHOT_INSPECTION_TIMEOUT_MS: integer(1_000, 600_000).default(10_000),
  NERVE_SNAPSHOT_INSPECTION_HEAP_MB: integer(128, 16_384).default(512),
  // 本机密钥的主密钥（M3-P6 设计 §3.4）：机密（可以用 _FILE）。这里可选、照常校验写法；只有服务端的读法要求它（缺失时报"缺少"）
  NERVE_LOCAL_KEYS_MASTER_KEY: masterKey.optional(),
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
 * 开启回收站的自动清理时连接池至少要有几个连接（M2-P6 复核 A 的 G-3）：清理的一轮用一个连接持着防重复执行的会话级锁
 * （ExclusiveRunner.run），每一项的删除在另一个连接的短事务里。只有一个连接时，第二个连接永远等不到，每一轮都失败。
 *
 * 修订记录与回执的保留期清理（M3-P3 设计 §3.9）不改变这个下限：它每一批是一个短事务，防重复执行的锁是这个事务里的事务级锁
 * （ExclusiveRunner.runTransaction），任何时刻只占一个连接，而且从不拿着一个连接去等另一个。两个清理同时在跑、连接池只有 2 时：
 * 回收站的清理持着一个、另一个由它每一项的事务与保留期清理的一批轮流用，各自很快归还，谁也不会一直等不到
 */
const TRASH_PURGE_MIN_POOL = 2

/**
 * 变量之间的约束：只在每个变量各自合法之后检查，免得一个错误报两次。
 * threadpool 是 libuv 线程池的大小，不合法时为 undefined（它自己的问题另外报出，这里不再比较）；
 * defaults 是没有设置、用了默认值的变量。
 */
function crossChecks(env: Environment, threadpool: Threadpool | undefined, defaults: ReadonlySet<string>, variableOf: (name: keyof Environment) => string): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const current = (variable: keyof Environment, value: number): string => `${value}${defaults.has(variable) ? '（默认值）' : ''}`
  // 只按用户名的上限要比按用户名与来源的上限大（M2-P6 复核 A1）：否则一个来源的失败就能把这个账户在所有来源上锁住
  if (env.NERVE_LOGIN_ACCOUNT_MAX_FAILURES <= env.NERVE_LOGIN_MAX_FAILURES) {
    issues.push({
      variable: 'NERVE_LOGIN_ACCOUNT_MAX_FAILURES',
      problem: `现在是 ${current('NERVE_LOGIN_ACCOUNT_MAX_FAILURES', env.NERVE_LOGIN_ACCOUNT_MAX_FAILURES)}，必须大于 NERVE_LOGIN_MAX_FAILURES`
        + `（现在是 ${current('NERVE_LOGIN_MAX_FAILURES', env.NERVE_LOGIN_MAX_FAILURES)}）：否则一个来源的失败就能把这个账户在所有来源上锁住`,
    })
  }
  if (env.NERVE_TRASH_PURGE_ENABLED && env.NERVE_DATABASE_POOL_MAX < TRASH_PURGE_MIN_POOL) {
    issues.push({
      variable: 'NERVE_DATABASE_POOL_MAX',
      problem: `现在是 ${current('NERVE_DATABASE_POOL_MAX', env.NERVE_DATABASE_POOL_MAX)}，开启回收站的自动清理时至少为 ${TRASH_PURGE_MIN_POOL}`
        + `（NERVE_TRASH_PURGE_ENABLED 现在是 true${defaults.has('NERVE_TRASH_PURGE_ENABLED') ? '（默认值）' : ''}）：`
        + `清理的一轮用一个连接持着防重复执行的锁，每一项的删除在另一个连接的事务里，只有一个连接时每一轮都会失败。`
        + `把它调到至少 ${TRASH_PURGE_MIN_POOL}，或者把 NERVE_TRASH_PURGE_ENABLED 设为 false（到期的东西改为人工永久删除）`,
    })
  }
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
    issues.push({
      variable: 'NERVE_PASSWORD_HASH_CONCURRENCY',
      problem: `现在是 ${current('NERVE_PASSWORD_HASH_CONCURRENCY', concurrency)}，不能超过 libuv 线程池的一半：`
        + `${THREADPOOL_VARIABLE} 现在是 ${threadpool.size}${threadpool.isDefault ? '（默认值）' : ''}，哈希最多 ${Math.floor(threadpool.size / 2)} 个（线程池也负责读文件与解析域名）。`
        + `把它调小，或者把 ${THREADPOOL_VARIABLE} 调到至少 ${concurrency * 2}`,
    })
  }
  // 公开地址是 HTTPS（真部署，只有本机调试才允许 HTTP）时拒绝可读的主密钥（M3-P6 设计 §3.4）：入库的开发、测试用密钥不会被抄进正式部署。
  // 写法与"只有本机调试才允许 HTTP 的公开地址"同一类规则；给了就查，命令行的读法同样（配置本身就是错的）
  const key = env.NERVE_LOCAL_KEYS_MASTER_KEY
  if (key !== undefined && env.NERVE_PUBLIC_ORIGIN.startsWith('https:') && isPrintableMasterKey(key))
    issues.push({ variable: variableOf('NERVE_LOCAL_KEYS_MASTER_KEY'), problem: READABLE_MASTER_KEY_PROBLEM })
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
      accountMaxFailures: env.NERVE_LOGIN_ACCOUNT_MAX_FAILURES,
      ipMaxFailures: env.NERVE_LOGIN_IP_MAX_FAILURES,
      windowMinutes: env.NERVE_LOGIN_WINDOW_MINUTES,
      lockoutMinutes: env.NERVE_LOGIN_LOCKOUT_MINUTES,
    },
    oneTimeLinks: { recordMaxFailures: env.NERVE_LINK_RECORD_MAX_FAILURES },
    web: { root: env.NERVE_WEB_ROOT },
    shutdown: { timeoutMs: env.NERVE_SHUTDOWN_TIMEOUT_MS },
    log: { level: env.NERVE_LOG_LEVEL },
    jobs: {
      trashPurge: {
        enabled: env.NERVE_TRASH_PURGE_ENABLED,
        intervalMs: env.NERVE_TRASH_PURGE_INTERVAL_MS,
        batchSize: env.NERVE_TRASH_PURGE_BATCH,
      },
      revisionPurge: {
        enabled: env.NERVE_REVISION_PURGE_ENABLED,
        intervalMs: env.NERVE_REVISION_PURGE_INTERVAL_MS,
        batchSize: env.NERVE_REVISION_PURGE_BATCH,
      },
    },
    revisions: { retentionDays: env.NERVE_REVISION_RETENTION_DAYS },
    password: {
      argon2: {
        memoryKib: env.NERVE_PASSWORD_ARGON2_MEMORY_KIB,
        iterations: env.NERVE_PASSWORD_ARGON2_ITERATIONS,
        parallelism: env.NERVE_PASSWORD_ARGON2_PARALLELISM,
      },
      hashConcurrency: env.NERVE_PASSWORD_HASH_CONCURRENCY,
      hashQueue: { maxWaiting: env.NERVE_PASSWORD_HASH_QUEUE_MAX, maxWaitMs: env.NERVE_PASSWORD_HASH_QUEUE_TIMEOUT_MS },
    },
    clients: { minimumBuild: env.NERVE_MIN_CLIENT_BUILD, localDraftsEnabled: env.NERVE_LOCAL_DRAFTS_ENABLED },
    snapshotInspection: {
      processes: env.NERVE_SNAPSHOT_INSPECTION_PROCESSES,
      queue: { maxWaiting: env.NERVE_SNAPSHOT_INSPECTION_QUEUE_MAX, maxWaitMs: env.NERVE_SNAPSHOT_INSPECTION_QUEUE_TIMEOUT_MS },
      timeoutMs: env.NERVE_SNAPSHOT_INSPECTION_TIMEOUT_MS,
      heapMb: env.NERVE_SNAPSHOT_INSPECTION_HEAP_MB,
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

/** 读配置的是哪一个进程：命令行（迁移、初始化管理员、签发重置链接）或应用（HTTP 服务，要求主密钥，M3-P6 设计 §3.4） */
type ConfigPurpose = 'command' | 'server'

type EnvironmentInput = Readonly<Record<string, string | undefined>>
type SecretFileReader = (path: string) => string

const readFileText: SecretFileReader = path => readFileSync(path, 'utf8')

/**
 * 读出并校验全部变量；不合法时抛出 ConfigError，一次列出全部问题。
 * 空字符串视为没有设置（编排文件里常见 `VAR=` 的写法）。服务端另要求主密钥：缺失时报"缺少"，与别的变量的问题一起列出
 * （它不依赖别的变量，不放在只在各变量都合法之后才查的 crossChecks 里）
 */
function parseEnvironment(env: EnvironmentInput, readSecretFile: SecretFileReader, purpose: ConfigPurpose): Environment {
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
  // 应用进程要求主密钥（M3-P6 设计 §3.4）：变量与 _FILE 都没设时"缺少"（_FILE 读不到、是空的已经报在 _FILE 上，不再重复）
  if (purpose === 'server' && !(MASTER_KEY_VARIABLE in input) && !reported.has(MASTER_KEY_VARIABLE))
    issues.push({ variable: MASTER_KEY_VARIABLE, problem: '缺少' })
  if (result.success) {
    const defaults = new Set(Object.keys(environmentSchema.shape).filter(name => !(name in input)))
    issues.push(...crossChecks(result.data, threadpool, defaults, name => fromFile.get(name) ?? name))
  }
  if (!result.success || issues.length > 0)
    throw new ConfigError(issues)
  return result.data
}

/**
 * 命令行（迁移、初始化管理员、签发重置链接）读配置：不要求主密钥（M3-P6 设计 §3.4），给了也只校验写法、不带进配置。
 * 不合法时抛出 ConfigError，一次列出全部问题（说明里只有变量名与原因，不含取值）
 */
export function loadConfig(env: EnvironmentInput, readSecretFile: SecretFileReader = readFileText): AppConfig {
  return deepFreeze(toAppConfig(parseEnvironment(env, readSecretFile, 'command')))
}

/**
 * 应用进程（HTTP 服务）读配置（M3-P6 设计 §3.4）：在命令行的基础上要求本机密钥的主密钥，缺失或写法不对时抛出 ConfigError
 * （进程入口记 fatal、退出码 1，说明里不带取值）
 */
export function loadServerConfig(env: EnvironmentInput, readSecretFile: SecretFileReader = readFileText): ServerConfig {
  const environment = parseEnvironment(env, readSecretFile, 'server')
  const masterKey = environment.NERVE_LOCAL_KEYS_MASTER_KEY
  // 走不到：缺失时 parseEnvironment 已经报了"缺少"
  if (masterKey === undefined)
    throw new Error('服务端的配置没有主密钥，却通过了校验')
  return deepFreeze({ ...toAppConfig(environment), localKeys: { masterKey: new Secret(masterKey) } })
}

/** 命令行从进程的环境变量读取配置。 */
export function loadConfigFromEnvironment(): AppConfig {
  return loadConfig(process.env)
}

/** 应用进程从进程的环境变量读取配置（要求主密钥）。 */
export function loadServerConfigFromEnvironment(): ServerConfig {
  return loadServerConfig(process.env)
}

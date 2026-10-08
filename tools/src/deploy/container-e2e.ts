// 容器 E2E（P5 设计 §3.6）里可以单独测试的部分：编排的参数与变量文件、交给 Playwright 的环境变量、
// 部署配置的核对（经代理的探针、客户端地址 DEF-014、应用的端口不发布；本机密钥的主密钥缺失与写法不对时拒绝启动、
// 日志里没有主密钥，M3-P6 设计 §3.9）、遗留编排项目的识别、docker 输出的解析、空闲内存的取样与中位数（ADR-001）。
// 执行的步骤在 container-e2e-cli.ts。
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

/** 测试环境的编排（相对仓库根目录） */
export const COMPOSE_FILE = 'deploy/test/compose.yaml'
/**
 * 编排项目名与镜像标签的前缀，后面接编排脚本的进程号：同时运行的两次互不影响（包括镜像的标签不被另一次覆盖），
 * 中断的运行留下的项目与镜像可以认出来
 */
export const PROJECT_PREFIX = 'nerve-office-e2e-'
export const IMAGE_PREFIX = 'nerve-office:e2e-'
/** 数据库管理员（官方镜像的 POSTGRES_USER）与测试环境的库名（deploy/sql/bootstrap-roles.sql 的调用方） */
const DATABASE_ADMIN = 'postgres'
const DATABASE_NAME = 'nerve_office'

export interface Passwords {
  readonly admin: string
  readonly owner: string
  readonly app: string
}

export interface ContainerE2eSettings {
  readonly project: string
  /** 编排文件与变量文件的绝对路径 */
  readonly composeFile: string
  readonly envFile: string
  readonly image: string
  readonly httpsPort: number
  readonly databasePort: number
  readonly passwords: Passwords
  /** 本机密钥的主密钥（M3-P6）：每次随机的 32 字节、标准 base64，与 openssl rand -base64 32 的输出同一个写法；只给应用容器 */
  readonly localKeysMasterKey: string
}

export interface SettingsInput {
  readonly pid: number
  readonly composeFile: string
  readonly envFile: string
  readonly httpsPort: number
  readonly databasePort: number
  /** 随机字节的来源（测试里替换） */
  readonly random?: (size: number) => Uint8Array
}

/** 密码只用十六进制字符：要拼进连接串，不需要转义 */
function password(random: (size: number) => Uint8Array): string {
  return Buffer.from(random(16)).toString('hex')
}

/** 本机密钥的主密钥的变量（应用容器的配置，M3-P6 设计 §3.4）与它的字节数 */
export const MASTER_KEY_VARIABLE = 'NERVE_LOCAL_KEYS_MASTER_KEY'
const MASTER_KEY_BYTES = 32

export function createSettings(input: SettingsInput): ContainerE2eSettings {
  const random = input.random ?? randomBytes
  return {
    project: `${PROJECT_PREFIX}${input.pid}`,
    composeFile: input.composeFile,
    envFile: input.envFile,
    image: `${IMAGE_PREFIX}${input.pid}`,
    httpsPort: input.httpsPort,
    databasePort: input.databasePort,
    passwords: { admin: password(random), owner: password(random), app: password(random) },
    localKeysMasterKey: Buffer.from(random(MASTER_KEY_BYTES)).toString('base64'),
  }
}

/** 编排的变量文件（deploy/test/.env.example 的各项）：按地址的登录失败上限调高，所有用例都来自本机 */
export function renderEnvFile(settings: ContainerE2eSettings): string {
  return [
    `NERVE_IMAGE=${settings.image}`,
    `NERVE_DB_ADMIN_PASSWORD=${settings.passwords.admin}`,
    `NERVE_DB_OWNER_PASSWORD=${settings.passwords.owner}`,
    `NERVE_DB_APP_PASSWORD=${settings.passwords.app}`,
    `${MASTER_KEY_VARIABLE}=${settings.localKeysMasterKey}`,
    `NERVE_TEST_HTTPS_PORT=${settings.httpsPort}`,
    `NERVE_TEST_DB_PORT=${settings.databasePort}`,
    'NERVE_LOG_LEVEL=info',
    'NERVE_LOGIN_IP_MAX_FAILURES=100000',
    '',
  ].join('\n')
}

/** docker compose 的参数：项目、编排文件与变量文件，后面接命令 */
export function composeArgs(settings: ContainerE2eSettings, ...command: readonly string[]): string[] {
  return ['compose', '-p', settings.project, '-f', settings.composeFile, '--env-file', settings.envFile, ...command]
}

/** 公开地址：与编排里 NERVE_PUBLIC_ORIGIN 的写法一致 */
export function publicOrigin(settings: ContainerE2eSettings): string {
  return `https://localhost:${settings.httpsPort}`
}

/** 测试写数据用管理员连接发布到本机的库：要看得到后端会话的等锁状态（pg_stat_activity） */
export function databaseUrl(settings: ContainerE2eSettings): string {
  return `postgres://${DATABASE_ADMIN}:${settings.passwords.admin}@127.0.0.1:${settings.databasePort}/${DATABASE_NAME}`
}

/**
 * 以外部模式运行 E2E 的环境变量（tests/e2e 的 playwright.config.ts、support/api-process.ts 与 support/external-setup.ts 读取）。
 * E2E_RUNNER_PID 是编排脚本的进程号：它被强制结束时，Playwright 据此自己停下（复验 SB2）
 */
export function playwrightEnvironment(settings: ContainerE2eSettings, browsers: readonly string[], runnerPid: number): Record<string, string> {
  return {
    E2E_BASE_URL: publicOrigin(settings),
    E2E_DATABASE_URL: databaseUrl(settings),
    E2E_BROWSERS: browsers.join(','),
    E2E_COMPOSE_PROJECT: settings.project,
    E2E_COMPOSE_FILE: settings.composeFile,
    E2E_COMPOSE_ENV_FILE: settings.envFile,
    E2E_RUNNER_PID: String(runnerPid),
  }
}

/** 中断的运行留下的编排项目或镜像：名字是前缀加编排脚本的进程号，进程已经不在了 */
export function staleRuns(names: readonly string[], prefix: string, isAlive: (pid: number) => boolean): string[] {
  return names.filter((name) => {
    const pid = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    return /^\d+$/.test(pid) && !isAlive(Number(pid))
  })
}

/**
 * 中断的运行（例如被 SIGKILL）留下的临时目录：名字是前缀、进程号、连字符与随机后缀（mkdtemp）。
 * 里面的变量文件有三个密码，下一次运行时删掉（审查 B6）
 */
export function staleTemporaryDirectories(names: readonly string[], isAlive: (pid: number) => boolean): string[] {
  return names.filter((name) => {
    const pid = name.startsWith(PROJECT_PREFIX) ? /^(\d+)-/.exec(name.slice(PROJECT_PREFIX.length))?.[1] : undefined
    return pid !== undefined && !isAlive(Number(pid))
  })
}

const SERVER_REQUEST_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

/**
 * 应用给一个请求生成的请求标识（UUID）：取自响应头 X-Request-Id，或者编排网络里那次请求打印出来的一行。
 * 审计的 request_id 就是它，客户端带来的 X-Request-Id 不进审计（M2-P6 复核 C2），所以核对地址时按它找审计记录。
 * 不是 UUID 时不认：它要拼进查审计的 SQL
 */
export function serverRequestId(value: string | readonly string[] | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : undefined
  return text !== undefined && SERVER_REQUEST_ID.test(text) ? text : undefined
}

/** psql -At -F '|' 的输出（每行"请求标识|地址"）→ 请求标识到地址 */
export function parseAuditAddresses(output: string): Map<string, string> {
  const addresses = new Map<string, string>()
  for (const line of output.split('\n')) {
    const [requestId, address] = line.trim().split('|')
    if (requestId !== undefined && requestId !== '' && address !== undefined && address !== '')
      addresses.set(requestId, address)
  }
  return addresses
}

/** 本机那次带着伪造的 X-Forwarded-For 登录失败时写的地址（文档用的保留地址段）：审计里不能出现它 */
export const FORGED_CLIENT_ADDRESS = '203.0.113.77'

export interface ObservedAddresses {
  /** 本机经发布的端口那次登录失败，审计记下的客户端地址 */
  readonly host: string | undefined
  /** 编排网络里另一个容器经站点 caddy 那次 */
  readonly network: string | undefined
  /** 本机带着伪造的 X-Forwarded-For（FORGED_CLIENT_ADDRESS）那次 */
  readonly forged: string | undefined
  /** Caddy 容器的地址 */
  readonly proxy: readonly string[]
}

/**
 * 客户端地址的核对（P5 设计 §3.5，DEF-014）：应用采信了代理转发的地址时，本机与编排网络里两次登录失败的地址不同，也都不是
 * Caddy 的地址；配错时（例如没设 NERVE_TRUST_PROXY）两次都是 Caddy 的地址。代理不能采信客户端自带的 X-Forwarded-For：
 * 带着伪造地址那次记下的仍是真实来源（审查 B5）。返回发现的问题，没有问题时为空。
 */
export function clientAddressProblems(observed: ObservedAddresses): string[] {
  const problems: string[] = []
  if (observed.host === undefined)
    problems.push('本机那次登录失败没有审计记录')
  if (observed.network === undefined)
    problems.push('编排网络里那次登录失败没有审计记录')
  if (observed.forged === undefined)
    problems.push('带着伪造的 X-Forwarded-For 那次登录失败没有审计记录')
  if (observed.host !== undefined && observed.host === observed.network)
    problems.push(`两次的客户端地址相同（${observed.host}）：应用没有区分出真实的来源`)
  for (const [source, address] of [['本机', observed.host], ['编排网络里', observed.network]] as const) {
    if (address !== undefined && observed.proxy.includes(address))
      problems.push(`${source}那次的客户端地址是 Caddy 的地址（${address}）：应用没有采信代理转发的地址（检查 NERVE_TRUST_PROXY）`)
  }
  if (observed.forged === FORGED_CLIENT_ADDRESS)
    problems.push(`审计记下了客户端自己写的 X-Forwarded-For（${FORGED_CLIENT_ADDRESS}）：代理采信了客户端带来的转发头，任何人都能冒充别的地址`)
  return problems
}

/**
 * docker compose port app 3000 的结果：有"主机:端口"说明应用的端口发布到了主机，代理之外的客户端能直连应用、伪造转发头。
 * 没有发布时 compose 输出 ":0"；命令本身失败（退出码不是 0）时查不出来，同样算问题（复验 RB4）
 */
export function publishedPortProblems(status: number | null, output: string): string[] {
  if (status !== 0)
    return [`查不到应用的端口有没有发布（docker compose port 的退出码 ${String(status)}）`]
  const published = output.split('\n').map(line => line.trim()).filter(line => /:[1-9]\d*$/.test(line))
  return published.length === 0 ? [] : [`应用的端口发布到了主机（${published.join('、')}）：只能让代理连到应用`]
}

/**
 * 随镜像分发的许可文件（00 号计划书 §3.3，ADR-012）：项目本身的许可、服务端与前端的第三方许可正文。
 * 许可门禁与产物门禁核对的是构建镜像之前的产物；镜像里是不是真有这几个文件、是不是空的，只有对镜像核对才知道
 * （清单说收集过正文不等于分发的文件还在，与 Codex 评审 CX9 同一个道理）
 */
export const DISTRIBUTED_LICENSE_FILES: readonly string[] = [
  '/app/licenses/LICENSE',
  '/app/licenses/THIRD-PARTY-LICENSES-server.md',
  '/app/web/THIRD-PARTY-LICENSES.md',
]

/** 在应用容器里量文件大小的脚本（node -e，文件作参数）：每行"路径<TAB>字节数"，不存在或读不到时字节数是 -1 */
export const FILE_SIZES_SCRIPT = 'for (const file of process.argv.slice(1)) { let size = -1; try { size = require("node:fs").statSync(file).size } catch {} console.log(file + "\\t" + size) }'

/** 量到的大小 → 问题：命令失败、缺了哪个文件、哪个是空的 */
export function distributedFileProblems(files: readonly string[], status: number | null, output: string): string[] {
  if (status !== 0)
    return [`量不了镜像里的许可文件（退出码 ${String(status)}）`]
  const sizes = new Map(output.split('\n').filter(line => line.includes('\t')).map((line) => {
    const [file = '', size = ''] = line.split('\t')
    return [file, Number(size)] as const
  }))
  return files.flatMap((file) => {
    const size = sizes.get(file)
    if (size === undefined || size < 0)
      return [`镜像里没有 ${file}`]
    return size === 0 ? [`镜像里的 ${file} 是空的`] : []
  })
}

/**
 * 经代理访问探针的期望（P5 设计 §3.4）：存活探针转发；就绪探针的说明里有迁移名，不对外。
 * 应用的路由不区分末尾斜杠与大小写，这几种写法都是就绪探针，代理都要屏蔽（审查 A1）
 */
export const PROXIED_PROBES: readonly { readonly path: string, readonly status: number }[] = [
  { path: '/api/health/live', status: 200 },
  { path: '/api/health/ready', status: 404 },
  { path: '/api/health/ready/', status: 404 },
  { path: '/api/HEALTH/READY', status: 404 },
]

export interface ProbeResponse {
  /** 连不上时是 0 */
  readonly status: number
  /** 响应头，名字小写 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/**
 * 经代理请求各个探针的响应 → 与期望不符的说明。Caddy 只在自己生成的响应（屏蔽就绪探针的 404）上加 Server，
 * 只在转发的响应（存活探针）上加 Via：核对这四个响应都不带这两个头，两种都覆盖到（复验 RB3、SB3）
 */
export function proxiedProbeProblems(responses: ReadonlyMap<string, ProbeResponse>): string[] {
  return PROXIED_PROBES.flatMap(({ path, status }) => {
    const response = responses.get(path)
    if (response === undefined || response.status === 0)
      return [`经代理请求 ${path} 没有响应，期望 ${status}`]
    const problems = response.status === status ? [] : [`经代理请求 ${path} 得到 ${response.status}，期望 ${status}`]
    for (const header of ['server', 'via']) {
      if (response.headers[header] !== undefined)
        problems.push(`经代理请求 ${path} 的响应带着 ${header} 头：不能暴露代理的软件`)
    }
    return problems
  })
}

/**
 * 主密钥缺失与写法不对时应用拒绝启动的核对（M3-P6 设计 §3.9）：用镜像默认的命令真的启动一次应用容器，等它退出的时限。
 * 配置不合法时进程一开始就退出（一两秒）；到时还在跑，就是缺了主密钥（或写法不对）照样启动了
 */
export const MASTER_KEY_REFUSAL_TIME_LIMIT_MS = 60_000

/** 拒绝启动的一次核对：交给应用容器的取值（覆盖变量文件里的那一把） */
export interface MasterKeyRefusalAttempt {
  readonly label: string
  /** 空串：配置把空值当作没有设，应当说"缺少" */
  readonly value: string
}

/**
 * 两次：缺主密钥（空值）；写法不对——31 字节的标准 base64（与正确的一样是 44 个字符，只是字节数不对），每次随机：
 * 输出里出现了它，就是应用把取值写进了日志或说明
 */
export function masterKeyRefusalAttempts(random: (size: number) => Uint8Array): MasterKeyRefusalAttempt[] {
  return [
    { label: '缺主密钥', value: '' },
    { label: '主密钥的写法不对', value: Buffer.from(random(MASTER_KEY_BYTES - 1)).toString('base64') },
  ]
}

/** 一次核对的结果：退出码（到时被强制结束、或者启动不了时是 null）、是不是到了时限还在跑、全部输出（标准输出与标准错误） */
export interface MasterKeyRefusalRun {
  readonly status: number | null
  readonly timedOut: boolean
  readonly output: string
}

/** 应用拒绝启动时记的那一条日志（apps/api 的进程入口：fatal、CONFIG_INVALID，只列变量名与原因） */
const configRefusalSchema = z.object({
  level: z.literal('fatal'),
  code: z.literal('CONFIG_INVALID'),
  issues: z.array(z.object({ variable: z.string(), problem: z.string() })),
})

/** 输出里各条拒绝启动的日志列出的、主密钥的原因；别的行（docker 自己的提示、别的日志、不是 JSON 的）跳过 */
function masterKeyIssues(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    }
    catch {
      return []
    }
    const refusal = configRefusalSchema.safeParse(entry)
    return refusal.success ? refusal.data.issues.filter(issue => issue.variable === MASTER_KEY_VARIABLE).map(issue => issue.problem) : []
  })
}

/**
 * 拒绝启动的一次核对 → 问题：到了时限还在跑、退出码是 0、输出里没有一条 fatal 的 CONFIG_INVALID 列出这个变量
 * （缺主密钥时原因是"缺少"；写法不对时不是"缺少"——取值到了应用、被认出写法不对）、开始监听了（"HTTP 服务已启动"）、
 * 输出里有给出的取值。没有问题时为空
 */
export function masterKeyRefusalProblems(attempt: MasterKeyRefusalAttempt, run: MasterKeyRefusalRun): string[] {
  const problems: string[] = []
  if (run.timedOut)
    problems.push(`${attempt.label}：${MASTER_KEY_REFUSAL_TIME_LIMIT_MS / 1000} 秒内应用没有退出，照样启动了`)
  else if (run.status === 0)
    problems.push(`${attempt.label}：应用的退出码是 0，期望拒绝启动`)
  const issues = masterKeyIssues(run.output)
  if (issues.length === 0)
    problems.push(`${attempt.label}：输出里没有一条 fatal 的 CONFIG_INVALID 列出 ${MASTER_KEY_VARIABLE}`)
  else if (attempt.value === '' && !issues.includes('缺少'))
    problems.push(`${attempt.label}：CONFIG_INVALID 里 ${MASTER_KEY_VARIABLE} 的原因不是"缺少"（${issues.join('；')}）`)
  else if (attempt.value !== '' && issues.includes('缺少'))
    problems.push(`${attempt.label}：CONFIG_INVALID 说 ${MASTER_KEY_VARIABLE} 缺少，给出的取值没有到应用`)
  if (run.output.includes('HTTP 服务已启动'))
    problems.push(`${attempt.label}：应用开始监听了（输出里有"HTTP 服务已启动"）`)
  if (attempt.value !== '' && run.output.includes(attempt.value))
    problems.push(`${attempt.label}：输出里有给出的取值`)
  return problems
}

/**
 * 日志里不能出现本机密钥的主密钥（00 号计划书 §11.5 日志与隐私，M3-P6 设计 §3.9）：收完各容器的日志之后扫一遍——
 * 标准 base64（变量里的写法）、base64url 与十六进制（解码之后的字节换一种写法写出来）。返回出现在哪些容器的日志里
 */
export function masterKeyLeakProblems(masterKey: string, logs: ReadonlyMap<string, string>): string[] {
  const bytes = Buffer.from(masterKey, 'base64')
  const forms = [masterKey, bytes.toString('base64url'), bytes.toString('hex')]
  return [...logs].flatMap(([service, text]) => (forms.some(form => text.includes(form)) ? [`${service} 的日志里出现了本机密钥的主密钥`] : []))
}

const MEMORY_UNITS: Readonly<Record<string, number>> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 }

/** docker stats 的内存用量（"45.2MiB / 7.66GiB"）→ 容器用了多少字节；读不出来时是 undefined */
export function memoryBytes(stats: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Z]+)\s*\//i.exec(stats)
  const unit = match?.[2] === undefined ? undefined : MEMORY_UNITS[match[2]]
  return match?.[1] === undefined || unit === undefined ? undefined : Number(match[1]) * unit
}

/** 字节数 → MiB，保留一位小数 */
export function mebibytes(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

/** E2E 期间取样应用容器内存的间隔（峰值取各次的最大值） */
export const MEMORY_SAMPLE_INTERVAL_MS = 2_000

export interface MemorySampling {
  /** 第一次取样之前等多久 */
  readonly settleMs: number
  /** 取几次 */
  readonly samples: number
  /** 两次之间隔多久 */
  readonly intervalMs: number
}

/**
 * 空闲内存的取样（ADR-001，M2-P6 第 6 片复核 M2）：原来部署核对之后紧接着取一次，同一份代码背靠背跑，空闲就有约 210 与约 244 MiB
 * 两档；核对里那三次登录失败各算一次 Argon2（每次约 19 MiB 的工作内存），疑点在这里。改为等一会儿再取几次、取中位数：
 * - 先等 10 秒：让核对里的请求结束、内存回落（V8 在分配停下来之后要过几秒才做缩堆的回收）；
 * - 取 5 次、两次之间隔 2 秒（与 E2E 期间取样的间隔相同，docker stats 每次自己还要一两秒）：中位数不受其中两次离群值的影响，
 *   各次的值一并打印，看得出是不是还在回落。合计不到半分钟，相对容器 E2E 的十分钟上下可以忽略
 */
export const IDLE_MEMORY_SAMPLING: MemorySampling = { settleMs: 10_000, samples: 5, intervalMs: MEMORY_SAMPLE_INTERVAL_MS }

/** 中位数：偶数个时取中间两个的平均；没有数时是 undefined */
export function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b)
  const upper = sorted[Math.floor(sorted.length / 2)]
  const lower = sorted.length % 2 === 1 ? upper : sorted[sorted.length / 2 - 1]
  return upper === undefined || lower === undefined ? undefined : (lower + upper) / 2
}

export interface MemorySampler {
  /** 取一次样（字节）；取不到时是 undefined */
  readonly sample: () => Promise<number | undefined>
  readonly wait: (ms: number) => Promise<void>
  /** 收到终止信号：不再等、不再取 */
  readonly stopped: () => boolean
}

/** 按 plan 取样：先等 settleMs，再取 samples 次、两次之间等 intervalMs；取不到的一次记为 undefined，停下时返回已经取到的 */
export async function sampleMemory(plan: MemorySampling, sampler: MemorySampler): Promise<(number | undefined)[]> {
  const samples: (number | undefined)[] = []
  while (samples.length < plan.samples && !sampler.stopped()) {
    await sampler.wait(samples.length === 0 ? plan.settleMs : plan.intervalMs)
    if (sampler.stopped())
      break
    samples.push(await sampler.sample())
  }
  return samples
}

/** 空闲内存的说明：取到的各次的中位数，后面列出各次的值（MiB）；一次也没取到时说明 */
export function describeIdleMemory(plan: MemorySampling, samples: readonly (number | undefined)[]): string {
  const taken = samples.filter(bytes => bytes !== undefined)
  const value = median(taken)
  if (value === undefined)
    return '（没有取到）'
  const each = samples.map(bytes => (bytes === undefined ? '没取到' : (bytes / 1024 ** 2).toFixed(1))).join('、')
  return `${mebibytes(value)}（部署核对之后等 ${plan.settleMs / 1000} 秒、每 ${plan.intervalMs / 1000} 秒取一次，${taken.length} 次的中位数；各次 ${each} MiB）`
}

/**
 * 量镜像体积：在一次性的容器里合计镜像里文件的表观大小（`du -sxb /`，解压之后），与镜像存储无关。
 * docker 自己的数字随镜像存储而变（M1 收尾时实测）：overlay2（CI）的 `docker image ls` 是各层的合计，含后面的层删掉、
 * 仍存在下面层里的文件；containerd 的镜像存储（Docker Desktop）里 `docker image ls` 把压缩的内容与解压之后的一起算，
 * 非本机平台的镜像没解压时只有压缩的部分，inspect 的 Size 是压缩之后的
 */
export function imageSizeArgs(image: string): string[] {
  return ['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'du', image, '-sxb', '/']
}

/** `du -sxb /` 的输出（"285717915\t/"）→ 字节数；读不出来时是 undefined */
export function duBytes(output: string): number | undefined {
  const match = /^(\d+)\s+\/$/.exec(output.trim())
  const bytes = match?.[1] === undefined ? undefined : Number(match[1])
  return bytes !== undefined && Number.isSafeInteger(bytes) ? bytes : undefined
}

/** 字节数 → MB（与 docker 的写法一致，1 MB = 10^6 字节），保留一位小数 */
export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

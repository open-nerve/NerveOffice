// 容器 E2E（P5 设计 §3.6）里可以单独测试的部分：编排的参数与变量文件、交给 Playwright 的环境变量、
// 两个客户端地址的核对（DEF-014）、遗留编排项目的识别、docker 输出的解析。执行的步骤在 container-e2e-cli.ts。
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

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
  }
}

/** 编排的变量文件（deploy/test/.env.example 的各项）：按地址的登录失败上限调高，所有用例都来自本机 */
export function renderEnvFile(settings: ContainerE2eSettings): string {
  return [
    `NERVE_IMAGE=${settings.image}`,
    `NERVE_DB_ADMIN_PASSWORD=${settings.passwords.admin}`,
    `NERVE_DB_OWNER_PASSWORD=${settings.passwords.owner}`,
    `NERVE_DB_APP_PASSWORD=${settings.passwords.app}`,
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

/** 以外部模式运行 E2E 的环境变量（tests/e2e 的 playwright.config.ts 与 support/api-process.ts 读取） */
export function playwrightEnvironment(settings: ContainerE2eSettings, browsers: readonly string[]): Record<string, string> {
  return {
    E2E_BASE_URL: publicOrigin(settings),
    E2E_DATABASE_URL: databaseUrl(settings),
    E2E_BROWSERS: browsers.join(','),
    E2E_COMPOSE_PROJECT: settings.project,
    E2E_COMPOSE_FILE: settings.composeFile,
    E2E_COMPOSE_ENV_FILE: settings.envFile,
  }
}

/** 中断的运行留下的编排项目或镜像：名字是前缀加编排脚本的进程号，进程已经不在了 */
export function staleRuns(names: readonly string[], prefix: string, isAlive: (pid: number) => boolean): string[] {
  return names.filter((name) => {
    const pid = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    return /^\d+$/.test(pid) && !isAlive(Number(pid))
  })
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

export interface ObservedAddresses {
  /** 本机经发布的端口那次登录失败，审计记下的客户端地址 */
  readonly host: string | undefined
  /** 编排网络里另一个容器经站点 caddy 那次 */
  readonly network: string | undefined
  /** Caddy 容器的地址 */
  readonly proxy: readonly string[]
}

/**
 * 两个客户端地址的核对（P5 设计 §3.5，DEF-014）：应用采信了代理转发的地址时，两次登录失败的地址不同，也都不是 Caddy 的地址；
 * 配错时（例如没设 NERVE_TRUST_PROXY）两次都是 Caddy 的地址。返回发现的问题，没有问题时为空。
 */
export function clientAddressProblems(observed: ObservedAddresses): string[] {
  const problems: string[] = []
  if (observed.host === undefined)
    problems.push('本机那次登录失败没有审计记录')
  if (observed.network === undefined)
    problems.push('编排网络里那次登录失败没有审计记录')
  if (observed.host !== undefined && observed.host === observed.network)
    problems.push(`两次的客户端地址相同（${observed.host}）：应用没有区分出真实的来源`)
  for (const [source, address] of [['本机', observed.host], ['编排网络里', observed.network]] as const) {
    if (address !== undefined && observed.proxy.includes(address))
      problems.push(`${source}那次的客户端地址是 Caddy 的地址（${address}）：应用没有采信代理转发的地址（检查 NERVE_TRUST_PROXY）`)
  }
  return problems
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

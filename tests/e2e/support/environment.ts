// E2E 的运行环境（P3 设计 §3.10）：地址、管理员账户、数据库。Playwright 的配置、服务脚本与测试共用。
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { hostname } from 'node:os'
import process from 'node:process'

/** 服务脚本用初始化命令创建的管理员（US-M1-01 的 E2E 用它登录）。只存在于本次运行的测试库里 */
export const E2E_ADMIN = { username: 'e2e-admin', displayName: 'E2E 管理员', password: 'e2e admin password 2026' } as const

/**
 * 本机 E2E 的本机密钥的主密钥（M3-P6 设计 §3.4）：固定的、可读的测试密钥（base64 解出来是 nerve-office-e2e-only-master-key；
 * 公开地址是 HTTPS 时应用拒绝这种密钥，容器 E2E 每次随机生成）。重启用例（SIGUSR2 按原来的参数重启）沿用同一把，重启之后取到的是同一把。
 * 只给后端进程（serve.ts）：迁移与初始化管理员的命令不需要它
 */
export const E2E_LOCAL_KEYS_MASTER_KEY = 'bmVydmUtb2ZmaWNlLWUyZS1vbmx5LW1hc3Rlci1rZXk='

/**
 * 本机挑一个空闲端口（由操作系统分配）。只在 Playwright 的主进程里调用一次，结果经环境变量 E2E_PORT 交给工作进程与服务脚本：
 * 工作进程也会加载配置，各挑各的就对不上了。固定端口在多个 worktree 同时跑 E2E 时会互相占用，
 * 甚至把别人的服务当成自己的（审查 B9）。
 */
export async function pickFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** 本次运行的服务端口（见 pickFreePort）。 */
export function e2ePort(): number {
  const port = Number(process.env.E2E_PORT)
  if (!Number.isInteger(port) || port <= 0)
    throw new Error('没有 E2E_PORT：请经 playwright test 运行（配置里会设定它）')
  return port
}

/**
 * 被测站点的源：与后端的 NERVE_PUBLIC_ORIGIN 相同，状态变更的请求要带这个 Origin。
 * 设置了 E2E_BASE_URL 时测外部的环境（P5 的容器化部署），用它的源。
 */
export function e2eOrigin(): string {
  const external = process.env.E2E_BASE_URL
  return external === undefined ? `http://127.0.0.1:${e2ePort()}` : new URL(external).origin
}

/** 本机开发数据库（deploy/dev/compose.yaml）；CI 用环境变量指向服务容器（与集成测试相同）。建库、删库经它执行 */
const LOCAL_MAINTENANCE_URL = 'postgres://nerve:nerve_dev_only@127.0.0.1:54318/nerve_office'
export const E2E_DATABASE_PREFIX = 'nerve_e2e_'

/**
 * 这台主机的标识：主机名的短哈希（8 个小写十六进制字符）。测试库的名字带上它（e2eDatabaseName），服务脚本启动时只清理本主机建的、
 * 按本主机的进程号判断这次运行还在不在（abandonedDatabases）。不带它时，别的主机（Docker 容器、别的机器）连同一个库服务器，
 * 它们的进程号在本主机上看不到，会把对方正在用的库当成遗留删掉（M4-P1 S7：容器里的运行与宿主机上的运行互相删了对方的库）。
 * 容器的主机名是容器的 id，每个容器各不相同
 */
export function hostTag(name: string = hostname()): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/** 本次运行的测试库名：前缀、主机的标识与进程号（Playwright 的主进程，或页面自检的驱动脚本）。只有小写字母、数字与下划线 */
export function e2eDatabaseName(pid: number, tag: string = hostTag()): string {
  return `${E2E_DATABASE_PREFIX}${tag}_${pid}`
}

/** 测试库名的形状（前缀里只有小写字母与下划线，直接拼进正则） */
const E2E_DATABASE_NAME = new RegExp(`^${E2E_DATABASE_PREFIX}([0-9a-f]{8})_(\\d+)$`)

/**
 * 遗留的测试库：本主机建的（主机的标识相同）、进程已经不在的。别的主机建的、认不出主机的（改名之前的旧写法 nerve_e2e_<进程号>、
 * 形状不对的）一律不动；isAlive 只问本主机的进程号
 */
export function abandonedDatabases(names: readonly string[], tag: string, isAlive: (pid: number) => boolean): string[] {
  return names.filter((name) => {
    const match = E2E_DATABASE_NAME.exec(name)
    return match !== null && match[1] === tag && !isAlive(Number(match[2]))
  })
}

export function maintenanceDatabaseUrl(): string {
  return process.env.NERVE_TEST_DATABASE_URL ?? LOCAL_MAINTENANCE_URL
}

export function databaseUrl(name: string): string {
  const url = new URL(maintenanceDatabaseUrl())
  url.pathname = `/${name}`
  return url.toString()
}

/** 本次运行的测试库：Playwright 的配置按主机的标识与主进程的进程号设定（e2eDatabaseName），工作进程与服务脚本继承。 */
export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL
  if (url === undefined)
    throw new Error('没有 E2E_DATABASE_URL：请经 playwright test 运行（配置里会设定它）')
  return url
}

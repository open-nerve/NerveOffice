// E2E 的运行环境（P3 设计 §3.10）：地址、管理员账户、数据库。Playwright 的配置、服务脚本与测试共用。
import process from 'node:process'

export const E2E_PORT = 4174
/** 与后端的 NERVE_PUBLIC_ORIGIN 相同：状态变更的请求要带这个 Origin */
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`

/** 服务脚本用初始化命令创建的管理员（US-M1-01 的 E2E 用它登录）。只存在于本次运行的测试库里 */
export const E2E_ADMIN = { username: 'e2e-admin', displayName: 'E2E 管理员', password: 'e2e admin password 2026' } as const

/** 本机开发数据库（deploy/dev/compose.yaml）；CI 用环境变量指向服务容器（与集成测试相同）。建库、删库经它执行 */
const LOCAL_MAINTENANCE_URL = 'postgres://nerve:nerve_dev_only@127.0.0.1:54318/nerve_office'
export const E2E_DATABASE_PREFIX = 'nerve_e2e_'

export function maintenanceDatabaseUrl(): string {
  return process.env.NERVE_TEST_DATABASE_URL ?? LOCAL_MAINTENANCE_URL
}

export function databaseUrl(name: string): string {
  const url = new URL(maintenanceDatabaseUrl())
  url.pathname = `/${name}`
  return url.toString()
}

/** 本次运行的测试库：Playwright 的配置按主进程的进程号设定，工作进程与服务脚本继承。 */
export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL
  if (url === undefined)
    throw new Error('没有 E2E_DATABASE_URL：请经 playwright test 运行（配置里会设定它）')
  return url
}

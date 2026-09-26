// E2E 的服务（P3 设计 §3.10）：由 Playwright 的 webServer 启动（node support/serve.ts）。
// 1. 建一个本次运行专用的数据库（名称带 Playwright 主进程的进程号），先清理进程已经不在的遗留库；
// 2. 执行迁移命令；3. 用初始化命令创建管理员（密码经标准输入）；
// 4. 启动构建好的后端，托管测试构建（apps/web/dist-e2e）；5. 收到退出信号时停止后端并删除数据库。
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { E2E_ADMIN, E2E_DATABASE_PREFIX, E2E_ORIGIN, E2E_PORT, e2eDatabaseUrl, maintenanceDatabaseUrl } from './environment.ts'

const API_DIST = fileURLToPath(new URL('../../../apps/api/dist', import.meta.url))
const WEB_ROOT = fileURLToPath(new URL('../../../apps/web/dist-e2e', import.meta.url))

async function withMaintenance<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: maintenanceDatabaseUrl(), connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    return await fn(client)
  }
  finally {
    await client.end()
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 名称校验后才拼进 DDL：数据库名不能用参数 */
function quoted(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name))
    throw new Error(`数据库名不合法：${name}`)
  return `"${name}"`
}

async function dropAbandonedDatabases(): Promise<void> {
  await withMaintenance(async (client) => {
    const { rows } = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${E2E_DATABASE_PREFIX}%`])
    for (const { datname } of rows) {
      const pid = Number(datname.slice(E2E_DATABASE_PREFIX.length))
      if (Number.isInteger(pid) && !isAlive(pid))
        await client.query(`DROP DATABASE IF EXISTS ${quoted(datname)} WITH (FORCE)`)
    }
  })
}

async function recreateDatabase(name: string): Promise<void> {
  await withMaintenance(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`)
    await client.query(`CREATE DATABASE ${quoted(name)}`)
  })
}

async function dropDatabase(name: string): Promise<void> {
  await withMaintenance(async client => client.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`))
}

function runCommand(script: string, args: readonly string[], env: NodeJS.ProcessEnv, stdin?: string): void {
  const result = spawnSync(process.execPath, [script, ...args], { env, input: stdin, stdio: ['pipe', 'inherit', 'inherit'] })
  if (result.status !== 0)
    throw new Error(`${script} ${args.join(' ')} 失败（退出码 ${String(result.status)}）`)
}

async function main(): Promise<void> {
  for (const path of [`${API_DIST}/app/main.js`, `${WEB_ROOT}/index.html`]) {
    if (!existsSync(path))
      throw new Error(`找不到 ${path}：先构建后端与测试构建（pnpm test:e2e 会自动构建）`)
  }
  const databaseUrl = e2eDatabaseUrl()
  const databaseName = new URL(databaseUrl).pathname.slice(1)
  await dropAbandonedDatabases()
  await recreateDatabase(databaseName)

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NERVE_DATABASE_URL: databaseUrl,
    NERVE_PUBLIC_ORIGIN: E2E_ORIGIN,
    NERVE_HTTP_HOST: '127.0.0.1',
    NERVE_HTTP_PORT: String(E2E_PORT),
    NERVE_WEB_ROOT: WEB_ROOT,
    NERVE_LOG_LEVEL: 'warn',
    // 所有测试都来自本机：按地址的限流调高，免得互相影响；按用户名的限流照常测（集成测试覆盖按地址的限流）
    NERVE_LOGIN_IP_MAX_FAILURES: '100000',
  }
  runCommand(`${API_DIST}/cli/migrate.js`, [], env)
  runCommand(`${API_DIST}/cli/init-admin.js`, ['--username', E2E_ADMIN.username, '--display-name', E2E_ADMIN.displayName, '--password-stdin'], env, E2E_ADMIN.password)

  const server: ChildProcess = spawn(process.execPath, [`${API_DIST}/app/main.js`], { env, stdio: 'inherit' })
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping)
      return
    stopping = true
    server.kill('SIGTERM')
    await new Promise(resolve => server.once('exit', resolve))
    await dropDatabase(databaseName)
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  server.once('exit', (code) => {
    if (!stopping)
      void dropDatabase(databaseName).finally(() => process.exit(code ?? 1))
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`E2E 的服务启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})

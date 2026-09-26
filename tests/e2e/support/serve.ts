// E2E 的服务（P3 设计 §3.10）：由 Playwright 的 webServer 启动（node support/serve.ts）。
// 1. 建一个本次运行专用的数据库（名称带 Playwright 主进程的进程号），先清理进程已经不在的遗留库；
// 2. 执行迁移命令；3. 用初始化命令创建管理员（密码经标准输入）；
// 4. 启动构建好的后端，托管测试构建（apps/web/dist-e2e）；5. 停止时先停后端，再删除数据库。
//
// 什么时候停止（审查 B8，退出时的双重 SIGTERM）：
// - 收到 SIGTERM、SIGINT：Playwright 的优雅关闭向本脚本的整个进程组发信号，单独给本脚本发信号也一样处理；
// - 标准输入被关闭：Playwright 以管道接本脚本的标准输入，它的主进程被强制结束（kill -9）时管道随之关闭，本脚本不会收到任何信号；
// - 后端意外退出：删库后以后端的退出码退出，Playwright 随之报告服务失败。
// 后端单独一个进程组，只由本脚本给它发一次 SIGTERM：同在一个组时，它会先收到 Playwright 发给整个组的信号，
// 再收到本脚本转发的一次，第二次让它放弃优雅退出、以退出码 1 立即退出（有请求在途时可以复现）。
// 本脚本自己被强制结束时，后端经 exit-with-parent.ts 发现自己的标准输入被关闭，自行优雅退出；遗留的库下次启动时清理。
//
// 日志（审查 B23）：迁移、初始化与后端的输出写进 test-results/e2e-server.log（CI 随测试结果一起上传），
// 不逐行刷在测试输出里；本脚本自己的说明（日志的位置、后端的退出码、启动失败时日志的末尾）写到标准错误。
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { E2E_ADMIN, E2E_DATABASE_PREFIX, e2eDatabaseUrl, e2eOrigin, e2ePort, maintenanceDatabaseUrl } from './environment.ts'

const API_DIST = fileURLToPath(new URL('../../../apps/api/dist', import.meta.url))
const WEB_ROOT = fileURLToPath(new URL('../../../apps/web/dist-e2e', import.meta.url))
const EXIT_WITH_PARENT = pathToFileURL(fileURLToPath(new URL('./exit-with-parent.ts', import.meta.url))).href
/** Playwright 在启动服务之前清空 test-results，所以日志写在这里不会被删；CI 上传这个目录 */
const LOG_FILE = fileURLToPath(new URL('../test-results/e2e-server.log', import.meta.url))
/** 启动失败时打出来的日志行数 */
const LOG_TAIL_LINES = 40

// Playwright 的主进程被强制结束之后，标准错误的另一端没人读了：写入会报 EPIPE。
// 这些说明只是给人看的，丢掉就好；不能让它变成未捕获的异常，打断停止后端与删库（复验 R2）
process.stderr.on('error', () => {})

function report(message: string): void {
  try {
    process.stderr.write(`E2E 的服务：${message}\n`)
  }
  catch {
    // 同上：没人读了
  }
}

function reportLogTail(): void {
  const lines = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES)
  report(`日志的最后 ${lines.length} 行（全文见 ${LOG_FILE}）：\n${lines.join('\n')}`)
}

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

async function main(): Promise<void> {
  for (const path of [`${API_DIST}/app/main.js`, `${WEB_ROOT}/index.html`]) {
    if (!existsSync(path))
      throw new Error(`找不到 ${path}：先构建后端与测试构建（pnpm test:e2e 会自动构建）`)
  }
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  const log = openSync(LOG_FILE, 'a')
  report(`后端的日志写在 ${LOG_FILE}`)

  const databaseUrl = e2eDatabaseUrl()
  const databaseName = new URL(databaseUrl).pathname.slice(1)
  let api: ChildProcess | undefined
  let stopping = false

  /** 停止后端（如果已经启动）并删库，然后退出。只执行一次。 */
  const stop = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping)
      return
    stopping = true
    report(`${reason}，停止后端并删除测试库`)
    let code = exitCode
    if (api !== undefined && api.exitCode === null && api.signalCode === null) {
      const exited = new Promise<number | null>(resolve => api?.once('exit', resolve))
      api.kill('SIGTERM')
      const apiCode = await exited
      report(`后端已退出，退出码 ${String(apiCode)}`)
      if (apiCode !== 0)
        code = 1
    }
    await dropDatabase(databaseName).catch((error: unknown) => report(`删除测试库失败：${String(error)}`))
    closeSync(log)
    process.exit(code)
  }
  process.on('SIGTERM', () => void stop('收到 SIGTERM'))
  process.on('SIGINT', () => void stop('收到 SIGINT'))
  // 启动期间也要能停：事件在各步之间的 await 处理，每步之后检查
  process.stdin.once('end', () => void stop('标准输入已关闭（Playwright 的主进程已经退出）'))
  process.stdin.resume()

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NERVE_DATABASE_URL: databaseUrl,
    NERVE_PUBLIC_ORIGIN: e2eOrigin(),
    NERVE_HTTP_HOST: '127.0.0.1',
    NERVE_HTTP_PORT: String(e2ePort()),
    NERVE_WEB_ROOT: WEB_ROOT,
    // 写进日志文件：照常记录每个请求（info），失败排查时看得到 4xx 的原因
    NERVE_LOG_LEVEL: 'info',
    // 所有测试都来自本机：按地址的限流调高，免得互相影响；按用户名的限流照常测（集成测试覆盖按地址的限流）
    NERVE_LOGIN_IP_MAX_FAILURES: '100000',
  }
  const runCommand = (script: string, args: readonly string[], stdin = ''): void => {
    const result = spawnSync(process.execPath, [script, ...args], { env, input: stdin, stdio: ['pipe', log, log] })
    if (result.status !== 0) {
      reportLogTail()
      throw new Error(`${script} ${args.join(' ')} 失败（退出码 ${String(result.status)}）`)
    }
  }
  try {
    await dropAbandonedDatabases()
    await recreateDatabase(databaseName)
    if (stopping)
      return
    runCommand(`${API_DIST}/cli/migrate.js`, [])
    runCommand(`${API_DIST}/cli/init-admin.js`, ['--username', E2E_ADMIN.username, '--display-name', E2E_ADMIN.displayName, '--password-stdin'], E2E_ADMIN.password)
  }
  catch (error) {
    report(`启动失败：${error instanceof Error ? error.message : String(error)}`)
    await stop('启动失败', 1)
    return
  }
  if (stopping)
    return

  api = spawn(process.execPath, ['--import', EXIT_WITH_PARENT, `${API_DIST}/app/main.js`], { env, stdio: ['pipe', log, log], detached: true })
  api.once('exit', (code, signal) => {
    if (stopping)
      return
    reportLogTail()
    void stop(`后端意外退出（退出码 ${String(code)}，信号 ${String(signal)}）`, code ?? 1)
  })
  report(`后端已启动：${e2eOrigin()}`)
}

main().catch((error: unknown) => {
  report(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})

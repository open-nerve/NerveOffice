import type { AddressInfo } from 'node:net'
// 容器 E2E（P5 设计 §3.6、§3.8；pnpm test:e2e:container）：用生产镜像起一套测试环境（deploy/test），对它跑 E2E 的外部模式。
// 用法：node tools/src/deploy/container-e2e-cli.ts [--browsers chromium,webkit] [-- <交给 Playwright 的参数>]
// 1. 构建镜像；随机生成三个密码，挑两个空闲端口，变量文件写在临时目录；
// 2. 清理中断的运行留下的编排项目；起 db、migrate、app、caddy（compose 按依赖的条件依次等待）；等经 Caddy 的存活探针通过；
// 3. 两个客户端地址的核对（DEF-014）；
// 4. 以外部模式运行 E2E（E2E 的管理员由 Playwright 的全局准备经编排初始化，tests/e2e/support/external-setup.ts）；
// 5. 打印镜像体积与应用容器的内存（空闲、跑完 E2E 之后，ADR-001）；
// 6. 无论成败，把各容器的日志收集到 tests/e2e/test-results/container/，然后 down -v、删除临时目录。
import type { ContainerE2eSettings } from './container-e2e.ts'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'
import {
  clientAddressProblems,
  COMPOSE_FILE,
  composeArgs,
  createSettings,
  E2E_IMAGE,
  memoryUsage,
  parseAuditAddresses,
  playwrightEnvironment,
  publicOrigin,
  renderEnvFile,
  staleProjects,
} from './container-e2e.ts'

const LOG_DIR = join(REPO_ROOT, 'tests/e2e/test-results/container')
const SERVICES = ['db', 'migrate', 'app', 'caddy'] as const
/** 等经 Caddy 的存活探针通过的时限 */
const LIVE_TIMEOUT_MS = 120_000

let interrupted = false
process.on('SIGINT', () => {
  interrupted = true
})
process.on('SIGTERM', () => {
  interrupted = true
})

function log(message: string): void {
  console.log(`容器 E2E：${message}`)
}

function usage(): never {
  console.error('用法：node tools/src/deploy/container-e2e-cli.ts [--browsers chromium,webkit] [-- <交给 Playwright 的参数>]')
  process.exit(2)
}

function parseArgs(argv: readonly string[]): { browsers: string[], playwrightArgs: string[] } {
  const separator = argv.indexOf('--')
  const own = separator < 0 ? argv : argv.slice(0, separator)
  const playwrightArgs = separator < 0 ? [] : argv.slice(separator + 1)
  if (own.length === 0)
    return { browsers: ['chromium'], playwrightArgs }
  if (own.length !== 2 || own[0] !== '--browsers' || own[1] === undefined || own[1] === '')
    usage()
  return { browsers: own[1].split(','), playwrightArgs }
}

interface Result {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** 执行命令，输出收集起来 */
function capture(command: string, args: readonly string[], input?: string): Result {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 执行命令，输出直接显示；返回退出码 */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  return spawnSync(command, args, { cwd: REPO_ROOT, env, stdio: 'inherit' }).status ?? 1
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
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

/** 经 HTTPS 发一个请求，返回状态码；连不上时是 0。测试环境的证书来自 Caddy 自带的 CA，不校验 */
async function httpsStatus(url: string, options: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<number> {
  return new Promise((resolve) => {
    const request = https.request(url, { method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: false, timeout: 5_000 }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(0))
    request.end(options.body)
  })
}

async function waitUntilLive(settings: ContainerE2eSettings): Promise<boolean> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS
  for (;;) {
    if (await httpsStatus(`${publicOrigin(settings)}/api/health/live`) === 200)
      return true
    if (interrupted || Date.now() >= deadline)
      return false
    await delay(500)
  }
}

const composeProjectsSchema = z.array(z.object({ Name: z.string() }))

/** 清理中断的运行留下的编排项目（连同数据卷） */
function removeStaleProjects(): void {
  const listed = capture('docker', ['compose', 'ls', '--all', '--format', 'json'])
  if (listed.status !== 0)
    return
  const names = composeProjectsSchema.parse(JSON.parse(listed.stdout)).map(project => project.Name)
  for (const name of staleProjects(names, isAlive)) {
    log(`清理中断的运行留下的编排项目 ${name}`)
    capture('docker', ['compose', '-p', name, 'down', '-v', '--remove-orphans'])
  }
}

/**
 * 两个客户端地址的核对（P5 设计 §3.5，DEF-014）：本机经发布的端口、编排网络里另一个容器经站点 caddy，各发一次登录失败，
 * 比较审计记下的两个客户端地址与 Caddy 的地址。返回发现的问题。
 */
async function checkClientAddresses(settings: ContainerE2eSettings): Promise<string[]> {
  const suffix = randomBytes(4).toString('hex')
  const ids = { host: `address-check-host-${suffix}`, network: `address-check-network-${suffix}` }
  const origin = publicOrigin(settings)
  const body = JSON.stringify({ username: 'address-check', password: 'not the password' })
  const headers = { 'content-type': 'application/json', 'origin': origin }
  const problems: string[] = []

  const hostStatus = await httpsStatus(`${origin}/api/auth/login`, { method: 'POST', headers: { ...headers, 'x-request-id': ids.host }, body })
  if (hostStatus !== 401)
    problems.push(`本机那次登录失败的状态码是 ${hostStatus}，期望 401`)
  const script = `fetch('https://caddy/api/auth/login', { method: 'POST', headers: ${JSON.stringify({ ...headers, 'x-request-id': ids.network })}, body: ${JSON.stringify(body)} })`
    + '.then(response => process.exit(response.status === 401 ? 0 : 1), () => process.exit(2))'
  const network = capture('docker', composeArgs(settings, 'run', '--rm', '--no-deps', '-T', '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'app', 'node', '-e', script))
  if (network.status !== 0)
    problems.push(`编排网络里那次登录失败没有得到 401（退出码 ${String(network.status)}）：${network.stderr.trim()}`)

  const audit = capture('docker', composeArgs(settings, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'nerve_office', '-At', '-F', '|', '-c', `SELECT request_id, host(client_ip) FROM audit_events WHERE request_id IN ('${ids.host}', '${ids.network}')`))
  const addresses = parseAuditAddresses(audit.stdout)
  const caddy = capture('docker', composeArgs(settings, 'ps', '-q', 'caddy')).stdout.trim()
  const proxy = capture('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', caddy]).stdout.trim().split(/\s+/).filter(address => address !== '')
  log(`客户端地址：本机 ${addresses.get(ids.host) ?? '（没有）'}，编排网络里 ${addresses.get(ids.network) ?? '（没有）'}，Caddy ${proxy.join('、')}`)
  return [...problems, ...clientAddressProblems({ host: addresses.get(ids.host), network: addresses.get(ids.network), proxy })]
}

function reportMemory(settings: ContainerE2eSettings, moment: string): void {
  const app = capture('docker', composeArgs(settings, 'ps', '-q', 'app')).stdout.trim()
  const stats = capture('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', app]).stdout.trim()
  log(`应用容器的内存（${moment}）：${memoryUsage(stats)}`)
}

function collectLogs(settings: ContainerE2eSettings): void {
  mkdirSync(LOG_DIR, { recursive: true })
  for (const service of SERVICES)
    writeFileSync(join(LOG_DIR, `${service}.log`), capture('docker', composeArgs(settings, 'logs', '--no-color', '--timestamps', service)).stdout)
  writeFileSync(join(LOG_DIR, 'ps.txt'), capture('docker', composeArgs(settings, 'ps', '--all')).stdout)
  log(`各容器的日志在 ${LOG_DIR}`)
}

async function main(): Promise<number> {
  const { browsers, playwrightArgs } = parseArgs(process.argv.slice(2))
  const version = z.object({ version: z.string() }).parse(readJson('package.json')).version
  const revision = capture('git', ['rev-parse', '--short', 'HEAD']).stdout.trim()
  log(`构建镜像 ${E2E_IMAGE}`)
  if (run('docker', ['build', '-f', 'deploy/Dockerfile', '-t', E2E_IMAGE, '--build-arg', `VERSION=${version}`, '--build-arg', `REVISION=${revision}`, '.']) !== 0 || interrupted)
    return 1
  removeStaleProjects()

  const directory = mkdtempSync(join(tmpdir(), 'nerve-office-e2e-'))
  const httpsPort = await freePort()
  let databasePort = await freePort()
  while (databasePort === httpsPort)
    databasePort = await freePort()
  const settings = createSettings({ pid: process.pid, composeFile: join(REPO_ROOT, COMPOSE_FILE), envFile: join(directory, 'test.env'), httpsPort, databasePort })
  writeFileSync(settings.envFile, renderEnvFile(settings), { mode: 0o600 })
  try {
    log(`起测试环境（编排项目 ${settings.project}，${publicOrigin(settings)}）`)
    if (run('docker', composeArgs(settings, 'up', '-d')) !== 0 || interrupted)
      return 1
    if (!await waitUntilLive(settings)) {
      log(`${LIVE_TIMEOUT_MS / 1000} 秒内经 Caddy 的存活探针没有通过`)
      return 1
    }
    const problems = await checkClientAddresses(settings)
    if (problems.length > 0) {
      log(`两个客户端地址的核对没有通过：\n- ${problems.join('\n- ')}`)
      return 1
    }
    // docker image ls 的体积是解压之后的：inspect 的 Size 在 containerd 的镜像存储里是压缩之后的，两种存储不一致
    log(`镜像体积（解压之后）：${capture('docker', ['image', 'ls', '--format', '{{.Size}}', E2E_IMAGE]).stdout.trim()}`)
    reportMemory(settings, '空闲')
    if (interrupted)
      return 1

    log(`以外部模式运行 E2E（浏览器 ${browsers.join('、')}）`)
    const status = run('pnpm', ['--filter', '@nerve-office/e2e', 'run', 'test', ...playwrightArgs], { ...process.env, ...playwrightEnvironment(settings, browsers) })
    reportMemory(settings, '跑完 E2E 之后')
    return status
  }
  finally {
    collectLogs(settings)
    log('删除测试环境')
    capture('docker', composeArgs(settings, 'down', '-v', '--remove-orphans'))
    rmSync(directory, { recursive: true, force: true })
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)

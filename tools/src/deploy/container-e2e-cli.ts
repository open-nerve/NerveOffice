// 容器 E2E（P5 设计 §3.6、§3.8；pnpm test:e2e:container）：用生产镜像起一套测试环境（deploy/test），对它跑 E2E 的外部模式。
// 用法：node tools/src/deploy/container-e2e-cli.ts [--browsers chromium,webkit] [-- <交给 Playwright 的参数>]
// 1. 清理中断的运行留下的编排项目与镜像标签；随机生成三个密码，挑两个空闲端口，变量文件写在临时目录；
// 2. 构建镜像（标签带本进程的进程号）；起 db、migrate、app、caddy（compose 按依赖的条件依次等待）；等经 Caddy 的存活探针通过；
// 3. 部署配置的核对：经 Caddy 的探针（就绪探针的各种写法都被屏蔽）、客户端地址（DEF-014：本机与编排网络里两个来源、
//    伪造的转发头不被采信）、应用的端口没有发布到主机；
// 4. 以外部模式运行 E2E（E2E 的管理员由 Playwright 的全局准备经编排初始化，tests/e2e/support/external-setup.ts）；
// 5. 打印镜像体积与应用容器的内存（空闲、E2E 期间每 2 秒取样的峰值、跑完之后，ADR-001）；
// 6. 无论成败，把各容器的日志收集到 tests/e2e/test-results/container/，然后 down -v、去掉这次的镜像标签、删除临时目录。
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { ContainerE2eSettings, ProbeResponse } from './container-e2e.ts'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'
import {
  clientAddressProblems,
  COMPOSE_FILE,
  composeArgs,
  createSettings,
  FORGED_CLIENT_ADDRESS,
  IMAGE_PREFIX,
  mebibytes,
  memoryBytes,
  parseAuditAddresses,
  playwrightEnvironment,
  PROJECT_PREFIX,
  PROXIED_PROBES,
  proxiedProbeProblems,
  publicOrigin,
  publishedPortProblems,
  renderEnvFile,
  staleRuns,
  staleTemporaryDirectories,
} from './container-e2e.ts'

const LOG_DIR = join(REPO_ROOT, 'tests/e2e/test-results/container')
const SERVICES = ['db', 'migrate', 'app', 'caddy'] as const
/** 等经 Caddy 的存活探针通过的时限 */
const LIVE_TIMEOUT_MS = 120_000

/** Playwright 的命令行：直接用 Node 启动，不经 pnpm（pnpm 收到信号就退出，不转给它启动的脚本，复验 RB1） */
const PLAYWRIGHT_CLI = join(REPO_ROOT, 'tests/e2e/node_modules/@playwright/test/cli.js')

let interrupted = false
/**
 * 正在运行的 Playwright：它在自己的进程组里，终端的 Ctrl+C 不会直接到它；本进程收到的每个信号都转给它一次：
 * 第一次让它正常结束，第二次强制结束。等它退出之后再按正常的路径收集日志、清理（审查 B6）
 */
let playwright: ChildProcess | undefined
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupted = true
    playwright?.kill(signal)
  })
}

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

/** 经 HTTPS 发一个请求，返回状态码与响应头；连不上时状态码是 0。测试环境的证书来自 Caddy 自带的 CA，不校验 */
async function httpsRequest(url: string, options: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<ProbeResponse> {
  return new Promise((resolve) => {
    const request = https.request(url, { method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: false, timeout: 5_000 }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve({ status: 0, headers: {} }))
    request.end(options.body)
  })
}

async function httpsStatus(url: string, options: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<number> {
  return (await httpsRequest(url, options)).status
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

/** 清理中断的运行留下的编排项目（连同数据卷）、镜像标签与临时目录 */
function removeStaleRuns(): void {
  const projects = capture('docker', ['compose', 'ls', '--all', '--format', 'json'])
  if (projects.status === 0) {
    const names = composeProjectsSchema.parse(JSON.parse(projects.stdout)).map(project => project.Name)
    for (const name of staleRuns(names, PROJECT_PREFIX, isAlive)) {
      log(`清理中断的运行留下的编排项目 ${name}`)
      capture('docker', ['compose', '-p', name, 'down', '-v', '--remove-orphans'])
    }
  }
  const images = capture('docker', ['image', 'ls', '--filter', `reference=${IMAGE_PREFIX}*`, '--format', '{{.Repository}}:{{.Tag}}'])
  for (const image of staleRuns(images.stdout.split('\n').filter(line => line !== ''), IMAGE_PREFIX, isAlive))
    capture('docker', ['image', 'rm', image])
  for (const directory of staleTemporaryDirectories(readdirSync(tmpdir()), isAlive))
    rmSync(join(tmpdir(), directory), { recursive: true, force: true })
}

/** 经 Caddy 请求各个探针：存活探针转发，就绪探针的各种写法都被屏蔽；响应都不带 Server 与 Via（审查 A1、复验 RB3） */
async function checkProxiedProbes(settings: ContainerE2eSettings): Promise<string[]> {
  const responses = new Map<string, ProbeResponse>()
  for (const { path } of PROXIED_PROBES)
    responses.set(path, await httpsRequest(`${publicOrigin(settings)}${path}`))
  return proxiedProbeProblems(responses)
}

/**
 * 客户端地址的核对（P5 设计 §3.5，DEF-014）：本机经发布的端口、编排网络里另一个容器经站点 caddy、本机带着伪造的
 * X-Forwarded-For，各发一次登录失败，比较审计记下的客户端地址与 Caddy 的地址；另外确认应用的端口没有发布到主机。
 * 返回发现的问题。
 */
async function checkClientAddresses(settings: ContainerE2eSettings): Promise<string[]> {
  const suffix = randomBytes(4).toString('hex')
  const ids = { host: `address-check-host-${suffix}`, network: `address-check-network-${suffix}`, forged: `address-check-forged-${suffix}` }
  const origin = publicOrigin(settings)
  const body = JSON.stringify({ username: 'address-check', password: 'not the password' })
  const headers = { 'content-type': 'application/json', 'origin': origin }
  const problems: string[] = []

  const hostStatus = await httpsStatus(`${origin}/api/auth/login`, { method: 'POST', headers: { ...headers, 'x-request-id': ids.host }, body })
  if (hostStatus !== 401)
    problems.push(`本机那次登录失败的状态码是 ${hostStatus}，期望 401`)
  const forgedStatus = await httpsStatus(`${origin}/api/auth/login`, { method: 'POST', headers: { ...headers, 'x-request-id': ids.forged, 'x-forwarded-for': FORGED_CLIENT_ADDRESS }, body })
  if (forgedStatus !== 401)
    problems.push(`带着伪造的 X-Forwarded-For 那次登录失败的状态码是 ${forgedStatus}，期望 401`)
  const script = `fetch('https://caddy/api/auth/login', { method: 'POST', headers: ${JSON.stringify({ ...headers, 'x-request-id': ids.network })}, body: ${JSON.stringify(body)} })`
    + '.then(response => process.exit(response.status === 401 ? 0 : 1), () => process.exit(2))'
  const network = capture('docker', composeArgs(settings, 'run', '--rm', '--no-deps', '-T', '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'app', 'node', '-e', script))
  if (network.status !== 0)
    problems.push(`编排网络里那次登录失败没有得到 401（退出码 ${String(network.status)}）：${network.stderr.trim()}`)

  const audit = capture('docker', composeArgs(settings, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'nerve_office', '-At', '-F', '|', '-c', `SELECT request_id, host(client_ip) FROM audit_events WHERE request_id IN ('${ids.host}', '${ids.network}', '${ids.forged}')`))
  const addresses = parseAuditAddresses(audit.stdout)
  const caddy = capture('docker', composeArgs(settings, 'ps', '-q', 'caddy')).stdout.trim()
  const proxy = capture('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', caddy]).stdout.trim().split(/\s+/).filter(address => address !== '')
  log(`客户端地址：本机 ${addresses.get(ids.host) ?? '（没有）'}，编排网络里 ${addresses.get(ids.network) ?? '（没有）'}，本机带伪造的转发头 ${addresses.get(ids.forged) ?? '（没有）'}，Caddy ${proxy.join('、')}`)
  const port = capture('docker', composeArgs(settings, 'port', 'app', '3000'))
  const published = publishedPortProblems(port.status, port.stdout)
  return [...problems, ...published, ...clientAddressProblems({ host: addresses.get(ids.host), network: addresses.get(ids.network), forged: addresses.get(ids.forged), proxy })]
}

const execFileAsync = promisify(execFile)
/** E2E 期间取样应用容器内存的间隔 */
const MEMORY_SAMPLE_INTERVAL_MS = 2_000

/** 应用容器的 id：重启用例用 kill 与 start，容器还是同一个 */
function appContainer(settings: ContainerE2eSettings): string {
  return capture('docker', composeArgs(settings, 'ps', '--all', '-q', 'app')).stdout.trim()
}

async function memoryOf(container: string): Promise<number | undefined> {
  try {
    return memoryBytes((await execFileAsync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container])).stdout)
  }
  catch {
    // 容器正被重启用例强制结束
    return undefined
  }
}

function formatMemory(bytes: number | undefined): string {
  return bytes === undefined ? '（没有取到）' : mebibytes(bytes)
}

/**
 * 以外部模式运行 E2E，期间每 2 秒取样应用容器的内存，返回退出码与峰值。
 * 异步执行：同步执行时事件循环停住，取样的定时器不会触发
 */
async function runE2e(settings: ContainerE2eSettings, browsers: readonly string[], playwrightArgs: readonly string[]): Promise<{ status: number, peak: number | undefined }> {
  const container = appContainer(settings)
  let peak: number | undefined
  let sampling = false
  const timer = setInterval(() => {
    if (sampling)
      return
    sampling = true
    void memoryOf(container).then((bytes) => {
      if (bytes !== undefined)
        peak = Math.max(peak ?? 0, bytes)
    }).finally(() => {
      sampling = false
    })
  }, MEMORY_SAMPLE_INTERVAL_MS)
  try {
    const status = await new Promise<number>((resolve) => {
      // 与 E2E 包的 test 脚本相同：按 @nerve-office/source 条件解析工作区的包（经环境变量，工作进程也继承）
      const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --conditions=@nerve-office/source`.trim()
      const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', ...playwrightArgs], {
        cwd: join(REPO_ROOT, 'tests/e2e'),
        env: { ...process.env, ...playwrightEnvironment(settings, browsers), NODE_OPTIONS: nodeOptions },
        stdio: ['ignore', 'inherit', 'inherit'],
        // 自己的进程组：终端的 Ctrl+C 只到本进程，由本进程转一次（见文件开头）
        detached: true,
      })
      playwright = child
      child.once('error', () => resolve(1))
      child.once('exit', code => resolve(code ?? 1))
    })
    return { status, peak }
  }
  finally {
    clearInterval(timer)
    playwright = undefined
  }
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
  removeStaleRuns()

  // 临时目录的名字带进程号：被 SIGKILL 时留下的，下一次运行认得出来并删掉
  const directory = mkdtempSync(join(tmpdir(), `${PROJECT_PREFIX}${process.pid}-`))
  const httpsPort = await freePort()
  let databasePort = await freePort()
  while (databasePort === httpsPort)
    databasePort = await freePort()
  const settings = createSettings({ pid: process.pid, composeFile: join(REPO_ROOT, COMPOSE_FILE), envFile: join(directory, 'test.env'), httpsPort, databasePort })
  writeFileSync(settings.envFile, renderEnvFile(settings), { mode: 0o600 })
  try {
    log(`构建镜像 ${settings.image}`)
    if (run('docker', ['build', '-f', 'deploy/Dockerfile', '-t', settings.image, '--build-arg', `VERSION=${version}`, '--build-arg', `REVISION=${revision}`, '.']) !== 0 || interrupted)
      return 1
    log(`起测试环境（编排项目 ${settings.project}，${publicOrigin(settings)}）`)
    // 进程号可能被复用：同名的项目不管是谁留下的，先删掉，免得复用旧的数据卷（旧密码）
    capture('docker', composeArgs(settings, 'down', '-v', '--remove-orphans'))
    if (run('docker', composeArgs(settings, 'up', '-d')) !== 0 || interrupted)
      return 1
    if (!await waitUntilLive(settings)) {
      log(`${LIVE_TIMEOUT_MS / 1000} 秒内经 Caddy 的存活探针没有通过`)
      return 1
    }
    const problems = [...await checkProxiedProbes(settings), ...await checkClientAddresses(settings)]
    if (problems.length > 0) {
      log(`部署配置的核对没有通过：\n- ${problems.join('\n- ')}`)
      return 1
    }
    // docker image ls 的体积是解压之后的：inspect 的 Size 在 containerd 的镜像存储里是压缩之后的，两种存储不一致
    log(`镜像体积（解压之后）：${capture('docker', ['image', 'ls', '--format', '{{.Size}}', settings.image]).stdout.trim()}`)
    log(`应用容器的内存（空闲）：${formatMemory(await memoryOf(appContainer(settings)))}`)
    if (interrupted)
      return 1

    log(`以外部模式运行 E2E（浏览器 ${browsers.join('、')}）`)
    const { status, peak } = await runE2e(settings, browsers, playwrightArgs)
    // 重启用例最后执行、会重启应用：跑完之后量到的是重启过的进程，峰值才反映 E2E 期间的占用
    log(`应用容器的内存：E2E 期间的峰值 ${formatMemory(peak)}，跑完之后 ${formatMemory(await memoryOf(appContainer(settings)))}`)
    return status
  }
  finally {
    collectLogs(settings)
    log('删除测试环境')
    capture('docker', composeArgs(settings, 'down', '-v', '--remove-orphans'))
    // 只去掉这次的标签：构建缓存还在，下次构建照样快
    capture('docker', ['image', 'rm', settings.image])
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

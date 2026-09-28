// 容器 E2E（P5 设计 §3.6、§3.8；pnpm test:e2e:container）：用生产镜像起一套测试环境（deploy/test），对它跑 E2E 的外部模式。
// 用法：node tools/src/deploy/container-e2e-cli.ts [--browsers chromium,webkit] [-- <交给 Playwright 的参数>]
// 1. 清理中断的运行留下的编排项目与镜像标签；随机生成三个密码，挑两个空闲端口，变量文件写在临时目录；
// 2. 构建镜像（标签带本进程的进程号）；起 db、migrate、app、caddy（compose 按依赖的条件依次等待）；等经 Caddy 的存活探针通过；
// 3. 部署配置的核对：经 Caddy 的探针（就绪探针的各种写法都被屏蔽）、客户端地址（DEF-014：本机与编排网络里两个来源、
//    伪造的转发头不被采信）、应用的端口没有发布到主机；
// 4. 以外部模式运行 E2E（E2E 的管理员由 Playwright 的全局准备经编排初始化，tests/e2e/support/external-setup.ts）；
// 5. 打印镜像体积与应用容器的内存（空闲、E2E 期间每 2 秒取样的峰值、跑完之后，ADR-001）；
// 6. 无论成败，把各容器的日志收集到 tests/e2e/test-results/container/，然后 down -v、去掉这次的镜像标签、删除临时目录：
//    每一步都执行，前一步失败不跳过后面的，有一步失败就以非零退出（Codex 评审 CX13）。
// 长命令（构建、起环境、编排网络里的核对、E2E）异步执行，收到信号时转给它们，之后不再开始新的步骤（Codex 评审 CX12，
// container-e2e-process.ts）；短命令同步执行，带超时：docker 的守护进程卡住时不会一直停在那里。
import type { AddressInfo } from 'node:net'
import type { CleanupStep } from './container-e2e-process.ts'
import type { ContainerE2eSettings, ProbeResponse } from './container-e2e.ts'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'
import { createInterruption, runCleanup, runTracked } from './container-e2e-process.ts'
import {
  clientAddressProblems,
  COMPOSE_FILE,
  composeArgs,
  createSettings,
  DISTRIBUTED_LICENSE_FILES,
  distributedFileProblems,
  duBytes,
  FILE_SIZES_SCRIPT,
  FORGED_CLIENT_ADDRESS,
  IMAGE_PREFIX,
  imageSizeArgs,
  mebibytes,
  megabytes,
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
/** 同步执行的短命令（查询、日志、down、去掉标签）的时限：到时强制结束，守护进程卡住时不会一直停住（Codex 评审 CX12） */
const SHORT_COMMAND_TIMEOUT_MS = 120_000

/** Playwright 的命令行：直接用 Node 启动，不经 pnpm（pnpm 收到信号就退出，不转给它启动的脚本，复验 RB1） */
const PLAYWRIGHT_CLI = join(REPO_ROOT, 'tests/e2e/node_modules/@playwright/test/cli.js')

/**
 * 收到终止信号时：记下"已中断"，之后不再开始新的步骤；正在运行的长命令由 interruption 转给它（第一次 SIGINT，
 * 相隔 1 秒以上再收到时 SIGKILL 它的整个进程组，container-e2e-process.ts）。它的整个进程组都退出之后，再按正常的路径
 * 收集日志、清理（审查 B6）。本进程被强制结束时，Playwright 的全局准备发现编排脚本不在了，自己停下
 * （tests/e2e/support/external-setup.ts，复验 SB2）。
 * 因为处理了 SIGHUP，nohup 的忽略对本进程不起作用：放到后台跑用 tmux、screen 或 setsid（复验 TB2）
 */
const interruption = createInterruption()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => interruption.receive())

function log(message: string): void {
  console.log(`容器 E2E：${message}`)
}

/**
 * 实测的数字（镜像体积、内存）：CI 上另写成 GitHub 的注解。任务的日志要仓库的管理员权限才能看，注解经公开的接口就能读到，
 * 合并之后据此把 CI（amd64）的数字补进 ADR-001
 */
function measurement(message: string): void {
  log(message)
  if (process.env.GITHUB_ACTIONS === 'true')
    console.log(`::notice title=容器 E2E 的实测::${message}`)
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

interface Captured {
  /** 退出码；超过时限被强制结束、或者启动不了时是 null */
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** 同步执行短命令，输出收集起来；超过时限强制结束 */
function capture(command: string, args: readonly string[]): Captured {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: SHORT_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' })
  const failure = result.error === undefined ? '' : `\n${result.error.message}`
  return { status: result.status, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${failure}` }
}

/** 异步执行长命令，输出直接显示；收到信号时由 interruption 转给它 */
async function run(command: string, args: readonly string[]): Promise<number> {
  return (await runTracked(interruption, command, args, { cwd: REPO_ROOT })).status
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
    if (interruption.interrupted() || Date.now() >= deadline)
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
  // 要起一个容器，是长命令：异步执行，收到信号时转给它（Codex 评审 CX12）
  const network = await runTracked(interruption, 'docker', composeArgs(settings, 'run', '--rm', '--no-deps', '-T', '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'app', 'node', '-e', script), { cwd: REPO_ROOT, capture: true })
  if (interruption.interrupted())
    return ['收到终止信号，核对没有做完']
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

/** 随镜像分发的许可文件都在、都不是空的：在运行着的应用容器里量（DISTRIBUTED_LICENSE_FILES） */
function checkDistributedFiles(settings: ContainerE2eSettings): string[] {
  const sizes = capture('docker', composeArgs(settings, 'exec', '-T', 'app', 'node', '-e', FILE_SIZES_SCRIPT, ...DISTRIBUTED_LICENSE_FILES))
  return distributedFileProblems(DISTRIBUTED_LICENSE_FILES, sizes.status, sizes.stdout)
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
    return memoryBytes((await execFileAsync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container], { timeout: 30_000, killSignal: 'SIGKILL' })).stdout)
  }
  catch {
    // 容器正被重启用例强制结束
    return undefined
  }
}

function formatMemory(bytes: number | undefined): string {
  return bytes === undefined ? '（没有取到）' : mebibytes(bytes)
}

/** 镜像里文件的合计（与镜像存储无关，见 imageSizeArgs）；量不出来时说明原因 */
function imageSize(image: string): string {
  const result = capture('docker', imageSizeArgs(image))
  const bytes = result.status === 0 ? duBytes(result.stdout) : undefined
  return bytes === undefined ? `（没有量到：${result.stderr.trim() || `退出码 ${String(result.status)}`}）` : megabytes(bytes)
}

/**
 * 以外部模式运行 E2E，期间每 2 秒取样应用容器的内存，返回退出码与峰值。
 * 异步执行：同步执行时事件循环停住，取样的定时器不会触发。收到信号时只给 Playwright 的主进程发 SIGINT：
 * 它把 SIGINT 当作正常停止，写出汇总与报告；SIGTERM 会让主进程当场退出，工作进程还要晚一步才退（复验 SB1）
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
    // 与 E2E 包的 test 脚本相同：按 @nerve-office/source 条件解析工作区的包（经环境变量，工作进程也继承）
    const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --conditions=@nerve-office/source`.trim()
    // 浏览器的临时配置目录放进本次运行的临时目录：强制结束时留下的，随它一起删掉
    const temporary = join(dirname(settings.envFile), 'tmp')
    mkdirSync(temporary, { recursive: true })
    const { status } = await runTracked(interruption, process.execPath, [PLAYWRIGHT_CLI, 'test', ...playwrightArgs], {
      cwd: join(REPO_ROOT, 'tests/e2e'),
      env: { ...process.env, ...playwrightEnvironment(settings, browsers, process.pid), NODE_OPTIONS: nodeOptions, TMPDIR: temporary },
      signalTarget: 'leader',
    })
    return { status, peak }
  }
  finally {
    clearInterval(timer)
  }
}

/** 这一步的命令成功了；没有成功时把它的错误输出记下来 */
function succeeded(label: string, result: Captured): boolean {
  if (result.status !== 0)
    log(`${label}：退出码 ${String(result.status)}，${result.stderr.trim()}`)
  return result.status === 0
}

/** 收集各容器的日志：写不进去（例如磁盘满了、目录被占用）时抛出，由清理记下，不影响后面的步骤 */
function collectLogs(settings: ContainerE2eSettings): boolean {
  mkdirSync(LOG_DIR, { recursive: true })
  let collected = true
  for (const service of SERVICES) {
    const logs = capture('docker', composeArgs(settings, 'logs', '--no-color', '--timestamps', service))
    collected = succeeded(`收集 ${service} 的日志`, logs) && collected
    writeFileSync(join(LOG_DIR, `${service}.log`), logs.stdout)
  }
  writeFileSync(join(LOG_DIR, 'ps.txt'), capture('docker', composeArgs(settings, 'ps', '--all')).stdout)
  log(`各容器的日志在 ${LOG_DIR}`)
  return collected
}

/**
 * 清理（Codex 评审 CX13）：收集日志、删除测试环境（连同数据卷）、去掉这次的镜像标签、删除临时目录（变量文件里有密码），
 * 每一步都执行。删除失败的编排项目与镜像标签带着本进程的进程号，下一次运行的遗留清理会认出来再删
 */
function cleanUp(settings: ContainerE2eSettings, directory: string): boolean {
  const steps: CleanupStep[] = [
    { label: '收集日志', run: () => collectLogs(settings) },
    { label: '删除测试环境', run: () => succeeded('删除测试环境', capture('docker', composeArgs(settings, 'down', '-v', '--remove-orphans'))) },
    {
      label: '去掉这次的镜像标签',
      run: () => {
        // 只去掉这次的标签：构建缓存还在，下次构建照样快。构建没有完成时没有这个标签，不算失败
        const tagged = capture('docker', ['image', 'ls', '--quiet', settings.image])
        if (!succeeded('查询这次的镜像标签', tagged))
          return false
        return tagged.stdout.trim() === '' || succeeded('去掉这次的镜像标签', capture('docker', ['image', 'rm', settings.image]))
      },
    },
    {
      label: '删除临时目录',
      run: () => {
        rmSync(directory, { recursive: true, force: true })
        return true
      },
    },
  ]
  log('收集日志，删除测试环境')
  return runCleanup(steps, log)
}

/** 构建、起环境、核对、跑 E2E；返回退出码。每一步之后先看有没有收到终止信号，再做下一步（Codex 评审 CX12） */
async function exercise(settings: ContainerE2eSettings, options: { version: string, revision: string, browsers: readonly string[], playwrightArgs: readonly string[] }): Promise<number> {
  log(`构建镜像 ${settings.image}`)
  if (await run('docker', ['build', '-f', 'deploy/Dockerfile', '-t', settings.image, '--build-arg', `VERSION=${options.version}`, '--build-arg', `REVISION=${options.revision}`, '.']) !== 0 || interruption.interrupted())
    return 1
  log(`起测试环境（编排项目 ${settings.project}，${publicOrigin(settings)}）`)
  // 进程号可能被复用：同名的项目不管是谁留下的，先删掉，免得复用旧的数据卷（旧密码）
  capture('docker', composeArgs(settings, 'down', '-v', '--remove-orphans'))
  if (interruption.interrupted() || await run('docker', composeArgs(settings, 'up', '-d')) !== 0 || interruption.interrupted())
    return 1
  if (!await waitUntilLive(settings)) {
    if (!interruption.interrupted())
      log(`${LIVE_TIMEOUT_MS / 1000} 秒内经 Caddy 的存活探针没有通过`)
    return 1
  }
  const problems = [...await checkProxiedProbes(settings), ...await checkClientAddresses(settings), ...checkDistributedFiles(settings)]
  if (interruption.interrupted())
    return 1
  if (problems.length > 0) {
    log(`部署配置的核对没有通过：\n- ${problems.join('\n- ')}`)
    return 1
  }
  measurement(`镜像体积（镜像里文件的合计，解压之后）：${imageSize(settings.image)}`)
  measurement(`应用容器的内存（空闲）：${formatMemory(await memoryOf(appContainer(settings)))}`)
  if (interruption.interrupted())
    return 1

  log(`以外部模式运行 E2E（浏览器 ${options.browsers.join('、')}）`)
  const { status, peak } = await runE2e(settings, options.browsers, options.playwrightArgs)
  // 重启用例最后执行、会重启应用：跑完之后量到的是重启过的进程，峰值才反映 E2E 期间的占用
  measurement(`应用容器的内存：E2E 期间的峰值 ${formatMemory(peak)}，跑完之后 ${formatMemory(await memoryOf(appContainer(settings)))}`)
  return status
}

async function main(): Promise<number> {
  const { browsers, playwrightArgs } = parseArgs(process.argv.slice(2))
  const version = z.object({ version: z.string() }).parse(readJson('package.json')).version
  const revision = capture('git', ['rev-parse', '--short', 'HEAD']).stdout.trim()
  removeStaleRuns()
  if (interruption.interrupted())
    return 1

  // 临时目录的名字带进程号：被 SIGKILL 时留下的，下一次运行认得出来并删掉
  const directory = mkdtempSync(join(tmpdir(), `${PROJECT_PREFIX}${process.pid}-`))
  const httpsPort = await freePort()
  let databasePort = await freePort()
  while (databasePort === httpsPort)
    databasePort = await freePort()
  const settings = createSettings({ pid: process.pid, composeFile: join(REPO_ROOT, COMPOSE_FILE), envFile: join(directory, 'test.env'), httpsPort, databasePort })
  writeFileSync(settings.envFile, renderEnvFile(settings), { mode: 0o600 })
  let status = 1
  try {
    status = await exercise(settings, { version, revision, browsers, playwrightArgs })
  }
  catch (error) {
    console.error(error)
  }
  // 清理有一步没成功（例如测试环境没删掉）：即使 E2E 通过，也以非零退出，免得留下的东西没人发现
  const cleaned = cleanUp(settings, directory)
  return cleaned ? status : Math.max(status, 1)
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

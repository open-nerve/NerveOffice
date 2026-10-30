// 容器 E2E（P5 设计 §3.6、§3.8；pnpm test:e2e:container）：用生产镜像起一套测试环境（deploy/test），对它跑 E2E 的外部模式。
// 用法：node tools/src/deploy/container-e2e-cli.ts [--browsers chromium,webkit] [-- <交给 Playwright 的参数>]
// 1. 校验父运行器台账，登记 UUID 空命名空间；随机密码、主密钥及临时 env 只在本轮 scratch；
// 2. 构建镜像（UUID 与源码根归属标签）；起 db、migrate、app、caddy（compose 按依赖的条件依次等待）；等经 Caddy 的存活探针通过；
// 3. 部署配置的核对：经 Caddy 的探针（就绪探针的各种写法都被屏蔽）、客户端地址（DEF-014：本机与编排网络里两个来源、
//    伪造的转发头不被采信）、应用的端口没有发布到主机；本机密钥的主密钥缺失、写法不对时应用拒绝启动，输出里没有给出的取值（M3-P6）；
// 4. 以外部模式运行 E2E（E2E 的管理员由 Playwright 的全局准备经编排初始化，tests/e2e/support/external-setup.ts）；
// 5. 打印镜像体积与应用容器的内存（空闲：部署核对之后等一会儿、取几次样的中位数；E2E 期间每 2 秒取样的峰值；跑完之后，ADR-001）；
// 6. 确认生产者退出后收集日志、扫描主密钥并核验当前 daemon/对象标签，只清理本轮；父侧闭合前保留临时环境。
// 长命令（构建、起环境、编排网络里的核对、E2E）异步执行，收到信号时转给它们，之后不再开始新的步骤（Codex 评审 CX12，
// container-e2e-process.ts）；短命令同步执行，带超时：docker 的守护进程卡住时不会一直停在那里。
import type { AddressInfo } from 'node:net'
import type { CleanupStep, RunOptions, RunResult } from './container-e2e-process.ts'
import type { ContainerE2eSettings, ProbeResponse } from './container-e2e.ts'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'
import { createInterruption, runCleanup, runTracked } from './container-e2e-process.ts'
import { ContainerRunResources } from './container-e2e-resources.ts'
import {
  clientAddressProblems,
  COMPOSE_FILE,
  composeArgs,
  createSettings,
  describeIdleMemory,
  DISTRIBUTED_LICENSE_FILES,
  distributedFileProblems,
  duBytes,
  FILE_SIZES_SCRIPT,
  FORGED_CLIENT_ADDRESS,
  IDLE_MEMORY_SAMPLING,
  imageSizeArgs,
  MASTER_KEY_REFUSAL_TIME_LIMIT_MS,
  MASTER_KEY_VARIABLE,
  masterKeyLeakProblems,
  masterKeyRefusalAttempts,
  masterKeyRefusalProblems,
  mebibytes,
  megabytes,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryBytes,
  parseAuditAddresses,
  playwrightEnvironment,
  PROJECT_PREFIX,
  PROXIED_PROBES,
  proxiedProbeProblems,
  publicOrigin,
  publishedPortProblems,
  renderEnvFile,
  sampleMemory,
  serverRequestId,
} from './container-e2e.ts'
import { assetGcRuntimeProblems, assetMountProblems, assetRuntimeProblems, nativeRuntimeProblems } from './container-image-checks.ts'
import { loadNativeMaterials } from './native-image-materials.ts'

const outputDirectory = process.env.NERVE_TEST_OUTPUT_DIR
if (outputDirectory === undefined)
  throw new Error('容器 E2E 须通过 pnpm test:e2e:container 的资源运行器启动')
const LOG_DIR = join(outputDirectory, 'container')
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
let resources: ContainerRunResources | undefined
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

/** 归属查询只接受小型固定字段，绝不读取 Config.Env。 */
function resourceCapture(args: readonly string[]): Captured {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: SHORT_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' })
  return { status: result.error === undefined ? result.status : null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function runOwned(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  if (resources === undefined)
    throw new Error('容器归属尚未登记')
  if (interruption.interrupted())
    return { status: 1, stdout: '', stderr: 'interrupted', quiescent: true }
  resources.producerIntent()
  let pid: number | undefined
  const result = await runTracked(interruption, command, args, { ...options, onSpawn: (value) => {
    pid = value
    resources?.producerStarted(value)
  } })
  resources.producerStopped(pid, result.quiescent)
  if (!result.quiescent)
    interruption.receive()
  return result
}

/** 异步执行长命令，输出直接显示；收到信号时由 interruption 转给它 */
async function run(command: string, args: readonly string[]): Promise<number> {
  return (await runOwned(command, args, { cwd: REPO_ROOT })).status
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
  const origin = publicOrigin(settings)
  const body = JSON.stringify({ username: 'address-check', password: 'not the password' })
  const headers = { 'content-type': 'application/json', 'origin': origin }
  const problems: string[] = []

  // 审计记的是应用自己生成的请求标识（M2-P6 复核 C2）：从每次响应的 X-Request-Id 取，再按它找审计记录
  const host = await httpsRequest(`${origin}/api/auth/login`, { method: 'POST', headers, body })
  if (host.status !== 401)
    problems.push(`本机那次登录失败的状态码是 ${host.status}，期望 401`)
  const forged = await httpsRequest(`${origin}/api/auth/login`, { method: 'POST', headers: { ...headers, 'x-forwarded-for': FORGED_CLIENT_ADDRESS }, body })
  if (forged.status !== 401)
    problems.push(`带着伪造的 X-Forwarded-For 那次登录失败的状态码是 ${forged.status}，期望 401`)
  // 编排网络里那一次：把响应头里的请求标识打印在标准输出上
  const script = `fetch('https://caddy/api/auth/login', { method: 'POST', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(body)} })`
    + '.then(response => { console.log(response.headers.get(\'x-request-id\') ?? \'\'); process.exit(response.status === 401 ? 0 : 1) }, () => process.exit(2))'
  // 要起一个容器，是长命令：异步执行，收到信号时转给它（Codex 评审 CX12）
  const network = await runOwned('docker', composeArgs(settings, 'run', '--rm', '--no-deps', '-T', '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'app', 'node', '-e', script), { cwd: REPO_ROOT, capture: true })
  if (interruption.interrupted())
    return ['收到终止信号，核对没有做完']
  if (network.status !== 0)
    problems.push(`编排网络里那次登录失败没有得到 401（退出码 ${String(network.status)}）：${network.stderr.trim()}`)

  const ids = { host: serverRequestId(host.headers['x-request-id']), network: serverRequestId(network.stdout.split('\n').find(line => line.trim() !== '')), forged: serverRequestId(forged.headers['x-request-id']) }
  const known = [ids.host, ids.network, ids.forged].filter(id => id !== undefined)
  const audit = known.length === 0
    ? undefined
    : capture('docker', composeArgs(settings, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'nerve_office', '-At', '-F', '|', '-c', `SELECT request_id, host(client_ip) FROM audit_events WHERE request_id IN (${known.map(id => `'${id}'`).join(', ')})`))
  const addresses = parseAuditAddresses(audit?.stdout ?? '')
  const caddy = capture('docker', composeArgs(settings, 'ps', '-q', 'caddy')).stdout.trim()
  const proxy = capture('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', caddy]).stdout.trim().split(/\s+/).filter(address => address !== '')
  const addressOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : addresses.get(id))
  const observed = { host: addressOf(ids.host), network: addressOf(ids.network), forged: addressOf(ids.forged), proxy }
  log(`客户端地址：本机 ${observed.host ?? '（没有）'}，编排网络里 ${observed.network ?? '（没有）'}，本机带伪造的转发头 ${observed.forged ?? '（没有）'}，Caddy ${proxy.join('、')}`)
  const port = capture('docker', composeArgs(settings, 'port', 'app', '3000'))
  const published = publishedPortProblems(port.status, port.stdout)
  return [...problems, ...published, ...clientAddressProblems(observed)]
}

/** 随镜像分发的许可文件都在、都不是空的：在运行着的应用容器里量（DISTRIBUTED_LICENSE_FILES） */
function checkDistributedFiles(settings: ContainerE2eSettings): string[] {
  const sizes = capture('docker', composeArgs(settings, 'exec', '-T', 'app', 'node', '-e', FILE_SIZES_SCRIPT, ...DISTRIBUTED_LICENSE_FILES))
  const native = capture('docker', composeArgs(settings, 'exec', '-T', 'app', 'node', 'native-verification/native-image-verify-cli.js', '--bundle', '/app/licenses/native-images', '--api-package', '/app/apps/api/package.json'))
  const { manifest } = loadNativeMaterials(REPO_ROOT)
  const expected = { sharp: manifest.sharp, sharpLibvips: manifest.sharpLibvips, libvips: manifest.libvips, sourceFiles: manifest.sources.length, sourceBytes: manifest.sources.reduce((sum, source) => sum + source.bytes, 0), distributedFiles: manifest.sources.length + 4 }
  log(`原生图片材料回执：${native.stdout.trim() || native.stderr.trim()}`)
  return [...distributedFileProblems(DISTRIBUTED_LICENSE_FILES, sizes.status, sizes.stdout), ...nativeRuntimeProblems(native.status, native.stdout, expected)]
}

/** 在实际运行容器中核对：卷不共享给代理/迁移，应用非 root，私有根真实可写，Linux 限制工具可执行。 */
function checkAssetDeployment(settings: ContainerE2eSettings): string[] {
  const runtime = capture('docker', composeArgs(settings, 'exec', '-T', 'app', 'node', 'native-verification/asset-deployment-cli.js'))
  log(`私有图片卷回执：${runtime.stdout.trim() || runtime.stderr.trim()}`)
  const problems = assetRuntimeProblems(runtime.status, runtime.stdout)
  for (const service of ['app', 'db', 'migrate', 'caddy']) {
    const id = capture('docker', composeArgs(settings, 'ps', '-a', '-q', service))
    const observed = id.status === 0 && id.stdout.trim() !== ''
      ? capture('docker', ['inspect', '--format', '{"mounts":{{json .Mounts}},"readonly":{{json .HostConfig.ReadonlyRootfs}}}', id.stdout.trim()])
      : { status: 1, stdout: '' }
    problems.push(...assetMountProblems(service, `${settings.project}_assets`, observed.status, observed.stdout))
  }
  return problems
}

/** 只在本轮可销毁的库/卷内，经正式 API 组装核对回收；夹具从宿主传入，不加入生产镜像。 */
async function checkAssetGcDeployment(settings: ContainerE2eSettings): Promise<string[]> {
  const script = readFileSync(join(REPO_ROOT, 'tests/integration/src/assets/asset-gc-container.test-support.mjs'), 'utf8')
  const png = readFileSync(join(REPO_ROOT, 'apps/api/src/modules/assets/testdata/minimum.png')).toString('base64')
  const result = await runOwned('docker', composeArgs(settings, 'exec', '-T', '-e', 'NERVE_TEST_ASSET_GC_CONTAINER=disposable-compose', 'app', 'node', '--input-type=module', '-e', script, png), { cwd: REPO_ROOT, capture: true })
  if (interruption.interrupted())
    return ['收到终止信号，资源回收容器核对没有做完']
  const problems = assetGcRuntimeProblems(result.status, result.stdout)
  log(`资源回收私有卷回执：${result.stdout.trim() || '没有有效回执'}`)
  if (problems.length > 0)
    log(`资源回收容器核对失败：${result.stderr.trim()}`)
  return problems
}

/**
 * 本机密钥的主密钥缺失与写法不对时应用拒绝启动（M3-P6 设计 §3.9）：各起一个一次性的应用容器（不带依赖，用镜像默认的命令真的启动），
 * 原 60 秒到期即失败；先中断并确认整个生产者组退出，再交本轮归属清理。
 * 判断在 container-e2e.ts（masterKeyRefusalProblems）。返回发现的问题
 */
async function checkMasterKeyRefusal(settings: ContainerE2eSettings): Promise<string[]> {
  const problems: string[] = []
  for (const [index, attempt] of masterKeyRefusalAttempts(randomBytes).entries()) {
    const name = `${settings.project}-master-key-check-${index}`
    const started = Date.now()
    // 要起一个容器，是长命令：异步执行，收到信号时转给它（Codex 评审 CX12）
    const running = runOwned('docker', composeArgs(settings, 'run', '--rm', '--no-deps', '-T', '--name', name, '-e', `${MASTER_KEY_VARIABLE}=${attempt.value}`, 'app'), { cwd: REPO_ROOT, capture: true })
    const limit = new AbortController()
    const timedOut = await Promise.race([running.then(() => false), delay(MASTER_KEY_REFUSAL_TIME_LIMIT_MS, true, { signal: limit.signal }).catch(() => false)])
    limit.abort()
    if (timedOut)
      interruption.receive()
    const result = await running
    if (interruption.interrupted())
      return [timedOut ? '主密钥探针达到原 60 秒时限；停止后续探针，交归属清理' : '收到终止信号，核对没有做完']
    const output = `${result.stdout}\n${result.stderr}`
    const found = masterKeyRefusalProblems(attempt, { status: timedOut ? null : result.status, timedOut, output })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    log(`${attempt.label}时启动应用：${timedOut ? '到了时限还在跑，已结束' : `退出码 ${result.status}`}，${seconds} 秒${found.length === 0 ? '，按预期拒绝启动' : ''}`)
    if (found.length > 0)
      log(`${attempt.label}时启动应用的输出：\n${output.trim()}`)
    problems.push(...found)
  }
  return problems
}

const execFileAsync = promisify(execFile)

/** 等 ms 毫秒；收到终止信号时提前返回（每半秒看一次，与 waitUntilLive 相同） */
async function pause(ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!interruption.interrupted() && Date.now() < deadline)
    await delay(Math.min(500, deadline - Date.now()))
}

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
async function imageSize(settings: ContainerE2eSettings): Promise<string> {
  if (resources === undefined)
    throw new Error('容器归属尚未登记')
  const running = runOwned('docker', imageSizeArgs(settings.image, `${settings.project}-image-size`, resources.labels), { cwd: REPO_ROOT, capture: true })
  const limit = setTimeout(() => interruption.receive(), SHORT_COMMAND_TIMEOUT_MS)
  try {
    const result = await running
    const bytes = result.status === 0 ? duBytes(result.stdout) : undefined
    return bytes === undefined ? `（没有量到：退出码 ${result.status}）` : megabytes(bytes)
  }
  finally { clearTimeout(limit) }
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
    // 保留资源运行器提供的短 TMPDIR/TMP/TEMP；再嵌套配置目录会超过 Linux branded 浏览器的 Unix socket 路径上限。
    // 真实内容仍在本轮 scratch/tmp，随受管运行结束回收。
    const { status } = await runOwned(process.execPath, [PLAYWRIGHT_CLI, 'test', ...playwrightArgs], {
      cwd: join(REPO_ROOT, 'tests/e2e'),
      env: { ...process.env, ...playwrightEnvironment(settings, browsers, process.pid), NODE_OPTIONS: nodeOptions },
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
 * 收完的各容器日志里不能有本机密钥的主密钥（M3-P6 设计 §3.9，判断在 container-e2e.ts 的 masterKeyLeakProblems）：
 * 出现了就说明在哪个容器的日志里，这一步不算成功（编排脚本随之以非零退出）。日志文件读不到时抛出，同样不算成功
 */
function scanLogsForMasterKey(settings: ContainerE2eSettings): boolean {
  const logs = new Map(SERVICES.map(service => [service, readFileSync(join(LOG_DIR, `${service}.log`), 'utf8')] as const))
  const problems = masterKeyLeakProblems(settings.localKeysMasterKey, logs)
  for (const problem of problems)
    log(problem)
  if (problems.length === 0)
    log(`扫了 ${logs.size} 个容器的日志，里面没有本机密钥的主密钥`)
  return problems.length === 0
}

/** 先收集必要报告；Docker 闭合后由父运行器核对根/别名/句柄并清理临时 env。 */
function cleanUp(settings: ContainerE2eSettings): boolean {
  if (resources === undefined || !resources.canCollect())
    return false
  const steps: CleanupStep[] = [
    { label: '收集日志', run: () => collectLogs(settings) },
    { label: '扫一遍日志里的主密钥', run: () => scanLogsForMasterKey(settings) },
    { label: '核实并清理本轮 Docker 资源', run: () => resources?.cleanup() === true },
  ]
  return runCleanup(steps, log)
}

/** 构建、起环境、核对、跑 E2E；返回退出码。每一步之后先看有没有收到终止信号，再做下一步（Codex 评审 CX12） */
async function exercise(settings: ContainerE2eSettings, options: { version: string, revision: string, browsers: readonly string[], playwrightArgs: readonly string[] }): Promise<number> {
  log(`构建镜像 ${settings.image}`)
  if (await run('docker', ['build', '-f', 'deploy/Dockerfile', '-t', settings.image, ...(resources?.labels.flatMap(label => ['--label', label]) ?? []), '--build-arg', `VERSION=${options.version}`, '--build-arg', `REVISION=${options.revision}`, '.']) !== 0 || interruption.interrupted())
    return 1
  log(`起测试环境（编排项目 ${settings.project}，${publicOrigin(settings)}）`)
  if (interruption.interrupted() || await run('docker', composeArgs(settings, 'up', '-d')) !== 0 || interruption.interrupted())
    return 1
  if (!await waitUntilLive(settings)) {
    if (!interruption.interrupted())
      log(`${LIVE_TIMEOUT_MS / 1000} 秒内经 Caddy 的存活探针没有通过`)
    return 1
  }
  const problems = [...await checkProxiedProbes(settings), ...await checkClientAddresses(settings), ...checkDistributedFiles(settings), ...checkAssetDeployment(settings), ...await checkAssetGcDeployment(settings), ...await checkMasterKeyRefusal(settings)]
  if (interruption.interrupted())
    return 1
  if (problems.length > 0) {
    log(`部署配置的核对没有通过：\n- ${problems.join('\n- ')}`)
    return 1
  }
  measurement(`镜像体积（镜像里文件的合计，解压之后）：${await imageSize(settings)}`)
  // 空闲：部署核对里的登录各算一次 Argon2，等内存回落之后取几次样、取中位数（IDLE_MEMORY_SAMPLING 写明了等多久、取几次与理由）
  const container = appContainer(settings)
  const idle = await sampleMemory(IDLE_MEMORY_SAMPLING, { sample: async () => memoryOf(container), wait: pause, stopped: () => interruption.interrupted() })
  if (interruption.interrupted())
    return 1
  measurement(`应用容器的内存（空闲）：${describeIdleMemory(IDLE_MEMORY_SAMPLING, idle)}`)

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
  if (interruption.interrupted())
    return 1

  const context = z.object({ directory: z.string(), runId: z.string(), scratch: z.string() }).parse({
    directory: process.env.NERVE_TEST_RUN_DIR,
    runId: process.env.NERVE_TEST_RUN_ID,
    scratch: process.env.NERVE_TEST_SCRATCH,
  })
  const directory = mkdtempSync(join(tmpdir(), `${PROJECT_PREFIX}${context.runId}-`))
  const httpsPort = await freePort()
  let databasePort = await freePort()
  while (databasePort === httpsPort)
    databasePort = await freePort()
  const settings = createSettings({ runId: context.runId, composeFile: join(REPO_ROOT, COMPOSE_FILE), envFile: join(directory, 'test.env'), httpsPort, databasePort })
  resources = new ContainerRunResources({ ...context, repo: realpathSync(REPO_ROOT) }, settings, resourceCapture)
  resources.reserve()
  process.env.NERVE_TEST_REPO_HASH = resources.repoHash
  let status = 1
  try {
    writeFileSync(settings.envFile, `${renderEnvFile(settings)}NERVE_TEST_RUN_ID=${context.runId}\nNERVE_TEST_REPO_HASH=${resources.repoHash}\n`, { mode: 0o600 })
    status = await exercise(settings, { version, revision, browsers, playwrightArgs })
  }
  catch (error) {
    console.error(error)
  }
  // 清理有一步没成功（例如测试环境没删掉）：即使 E2E 通过，也以非零退出，免得留下的东西没人发现
  const cleaned = cleanUp(settings)
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

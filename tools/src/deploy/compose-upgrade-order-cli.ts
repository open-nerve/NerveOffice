// M5-P7 Q-08 取证：经受管运行器起一次性测试环境（deploy/test），记录 `docker compose up -d` 升级时旧 app 停止与 migrate 启动的先后。
// 用法：python3 -B tools/test-resources/run.py container -- node tools/src/deploy/compose-upgrade-order-cli.ts
// 1. 校验父运行器台账、登记本轮 UUID 空命名空间；随机密码与主密钥只写进本轮 scratch 的临时 env；
// 2. 构建镜像（UUID 与源码根归属标签），`up -d` 起 db、migrate、app、caddy，等 app 健康；
// 3. 开始只看本项目的 docker events，改 migrate 与 app 共用的一个变量后再 `up -d`，等新的 app 健康后停止事件流；
//    deploy/README.md 的步骤是改 NERVE_IMAGE；台账只认本轮的一个镜像名，第二个标签会被判为归属不符。两种改动都让这两个服务的
//    配置摘要变化，走 Compose 同一条重建路径；只用于判定停启顺序，不代表镜像升级的其他方面；
// 4. 输出一行 COMPOSE_UPGRADE_ORDER_RESULT（不含容器 ID、环境变量与日志），核验并清理本轮 Docker 资源。
import type { AddressInfo } from 'node:net'
import type { RunOptions, RunResult } from './container-e2e-process.ts'
import type { ContainerE2eSettings } from './container-e2e.ts'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'
import { parseContainerEvents, upgradeOrder } from './compose-upgrade-order.ts'
import { createInterruption, runCleanup, runTracked, signalGroup } from './container-e2e-process.ts'
import { ContainerRunResources } from './container-e2e-resources.ts'
import { COMPOSE_FILE, composeArgs, createSettings, PROJECT_PREFIX, renderEnvFile } from './container-e2e.ts'

const SHORT_COMMAND_TIMEOUT_MS = 120_000
/** 等 app 健康的时限（包括首次迁移与升级时的重建） */
const HEALTHY_TIMEOUT_MS = 240_000
/** 事件流的输出上限：只有本项目四个服务的生命周期与健康检查事件 */
const EVENTS_LIMIT = 4 * 1024 * 1024
/** 触发重建的共用变量：compose.yaml 里默认 100，两个服务都经 x-nerve-environment 读取 */
const TRIGGER = 'NERVE_HISTORY_PURGE_BATCH=101'

const interruption = createInterruption()
let resources: ContainerRunResources | undefined
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => interruption.receive())

function log(message: string): void {
  console.log(`compose 升级顺序：${message}`)
}

interface Captured {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function capture(command: string, args: readonly string[]): Captured {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: SHORT_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' })
  return { status: result.error === undefined ? result.status : null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 归属查询只接受小型固定字段，绝不读取 Config.Env */
function resourceCapture(args: readonly string[]): Captured {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: SHORT_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' })
  return { status: result.error === undefined ? result.status : null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 会创建或改动 Docker 资源的长命令：先登记生产者，再启动；结束后确认整个进程组已退出 */
async function runOwned(command: string, args: readonly string[], options: RunOptions = { cwd: REPO_ROOT }): Promise<RunResult> {
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

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** 等这个服务的容器健康（不是 except 那一个），返回它的 ID */
async function healthy(settings: ContainerE2eSettings, service: string, except?: string): Promise<string | undefined> {
  const deadline = Date.now() + HEALTHY_TIMEOUT_MS
  while (Date.now() < deadline && !interruption.interrupted()) {
    const id = capture('docker', composeArgs(settings, 'ps', '-q', service)).stdout.trim()
    if (id !== '' && id !== except && !id.includes('\n')) {
      const state = capture('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]).stdout.trim()
      if (state === 'healthy')
        return id
    }
    await delay(1000)
  }
  return undefined
}

/** 只看本项目容器的事件流（不创建资源）；收到终止信号时随长命令一起转发 */
function watchEvents(settings: ContainerE2eSettings): { stop: () => Promise<string> } {
  const child = spawn('docker', ['events', '--filter', `label=com.docker.compose.project=${settings.project}`, '--filter', 'type=container', '--format', '{{json .}}'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (output.length + chunk.length <= EVENTS_LIMIT)
      output += chunk
  })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const untrack = interruption.track(child, 'group')
  return {
    stop: async () => {
      if (child.pid !== undefined)
        signalGroup(child.pid, 'SIGTERM')
      await closed
      untrack()
      return output
    },
  }
}

async function exercise(settings: ContainerE2eSettings, version: string, revision: string): Promise<number> {
  log(`构建镜像 ${settings.image}`)
  if ((await runOwned('docker', ['build', '-f', 'deploy/Dockerfile', '-t', settings.image, ...(resources?.labels.flatMap(label => ['--label', label]) ?? []), '--build-arg', `VERSION=${version}`, '--build-arg', `REVISION=${revision}`, '.'])).status !== 0 || interruption.interrupted())
    return 1
  log(`起测试环境（编排项目 ${settings.project}）`)
  if ((await runOwned('docker', composeArgs(settings, 'up', '-d'))).status !== 0 || interruption.interrupted())
    return 1
  const oldApp = await healthy(settings, 'app')
  if (oldApp === undefined) {
    log('首次启动后 app 没有在时限内健康')
    return 1
  }
  const events = watchEvents(settings)
  let raw = ''
  let newApp: string | undefined
  let upgradeMs = 0
  try {
    // 留出订阅建立的时间，避免漏掉第一条事件
    await delay(1500)
    appendFileSync(settings.envFile, `${TRIGGER}\n`)
    log(`改共用变量（${TRIGGER}）之后再 up -d`)
    const started = Date.now()
    if ((await runOwned('docker', composeArgs(settings, 'up', '-d'))).status !== 0 || interruption.interrupted())
      return 1
    newApp = await healthy(settings, 'app', oldApp)
    upgradeMs = Date.now() - started
    await delay(2000)
  }
  finally {
    raw = await events.stop()
  }
  if (newApp === undefined) {
    log('升级之后新的 app 没有在时限内健康')
    return 1
  }
  const order = upgradeOrder(parseContainerEvents(raw), oldApp)
  const composeVersion = capture('docker', ['compose', 'version', '--short']).stdout.trim()
  console.log(`COMPOSE_UPGRADE_ORDER_RESULT=${JSON.stringify({ measuredAt: new Date().toISOString(), composeVersion, trigger: 'shared-environment-change', upgradeUntilHealthyMs: upgradeMs, ...order })}`)
  log(`判定：${order.verdict}`)
  return order.verdict === 'incomplete' ? 1 : 0
}

function cleanUp(): boolean {
  if (resources === undefined || !resources.canCollect())
    return false
  return runCleanup([{ label: '核实并清理本轮 Docker 资源', run: () => resources?.cleanup() === true }], log)
}

async function main(): Promise<number> {
  const version = z.object({ version: z.string() }).parse(readJson('package.json')).version
  const revision = capture('git', ['rev-parse', '--short', 'HEAD']).stdout.trim()
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
  let status = 1
  try {
    writeFileSync(settings.envFile, `${renderEnvFile(settings)}NERVE_TEST_RUN_ID=${context.runId}\nNERVE_TEST_REPO_HASH=${resources.repoHash}\n`, { mode: 0o600 })
    status = await exercise(settings, version, revision)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }
  const cleaned = cleanUp()
  return cleaned ? status : Math.max(status, 1)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  },
)

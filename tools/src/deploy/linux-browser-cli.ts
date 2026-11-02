/** Fixed Linux arm64 calibration/selftest. No host browser or full gate. */
import type { BudgetSample } from './linux-browser.ts'
import { execFile, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { REPO_ROOT } from '../shared/repo.ts'
import { parseContainerJson } from './container-e2e-json.ts'
import { createInterruption, runTracked } from './container-e2e-process.ts'
import { ContainerRunResources } from './container-e2e-resources.ts'
import { createSettings, memoryBytes } from './container-e2e.ts'
import { assertNoOutstandingImageCache, LinuxBrowserCache } from './linux-browser-cache.ts'
import { browserPlan, budgetProblem, DATABASE_IMAGE, GIB, guestExitStatus, linuxEnvironmentFile, linuxSuite, NODE_IMAGE, PLAYWRIGHT_IMAGE, stopWithMeter, withLinuxCleanup } from './linux-browser.ts'

const environment = z.object({
  NERVE_TEST_RUN_ID: z.string().uuid(),
  NERVE_TEST_RUN_DIR: z.string(),
  NERVE_TEST_SCRATCH: z.string(),
  NERVE_TEST_OUTPUT_DIR: z.string(),
}).parse(process.env)
const suite = linuxSuite(process.argv.slice(2))
const { NERVE_TEST_RUN_ID: runId, NERVE_TEST_RUN_DIR: directory, NERVE_TEST_SCRATCH: scratch, NERVE_TEST_OUTPUT_DIR: output } = environment
if (realpathSync(output) !== join(scratch, 'tests/e2e/test-results'))
  throw new Error('linux-output-owner')
const logDirectory = join(output, 'linux-browser')
mkdirSync(logDirectory)
const write = (name: string, value: unknown) => writeFileSync(join(logDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const interruption = createInterruption()
let recoveryInterruption: ReturnType<typeof createInterruption> | undefined
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    interruption.receive()
    recoveryInterruption?.receive()
  })
}

function capture(args: readonly string[]) {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 })
  return { status: result.error === undefined ? result.status : null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function query(args: readonly string[]): string {
  const result = capture(args)
  if (result.status !== 0 || result.stderr.trim())
    throw new Error('linux-docker-query-failed')
  return result.stdout.trim()
}

const settings = createSettings({ runId, composeFile: join(REPO_ROOT, 'deploy/test/compose.yaml'), envFile: linuxEnvironmentFile(scratch), httpsPort: 1, databasePort: 2 })
mkdirSync(dirname(settings.envFile))
const resources = new ContainerRunResources({ directory, runId, repo: REPO_ROOT, scratch }, settings, capture)
const cache = new LinuxBrowserCache(directory, runId, capture)
const plan = browserPlan(settings.project, scratch, resources.labels, suite)
const evidenceTool = join(REPO_ROOT, 'tools/test-resources/linux_browser_evidence.py')
const evidenceHold = join(directory, 'linux-browser-evidence-hold.json')
const evidenceHoldBytes = `${JSON.stringify({ version: 1, runId, reason: 'inner-evidence-not-exported' })}\n`
function syncDirectory(): void {
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
}
function holdEvidence(): void {
  const fd = openSync(evidenceHold, 'wx', 0o600)
  try {
    writeFileSync(fd, evidenceHoldBytes)
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
  syncDirectory()
}
const executeFile = promisify(execFile)
let stopMonitor = false
let monitor: Promise<void> | undefined
let imageBytes = 5 * GIB
let frozenContainers: z.infer<typeof measuredContainer>[] | undefined
let frozenVolumes: [number, number] | undefined
let lastVolumes: [number, number] = [0, 0]
let meterStarted = false
let guestStartIntent = false
let reserved = false
let stopReason: string | undefined
const created = new Map<string, string>()
const daemon = z.object({ id: z.string(), os: z.literal('linux'), arch: z.literal('aarch64'), memory: z.number().min(6 * GIB) })
  .parse(parseContainerJson(query(['info', '--format', '{"id":{{json .ID}},"os":{{json .OSType}},"arch":{{json .Architecture}},"memory":{{json .MemTotal}}}'])))
write('environment.json', { version: 1, suite, daemon, runId, platform: 'linux/arm64', runnerMemory: 4 * GIB, databaseMemory: GIB / 2, memoryNote: 'Docker Desktop settings unchanged', stopThreshold: 16 * GIB, reserve: 12 * GIB, samplingMs: 2000, plan })

async function owned(command: string, args: readonly string[], recovering = false): Promise<number> {
  const control = recovering ? createInterruption() : interruption
  if (recovering)
    recoveryInterruption = control
  if (control.interrupted() || (recovering && stopReason !== undefined))
    return 130
  resources.producerIntent()
  let pid: number | undefined
  const result = await runTracked(control, command, args, { cwd: REPO_ROOT, onSpawn: (value) => {
    pid = value
    resources.producerStarted(value)
  } })
  if (recovering)
    recoveryInterruption = undefined
  resources.producerStopped(pid, result.quiescent)
  if (!result.quiescent)
    interruption.receive()
  return result.status
}
async function requireRun(command: string, args: readonly string[]): Promise<void> {
  if (await owned(command, args) !== 0)
    throw new Error('linux-command-failed')
}
async function bounded(command: string, args: readonly string[]): Promise<string> {
  const result = await executeFile(command, args, { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 })
  if (result.stderr.trim())
    throw new Error('linux-measurement-stderr')
  return result.stdout.trim()
}

const measuredContainer = z.object({
  id: z.string().min(1),
  name: z.string(),
  writable: z.number().int().nonnegative(),
  run: z.literal(runId),
  repo: z.literal(resources.repoHash),
  running: z.boolean(),
  oom: z.boolean(),
  exit: z.number().int(),
}).strict()
const containerFormat = '{"id":{{json .Id}},"name":{{json .Name}},"writable":{{json .SizeRw}},"run":{{json (index .Config.Labels "org.nerve-office.test.run")}},"repo":{{json (index .Config.Labels "org.nerve-office.test.repo")}},"running":{{json .State.Running}},"oom":{{json .State.OOMKilled}},"exit":{{json .State.ExitCode}}}'

async function measure(): Promise<void> {
  if (frozenContainers === undefined && await bounded('docker', ['info', '--format', '{{.ID}}']) !== daemon.id)
    throw new Error('linux-daemon-changed')
  const containers = frozenContainers === undefined ? [] : [...frozenContainers]
  for (const [name, id] of frozenContainers === undefined ? created : []) {
    const info = measuredContainer.parse(parseContainerJson(await bounded('docker', ['container', 'inspect', '--size', '--format', containerFormat, name])))
    if (info.name !== `/${name}` || info.id !== id)
      throw new Error('linux-container-replaced')
    containers.push(info)
  }
  const size = (text: string) => {
    const match = /^(\d+)\s/.exec(text)
    if (match === null)
      throw new Error('linux-du-format')
    return Number(match[1]) * 1024
  }
  const scratchBytes = size(await bounded('du', ['-sk', scratch]))
  const volumeSizes = frozenVolumes ?? (meterStarted ? (await bounded('docker', ['exec', `${settings.project}-meter`, 'du', '-sk', '/owned', '/database'])).split('\n').map(size) : [0, 0])
  if (volumeSizes.length !== 2)
    throw new Error('linux-volume-measurement')
  lastVolumes = volumeSizes as [number, number]
  const [workspace, database] = lastVolumes
  const filesystem = statfsSync(scratch)
  const sample: BudgetSample = { scratch: scratchBytes, writable: containers.reduce((sum, item) => sum + item.writable, 0), workspace, database, image: imageBytes, available: filesystem.bavail * filesystem.bsize }
  const running = containers.filter(item => item.running)
  const stats = running.length === 0
    ? []
    : (await bounded('docker', ['stats', '--no-stream', '--format', '{"id":{{json .ID}},"memory":{{json .MemUsage}},"cpu":{{json .CPUPerc}}}', ...running.map(item => item.id)]))
        .split('\n')
        .map((line) => {
          const info = z.object({ id: z.string(), memory: z.string(), cpu: z.string() }).parse(parseContainerJson(line))
          const bytes = memoryBytes(info.memory)
          if (bytes === undefined || !running.some(item => item.id.startsWith(info.id)))
            throw new Error('linux-stats-format')
          return { ...info, memoryBytes: bytes }
        })
  const record = { at: new Date().toISOString(), ...sample, containers, stats }
  // 2-second records are bounded to 4 MiB, and no Config.Env or credentials are inspected.
  const log = join(logDirectory, 'measurements.jsonl')
  if (existsSync(log) && lstatSync(log).size >= 4 * 1024 ** 2)
    throw new Error('linux-measurement-log-budget')
  appendFileSync(log, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  const problem = budgetProblem(sample)
  if (problem !== undefined || containers.some(item => item.oom))
    throw new Error(problem ?? 'container-oom')
}

async function monitoring(): Promise<void> {
  for (;;) {
    if (stopMonitor)
      return
    const started = Date.now()
    try {
      await measure()
    }
    catch (error) {
      stopReason = error instanceof Error && ['container-oom', 'environment-budget', 'disk-reserve'].includes(error.message) ? error.message : 'resource-measurement-failed'
      interruption.receive()
      recoveryInterruption?.receive()
      return
    }
    if (!stopMonitor)
      await delay(Math.max(0, 2000 - (Date.now() - started)))
  }
}

async function createContainer(args: readonly string[], name: string): Promise<void> {
  await requireRun('docker', args)
  const id = query(['container', 'inspect', '--format', '{{.Id}}', name])
  if (!/^[0-9a-f]{64}$/.test(id))
    throw new Error('linux-container-id')
  created.set(name, id)
}

function runnerIdentity(): string {
  const id = created.get(`${settings.project}-runner`)
  if (id === undefined)
    throw new Error('linux-runner-not-created')
  return id
}

function assertContainerSet(): void {
  if (!resources.canCollect())
    throw new Error('linux-container-ownership-unverified')
  const ids = query(['container', 'ls', '-a', '--no-trunc', '--filter', `label=${resources.labels[0]}`, '--format', '{{.ID}}']).split('\n').filter(Boolean).sort()
  if (JSON.stringify(ids) !== JSON.stringify([...created.values()].sort()))
    throw new Error('linux-container-set-changed')
}
function assertStoppedContainers(): z.infer<typeof measuredContainer>[] {
  assertContainerSet()
  const snapshot = []
  for (const [name, id] of created) {
    const actual = measuredContainer.parse(parseContainerJson(query(['container', 'inspect', '--size', '--format', containerFormat, id])))
    if (actual.id !== id || actual.name !== `/${name}` || actual.running)
      throw new Error('linux-container-not-stopped')
    snapshot.push(actual)
  }
  return snapshot
}
async function quiesceContainers(): Promise<boolean> {
  assertContainerSet()
  const meterId = created.get(`${settings.project}-meter`)
  await stopWithMeter({
    writers: [...created.values()].filter(id => id !== meterId).map(id => () => {
      query(['container', 'stop', '--timeout=10', id])
    }),
    async measure() {
      await measure()
      frozenVolumes = [...lastVolumes]
    },
    meter() {
      if (meterId !== undefined)
        query(['container', 'stop', '--timeout=10', meterId])
      meterStarted = false
    },
  })
  frozenContainers = assertStoppedContainers()
  return true
}

async function main(): Promise<void> {
  const result = await withLinuxCleanup({
    async body() {
      assertNoOutstandingImageCache(dirname(directory))
      resources.reserve()
      reserved = true
      monitor = monitoring()
      await requireRun('python3', ['-B', evidenceTool, 'snapshot', '--repo', REPO_ROOT, '--output', join(scratch, 'source'), '--manifest', join(scratch, 'source.json')])
      await requireRun('python3', ['-B', evidenceTool, 'patches', '--repo', REPO_ROOT, '--output', join(scratch, 'host-patches.json')])
      // Borrow known pinned images. Missing images stop here, with no implicit pull.
      for (const ref of [NODE_IMAGE, DATABASE_IMAGE]) {
        if (query(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', ref]) !== 'linux/arm64')
          throw new Error('linux-prerequisite-image')
      }
      if (cache.reserve()) {
        imageBytes = 5 * GIB // Conservative reservation also covers the pull interval.
        await requireRun('docker', ['pull', '--platform=linux/arm64', PLAYWRIGHT_IMAGE])
      }
      imageBytes = cache.acquired()
      const labels = resources.labels.flatMap(label => ['--label', label])
      await requireRun('docker', ['network', 'create', ...labels, `${settings.project}_default`])
      await requireRun('docker', ['volume', 'create', ...labels, `${settings.project}_pgdata`])
      await requireRun('docker', ['volume', 'create', ...labels, `${settings.project}_assets`])
      await createContainer(plan.meter, `${settings.project}-meter`)
      await requireRun('docker', ['start', `${settings.project}-meter`])
      meterStarted = true
      await createContainer(plan.preparation, `${settings.project}-node`)
      await requireRun('docker', ['start', '--attach', `${settings.project}-node`])
      const prepared = measuredContainer.parse(parseContainerJson(query(['container', 'inspect', '--size', '--format', containerFormat, `${settings.project}-node`])))
      if (guestExitStatus(0, prepared) !== 0 || prepared.id !== created.get(`${settings.project}-node`))
        throw new Error('linux-toolchain-preparation-failed')
      writeFileSync(settings.envFile, `POSTGRES_PASSWORD=${settings.passwords.admin}\nNERVE_TEST_DATABASE_URL=postgres://postgres:${settings.passwords.admin}@db:5432/postgres\n`, { flag: 'wx', mode: 0o600 })
      await createContainer(plan.database, `${settings.project}-db`)
      await requireRun('docker', ['start', `${settings.project}-db`])
      const deadline = Date.now() + 60_000
      while (query(['inspect', '--format', '{{.State.Health.Status}}', `${settings.project}-db`]) !== 'healthy') {
        if (interruption.interrupted() || Date.now() >= deadline)
          throw new Error('linux-db-not-ready')
        await delay(500)
      }
      holdEvidence()
      await createContainer(plan.runner, `${settings.project}-runner`)
      const runnerId = runnerIdentity()
      for (const name of ['source', 'source.json', 'host-patches.json']) {
        await requireRun('docker', ['cp', join(scratch, name) + (name === 'source' ? '/.' : ''), `${runnerId}:/owned/${name}`])
      }
      guestStartIntent = true
      const status = await owned('docker', ['start', '--attach', runnerId])
      const guest = measuredContainer.parse(parseContainerJson(query(['container', 'inspect', '--size', '--format', containerFormat, `${settings.project}-runner`])))
      if (guest.id !== created.get(`${settings.project}-runner`))
        throw new Error('linux-guest-replaced')
      write('guest-exit.json', { clientStatus: status, guest })
      return guestExitStatus(status, guest)
    },
    async quiesce() {
      stopMonitor = true
      await monitor
      if (reserved) {
        try {
          await measure()
        }
        catch {
          stopReason ??= 'resource-measurement-failed'
          interruption.receive()
        }
      }
      return !reserved || quiesceContainers()
    },
    async collect() {
      for (const name of ['source.json', 'host-patches.json']) {
        const path = join(scratch, name)
        if (existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 16 * 1024 ** 2)
          copyFileSync(path, join(logDirectory, name))
      }
      if (!guestStartIntent)
        return { safeToRelease: true, passed: false }
      assertStoppedContainers()
      stopMonitor = false
      monitor = monitoring()
      const exported = join(scratch, 'exported')
      const transferStatus = await owned('python3', ['-B', join(REPO_ROOT, 'tools/test-resources/linux_browser_transport.py'), '--container', runnerIdentity(), '--output', exported, '--suite', suite], true)
      if (transferStatus !== 0)
        throw new Error('linux-transfer-incomplete')
      assertStoppedContainers()
      for (const name of ['source.json', 'host-patches.json'])
        copyFileSync(join(scratch, name), join(exported, name))
      copyFileSync(join(exported, 'transport.json'), join(logDirectory, 'transport.json'))
      const small = ['versions.json', 'patches-before.json', 'patches-after.json', 'source-before.json', 'source-after.json', 'execution.json', 'preflight-before-install.json', 'preflight-after-pnpm.json']
      for (const name of small) {
        const path = join(exported, 'evidence', name)
        if (existsSync(path)) {
          if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 ** 2)
            throw new Error('linux-evidence-file')
          copyFileSync(path, join(logDirectory, name))
        }
      }
      const verification = await owned('python3', ['-B', evidenceTool, 'verify', '--repo', REPO_ROOT, '--manifest', join(scratch, 'source.json'), '--output', join(logDirectory, 'host-source-after.json')], true)
      const collection = await owned('python3', ['-B', evidenceTool, 'collect', '--repo', exported, '--output', logDirectory, '--run-id', runId, '--suite', suite], true)
      const summary = z.object({ version: z.literal(1), safeToRelease: z.boolean() }).parse(parseContainerJson(readFileSync(join(logDirectory, 'groups.json'), 'utf8')))
      return { safeToRelease: summary.safeToRelease, passed: verification === 0 && collection === 0 }
    },
    async close() {
      stopMonitor = true
      await monitor
      if (reserved)
        assertStoppedContainers()
      if (reserved && !resources.cleanup())
        return false
      if (existsSync(evidenceHold)) {
        if (lstatSync(evidenceHold).isSymbolicLink() || readFileSync(evidenceHold, 'utf8') !== evidenceHoldBytes)
          throw new Error('linux-evidence-hold-changed')
        unlinkSync(evidenceHold)
        syncDirectory()
      }
      return true
    },
    async release(closed) {
      stopMonitor = true
      await monitor
      const released = cache.release(closed)
      const path = join(directory, 'linux-browser-image.json')
      if (existsSync(path))
        copyFileSync(path, join(logDirectory, 'image-cache.json'))
      return released
    },
  })
  write('summary.json', { ...result, stopReason, runId, sourceHead: existsSync(join(scratch, 'source.json'))
    ? (JSON.parse(readFileSync(join(scratch, 'source.json'), 'utf8')) as { head: string }).head
    : null, sampleNote: '16 GiB is a stop threshold; sampling/termination can overshoot. Shared image retention is separate from container closure.' })
  console.log(`Linux Chromium 校准：退出 ${result.status}，容器闭合 ${result.closed}，镜像处置 ${result.cacheHandled}`)
  process.exitCode = interruption.interrupted() ? 130 : result.status
}

void main().catch(() => {
  console.error('Linux 校准入口异常；保留父运行器诊断')
  process.exitCode = 1
})

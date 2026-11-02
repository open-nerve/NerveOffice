/** P6-S4: fixed Linux arm64 calibration. No host browser or full gate. */
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
import { browserPlan, budgetProblem, DATABASE_IMAGE, GIB, guestExitStatus, linuxEnvironmentFile, NODE_IMAGE, PLAYWRIGHT_IMAGE, withLinuxCleanup } from './linux-browser.ts'

const environment = z.object({
  NERVE_TEST_RUN_ID: z.string().uuid(),
  NERVE_TEST_RUN_DIR: z.string(),
  NERVE_TEST_SCRATCH: z.string(),
  NERVE_TEST_OUTPUT_DIR: z.string(),
}).parse(process.env)
if (process.argv.length !== 2)
  throw new Error('linux-calibration-has-no-custom-arguments')
const { NERVE_TEST_RUN_ID: runId, NERVE_TEST_RUN_DIR: directory, NERVE_TEST_SCRATCH: scratch, NERVE_TEST_OUTPUT_DIR: output } = environment
if (realpathSync(output) !== join(scratch, 'tests/e2e/test-results'))
  throw new Error('linux-output-owner')
const logDirectory = join(output, 'linux-browser')
mkdirSync(logDirectory)
const write = (name: string, value: unknown) => writeFileSync(join(logDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const interruption = createInterruption()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => interruption.receive())

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
const plan = browserPlan(settings.project, scratch, resources.labels)
const evidenceTool = join(REPO_ROOT, 'tools/test-resources/linux_browser_evidence.py')
const evidenceHold = join(directory, 'linux-browser-evidence-hold.json')
const evidenceHoldBytes = `${JSON.stringify({ version: 1, runId, reason: 'inner-evidence-not-exported' })}\n`
function syncDirectory(): void {
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  }
  finally { closeSync(fd) }
}
function holdEvidence(): void {
  const fd = openSync(evidenceHold, 'wx', 0o600)
  try {
    writeFileSync(fd, evidenceHoldBytes)
    fsyncSync(fd)
  }
  finally { closeSync(fd) }
  syncDirectory()
}
const executeFile = promisify(execFile)
let stopMonitor = false
let monitor: Promise<void> | undefined
let imageBytes = 0
let databaseStarted = false
let reserved = false
let stopReason: string | undefined
const created = new Map<string, string>()
const daemon = z.object({ id: z.string(), os: z.literal('linux'), arch: z.literal('aarch64'), memory: z.number().min(6 * GIB) })
  .parse(parseContainerJson(query(['info', '--format', '{"id":{{json .ID}},"os":{{json .OSType}},"arch":{{json .Architecture}},"memory":{{json .MemTotal}}}'])))
write('environment.json', { version: 1, daemon, runId, platform: 'linux/arm64', runnerMemory: 4 * GIB, databaseMemory: GIB / 2, memoryNote: 'Docker Desktop settings unchanged', stopThreshold: 16 * GIB, reserve: 12 * GIB, samplingMs: 2000, plan })

async function owned(command: string, args: readonly string[]): Promise<number> {
  if (interruption.interrupted())
    return 130
  resources.producerIntent()
  let pid: number | undefined
  const result = await runTracked(interruption, command, args, { cwd: REPO_ROOT, onSpawn: (value) => {
    pid = value
    resources.producerStarted(value)
  } })
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
  if (await bounded('docker', ['info', '--format', '{{.ID}}']) !== daemon.id)
    throw new Error('linux-daemon-changed')
  const containers = []
  for (const [name, id] of created) {
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
  const database = databaseStarted ? size(await bounded('docker', ['exec', `${settings.project}-db`, 'du', '-sk', '/var/lib/postgresql'])) : 0
  const filesystem = statfsSync(scratch)
  const sample: BudgetSample = { scratch: scratchBytes, writable: containers.reduce((sum, item) => sum + item.writable, 0), database, image: imageBytes, available: filesystem.bavail * filesystem.bsize }
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
      await createContainer(['create', '--pull=never', '--platform=linux/arm64', ...labels, '--name', `${settings.project}-node`, NODE_IMAGE], `${settings.project}-node`)
      mkdirSync(join(scratch, 'node'))
      await requireRun('docker', ['cp', `${settings.project}-node:/usr/local/.`, join(scratch, 'node')])
      writeFileSync(settings.envFile, `POSTGRES_PASSWORD=${settings.passwords.admin}\nNERVE_TEST_DATABASE_URL=postgres://postgres:${settings.passwords.admin}@db:5432/postgres\n`, { flag: 'wx', mode: 0o600 })
      await createContainer(plan.database, `${settings.project}-db`)
      await requireRun('docker', ['start', `${settings.project}-db`])
      databaseStarted = true
      const deadline = Date.now() + 60_000
      while (query(['inspect', '--format', '{{.State.Health.Status}}', `${settings.project}-db`]) !== 'healthy') {
        if (interruption.interrupted() || Date.now() >= deadline)
          throw new Error('linux-db-not-ready')
        await delay(500)
      }
      holdEvidence()
      await createContainer(plan.runner, `${settings.project}-runner`)
      const status = await owned('docker', ['start', '--attach', `${settings.project}-runner`])
      const guest = measuredContainer.parse(parseContainerJson(query(['container', 'inspect', '--size', '--format', containerFormat, `${settings.project}-runner`])))
      if (guest.id !== created.get(`${settings.project}-runner`))
        throw new Error('linux-guest-replaced')
      write('guest-exit.json', { clientStatus: status, guest })
      return guestExitStatus(status, guest)
    },
    async close() {
      stopMonitor = true
      await monitor
      if (reserved) {
        try {
          await measure()
        }
        catch (error) {
          stopReason ??= error instanceof Error && ['container-oom', 'environment-budget', 'disk-reserve'].includes(error.message) ? error.message : 'resource-measurement-failed'
          interruption.receive()
        }
      }
      // Docker removal is required even when its client exited successfully.
      return !reserved || resources.cleanup()
    },
    async collect() {
      for (const name of ['source.json', 'host-patches.json']) {
        const path = join(scratch, name)
        if (existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 16 * 1024 ** 2)
          copyFileSync(path, join(logDirectory, name))
      }
      const small = ['versions.json', 'patches-before.json', 'patches-after.json', 'source-before.json', 'source-after.json', 'execution.json']
      for (const name of small) {
        const path = join(scratch, 'evidence', name)
        if (existsSync(path)) {
          if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 ** 2)
            throw new Error('linux-evidence-file')
          copyFileSync(path, join(logDirectory, name))
        }
      }
      // Host proof after the run is read-only. Cleanup/report collection remains
      // possible after interruption, so these do not use the interrupted producer API.
      const verification = spawnSync('python3', ['-B', evidenceTool, 'verify', '--repo', REPO_ROOT, '--manifest', join(scratch, 'source.json'), '--output', join(logDirectory, 'host-source-after.json')], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 30_000 })
      const collection = spawnSync('python3', ['-B', evidenceTool, 'collect', '--repo', scratch, '--output', logDirectory, '--run-id', runId], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 60_000 })
      const summaryFile = join(logDirectory, 'groups.json')
      if (existsSync(evidenceHold) && existsSync(summaryFile)) {
        const summary = z.object({ version: z.literal(1), safeToRelease: z.boolean() }).parse(parseContainerJson(readFileSync(summaryFile, 'utf8')))
        if (summary.safeToRelease) {
          if (lstatSync(evidenceHold).isSymbolicLink() || readFileSync(evidenceHold, 'utf8') !== evidenceHoldBytes)
            throw new Error('linux-evidence-hold-changed')
          unlinkSync(evidenceHold)
          syncDirectory()
        }
      }
      if (verification.status !== 0 || collection.status !== 0)
        throw new Error('linux-evidence-incomplete')
    },
    async release(closed) {
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
  console.log(`Linux Chromium 校准：退出 ${result.status}，容器闭合 ${result.closed}，镜像处置 ${result.cacheReleased}`)
  process.exitCode = interruption.interrupted() ? 130 : result.status
}

void main().catch(() => {
  console.error('Linux 校准入口异常；保留父运行器诊断')
  process.exitCode = 1
})

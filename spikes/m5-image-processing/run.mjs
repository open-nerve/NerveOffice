import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditFixtures } from './audit.mjs'

const [runtimeArg, outputArg, ...flags] = process.argv.slice(2)
assert(runtimeArg && outputArg, 'usage: run.mjs RUNTIME NEW_OUTPUT [--small]')
const runtime = resolve(runtimeArg)
const output = resolve(outputArg)
const addressMiB = Number(flags.find(flag => flag.startsWith('--address-mib='))?.split('=')[1] ?? 0)
assert(!addressMiB || (process.platform === 'linux' && Number.isInteger(addressMiB) && addressMiB >= 1024 && addressMiB <= 2048), 'invalid Linux address-space experiment')
const root = fileURLToPath(new URL('.', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const all = await auditFixtures(join(root, 'fixtures'))
const cases = all.filter(row => !flags.includes('--small') || !row.large)
const lockSha256 = hash(await readFile(join(runtime, 'pnpm-lock.yaml')))
const manifestSha256 = hash(await readFile(join(root, 'fixtures/manifest.json')))
await mkdir(output, { recursive: false })
// Persist exact probe sources, manifest and inputs before execution. Later
// changes must not make a failed experiment impossible to reconstruct.
await cp(root, join(output, 'source'), { recursive: true })
await cp(join(runtime, 'pnpm-lock.yaml'), join(output, 'runtime-lock.yaml'))
const sources = {}
for (const name of await readdir(root)) {
  if (/\.(mjs|py)$/.test(name))
    sources[name] = hash(await readFile(join(root, name)))
}
const results = []
const startedAt = new Date().toISOString()

function execute(row, fault) {
  return new Promise((done) => {
    const started = performance.now()
    const command = ['--jitless', '--max-old-space-size=128', '--max-semi-space-size=16', ...(fault
      ? [join(root, 'fault.child.mjs'), fault]
      : [join(root, 'process.mjs'), runtime, row.file, join(output, `${row.id}.image`), row.declaredType, row.extension])]
    const executable = addressMiB ? '/usr/bin/prlimit' : process.execPath
    const args = addressMiB ? [`--as=${addressMiB * 1024 * 1024}:${addressMiB * 1024 * 1024}`, '--', process.execPath, ...command] : command
    const child = spawn(executable, args, {
      cwd: root, env: { MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '1', VIPS_DISC_THRESHOLD: '256m' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', reason
    const timer = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL') }, 5_000)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > 1024 * 1024) { reason = 'protocol'; child.kill('SIGKILL') }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 65536) })
    child.on('error', error => { reason = String(error) })
    // Do not release a slot on timeout until the process and its pipes close.
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let result
      try { result = JSON.parse(stdout) }
      catch { result = { status: 'failed', reason: reason ?? 'missing-result' } }
      done({ ...result, elapsedMs: performance.now() - started, exitCode: code, signal, parentFailure: reason, stdout, stderr })
    })
  })
}

function check(row, actual) {
  assert.equal(actual.exitCode, 0, `process exit: ${actual.parentFailure ?? actual.signal}`)
  assert.equal(actual.status, row.expected.status, `status: ${actual.reason ?? ''}`)
  if (row.expected.status === 'reject') {
    assert.equal(actual.reason, row.expected.reason, 'rejection reason')
    return
  }
  for (const key of ['width', 'height', 'frames'])
    assert.equal(actual[key], row.expected[key], key)
  assert(actual.outputBytes > 0 && actual.outputBytes <= 5 * 1024 * 1024, 'output bytes')
  assert.deepEqual(actual.privateMetadata, [], 'private metadata survived')
  if (row.expected.frames > 1) {
    assert.deepEqual(actual.delay, row.expected.delay, 'animation delay')
    assert.equal(actual.loop, row.expected.loop, 'animation loop')
  }
  if (row.expected.rgbaSha256)
    assert.deepEqual(actual.rgbaSha256, row.expected.rgbaSha256, 'lossless pixels')
  const tolerance = row.declaredType === 'image/jpeg' ? 25 : row.declaredType === 'image/webp' ? 15 : 0
  for (let frame = 0; frame < row.expected.points.length; frame++) {
    for (let point = 0; point < row.expected.points[frame].length; point++) {
      const wanted = row.expected.points[frame][point].rgba
      const got = actual.points[frame][point]
      assert(got.length === 4 && got.every((v, channel) => Math.abs(v - wanted[channel]) <= tolerance), `frame ${frame} point ${point}: ${got} != ${wanted}`)
    }
  }
}

for (const row of cases) {
  const actual = await execute(row)
  let failure
  try { check(row, actual) }
  catch (error) { failure = String(error) }
  const record = { id: row.id, inputSha256: row.sha256, expected: row.expected, actual, passed: !failure, failure }
  await writeFile(join(output, `${row.id}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  results.push({ id: row.id, passed: !failure, failure, elapsedMs: actual.elapsedMs, maxRssKiB: actual.maxRssKiB })
  console.log(`${failure ? 'FAIL' : 'PASS'} ${row.id}: ${actual.status}/${actual.reason ?? actual.outputBytes} ${actual.elapsedMs.toFixed(0)}ms ${actual.maxRssKiB ?? '?'}KiB${failure ? ` ${failure}` : ''}`)
}
const faults = []
if (flags.includes('--faults')) {
  for (const fault of ['timeout', 'crash', ...(addressMiB ? ['address-limit'] : [])]) {
    const actual = await execute({}, fault)
    const passed = fault === 'timeout'
      ? actual.parentFailure === 'timeout' && actual.signal === 'SIGKILL'
      : fault === 'crash' ? actual.exitCode === 17
        : actual.exitCode === 0 && actual.refused === true
    const recoveryRow = { ...all.find(row => row.id === 'minimum'), id: `after-${fault}` }
    const recovery = await execute(recoveryRow)
    let recoveryPassed = true
    try { check(recoveryRow, recovery) }
    catch { recoveryPassed = false }
    const record = { fault, passed: passed && recoveryPassed, actual, recovery }
    await writeFile(join(output, `fault-${fault}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    faults.push({ fault, passed: record.passed })
    console.log(`${record.passed ? 'PASS' : 'FAIL'} ${fault} followed by normal image`)
  }
}
const cgroup = {}
for (const name of ['memory.max', 'memory.peak', 'memory.events', 'cpu.max']) {
  try { cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim() }
  catch { /* macOS has no cgroup; do not invent a value. */ }
}
const summary = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, sampleSet: flags.includes('--small') ? 'small' : 'all', sources,
  lockSha256, manifestSha256,
  limits: { inputBytes: 5 * 1024 * 1024, outputBytes: 5 * 1024 * 1024, pixels: 16_000_000, totalPixels: 32_000_000, side: 8192, frames: 100, deadlineMs: 5_000, heapMiB: 128, semiSpaceMiB: 16, jitless: true, addressMiB, discThreshold: '256m' }, cgroup, results, faults, passed: results.every(r => r.passed) && faults.every(f => f.passed) }
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
process.exitCode = summary.passed ? 0 : 1

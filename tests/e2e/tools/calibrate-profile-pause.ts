// 只校准原生程序内部创建的 /bin/sleep；不接受外部目标 PID，不操作 Safari。
import type { Readable } from 'node:stream'
import type { PauseEvent } from '../safari/profile-pause.ts'
import type { ProfilePageContext, ProfilePageTarget } from '../safari/profile-process.ts'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { compileProfilePause, createPauseChannel, startProfilePause } from '../safari/profile-pause-adapter.ts'
import { createPauseRecord, pauseEvent } from '../safari/profile-pause.ts'

const bootstrap = z.strictObject({
  target: z.strictObject({ pid: z.number().int().positive(), uid: z.number().int().nonnegative(), ppid: z.number().int().positive(), startedAtUs: z.string().regex(/^\d{10,20}$/), executable: z.literal('/bin/sleep') }),
  observedAt: z.number().int().positive(),
})
type Bootstrap = z.infer<typeof bootstrap>
const cases = ['normal', 'deadline', 'eof', 'invalid-command', 'oversized-input', 'output-closed', 'sigterm', 'sigint', 'sighup', 'user-activity', 'screen-locked', 'desktop-unavailable', 'clock-changed', 'target-exited', 'externally-resumed', 'initial-stopped', 'production-refusal'] as const
type Case = typeof cases[number] | 'controller-death'

async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

function pageTarget(info: Bootstrap, url: string): ProfilePageTarget {
  return { ...info.target, bundleId: 'calibration-owned-sleep', asn: 'calibration-owned-sleep', appleSigned: false, url, windowId: 1, profileName: '自有空进程校准', observedAt: info.observedAt }
}

function kernelState(info: Bootstrap, guardianPid: number): string | undefined {
  let text: string
  try {
    text = execFileSync('/bin/ps', ['-p', String(info.target.pid), '-o', 'pid=,ppid=,uid=,state='], { encoding: 'utf8', timeout: 2000 }).trim()
  }
  catch (error) {
    const failure = error as { status?: unknown, stdout?: unknown }
    if (failure.status === 1 && typeof failure.stdout === 'string' && failure.stdout.trim() === '')
      return undefined
    throw error
  }
  const [pid, ppid, uid, state] = text.split(/\s+/)
  assert.equal(Number(pid), info.target.pid)
  assert.equal(Number(ppid), guardianPid)
  assert.equal(Number(uid), process.getuid!())
  return state
}

function lines(stream: Readable, receive: (value: unknown) => void, fail: (error: Error) => void) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 16_384) {
      fail(new Error('校准输出超限'))
      return
    }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0)
        break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        receive(JSON.parse(line))
      }
      catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
  stream.on('end', () => {
    if (buffer !== '')
      fail(new Error('校准输出被截断'))
  })
}

async function waitJournal(path: string): Promise<PauseEvent[]> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const content = await readFile(path, 'utf8')
    try {
      const events = content.trim().split('\n').filter(Boolean).map(line => pauseEvent.parse(JSON.parse(line)))
      if (events.at(-1)?.kind === 'finished')
        return events
    }
    catch { /* 只在原生写完并 fsync 后才出现完整终态；不接纳半条记录。 */ }
    await delay(20)
  }
  throw new Error('独立 journal 没有在期限内完成')
}

async function runCase(binary: string, directory: string, name: Case) {
  await mkdir(directory, { mode: 0o700 })
  const journalPath = join(directory, 'native.jsonl')
  const cleanupPath = join(directory, 'owner-cleanup.json')
  const journal = openSync(journalPath, 'wx', 0o600)
  const cleanup = openSync(cleanupPath, 'wx', 0o600)
  const child = spawn(binary, [name], { detached: true, stdio: ['pipe', 'pipe', 'pipe', journal, 'pipe', cleanup] })
  closeSync(journal)
  closeSync(cleanup)
  assert(child.pid !== undefined)
  const guardianPid = child.pid
  const channel = createPauseChannel({
    guardianPid,
    now: Date.now,
    send: value => child.stdin!.write(`${JSON.stringify(value)}\n`),
    close: () => { child.stdin!.end() },
  })
  let stderr = ''
  child.stderr!.on('data', (value: Buffer) => {
    stderr = (stderr + value.toString()).slice(-8192)
  })
  child.stdin!.on('error', error => channel.fail(error))
  child.once('error', error => channel.fail(error))
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      channel.exited(code, signal)
      resolve({ code, signal })
    })
  })
  const metadata = new Promise<Bootstrap>((resolve, reject) => {
    lines(child.stdio[4] as Readable, value => resolve(bootstrap.parse(value)), reject)
    child.once('close', () => reject(new Error('原生程序未发送自有目标身份即退出')))
  })
  lines(child.stdout!, channel.receive, channel.fail)
  let completed = false
  try {
    const [info] = await within(Promise.all([metadata, channel.ready]), 5000, '自有目标或守护者没有就绪')
    assert.equal(info.target.ppid, guardianPid)
    assert.equal(info.target.uid, process.getuid!())
    const url = `http://127.0.0.1:5001/calibration/${randomUUID()}`
    const target = pageTarget(info, url)
    const context: ProfilePageContext = { url, uid: info.target.uid, mainPid: process.pid, deadline: Date.now() + (name === 'deadline' ? 600 : 4000), profile: { name: target.profileName, windowId: 1, axWindowUuid: randomUUID(), exclusiveFromCreation: true, extensionsDisabled: true, createdAt: info.observedAt - 1, baseline: { capturedAt: info.observedAt - 2, pids: [process.pid] } } }
    let pausedState: string | undefined
    let productionRefusal: unknown
    if (name === 'production-refusal') {
      const production = startProfilePause(join(dirname(binary), 'profile-pause-native'), join(directory, 'production-refused-sleep.jsonl'))
      await production.ready
      await assert.rejects(production.stop(context, target))
      const refused = await production.finished
      assert.equal(refused.reason, 'initial-refused')
      assert.equal(refused.target, null)
      assert.equal(refused.stopSignals, 0)
      assert.equal(refused.continueSignals, 0)
      assert.equal(refused.stoppedConfirmed, false)
      assert.equal(refused.resumedConfirmed, false)
      productionRefusal = refused
      const untouched = kernelState(info, guardianPid)
      assert(untouched !== undefined && !untouched.startsWith('T'), '正式入口错误地接受了校准目标')
      channel.close()
    }
    else {
      const stopped = channel.stop(context, target)
      if (name === 'initial-stopped') {
        await assert.rejects(stopped)
      }
      else {
        await stopped
        pausedState = kernelState(info, guardianPid)
        assert(pausedState?.startsWith('T'), '独立 ps 没有看到实际停止')
        if (name === 'controller-death') {
          assert(process.send !== undefined)
          process.send({ kind: 'owned-controller-stopped', info, guardianPid, url, deadline: context.deadline })
          // 专用子驱动在这里被父级实际 SIGKILL；不运行 finally，不替守护者关闭输入。
          await new Promise<never>(() => {})
        }
        else if (name === 'normal') {
          channel.resume()
        }
        else if (name === 'eof') {
          channel.close()
        }
        else if (name === 'invalid-command') {
          child.stdin!.write('{"kind":"resume","extra":true}\n')
        }
        else if (name === 'oversized-input') {
          child.stdin!.write('x'.repeat(9000))
        }
        else if (name === 'output-closed') {
          child.stdout!.destroy()
        }
        else if (name === 'sigterm' || name === 'sigint' || name === 'sighup') {
          assert(child.kill(({ sigterm: 'SIGTERM', sigint: 'SIGINT', sighup: 'SIGHUP' } as const)[name]))
        }
        else if (name === 'target-exited' || name === 'externally-resumed') {
          process.kill(info.target.pid, name === 'target-exited' ? 'SIGKILL' : 'SIGCONT')
        }
      }
    }
    const events = await waitJournal(journalPath)
    const final = events.at(-1)
    assert(final?.kind === 'finished')
    const record = createPauseRecord({ guardianPid, target, deadline: context.deadline })
    assert(events.every(event => record.receive(event)), record.snapshot().problems.join(';'))
    const expected = name === 'normal' ? 'requested' : name === 'eof' || name === 'production-refusal' ? 'controller-eof' : name.startsWith('sig') ? 'controller-signal' : name === 'oversized-input' ? 'invalid-command' : name === 'output-closed' ? 'output-unavailable' : name === 'initial-stopped' ? 'initial-refused' : name
    assert.equal(final.reason, expected)
    const afterState = kernelState(info, guardianPid)
    const noContinue = ['initial-stopped', 'target-exited', 'externally-resumed', 'production-refusal'].includes(name)
    assert.equal(final.stopSignals, name === 'initial-stopped' || name === 'production-refusal' ? 0 : 1)
    assert.equal(final.continueSignals, noContinue ? 0 : 1)
    assert.equal(final.resumedConfirmed, !noContinue)
    assert.equal(record.snapshot().normalCompletion, name === 'normal')
    if (name === 'initial-stopped') {
      assert(afterState?.startsWith('T'), '守护者恢复了他方先前暂停的进程')
    }
    else if (name === 'target-exited') {
      assert.equal(afterState, undefined)
    }
    else {
      assert(afterState !== undefined && !afterState.startsWith('T'), '原生回执之后自有目标消失或仍然停止')
    }
    const exit = await exited
    assert.deepEqual(exit, { code: 0, signal: null }, stderr)
    const ownerCleanup: unknown = JSON.parse(await readFile(cleanupPath, 'utf8'))
    assert.deepEqual(ownerCleanup, { reaped: true, cleanupContinueSignals: name === 'initial-stopped' ? 1 : 0 })
    assert.equal(kernelState(info, guardianPid), undefined, '自有子进程没有回收')
    const result = { name, passed: true, guardianPid, target: info.target, pausedState, afterState, events, exit, ownerCleanup, productionRefusal }
    await writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    completed = true
    return result
  }
  finally {
    if (!completed) {
      channel.close()
      await within(exited, 12_000, '校准守护者清理逾期').catch(() => {})
      await writeFile(join(directory, 'failure.json'), `${JSON.stringify({ stderr, exitCode: child.exitCode, signal: child.signalCode })}\n`, { flag: 'wx' })
    }
  }
}

async function runControllerDeath(directory: string) {
  const child = fork(fileURLToPath(import.meta.url), ['--owned-controller', directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  child.stdout!.resume()
  child.stderr!.on('data', (value: Buffer) => {
    stderr += value.toString()
  })
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const message = z.strictObject({ kind: z.literal('owned-controller-stopped'), info: bootstrap, guardianPid: z.number().int().positive(), url: z.string(), deadline: z.number().int().positive() })
  const prepared = new Promise<z.infer<typeof message>>((resolve, reject) => {
    child.once('message', (value) => {
      const parsed = message.safeParse(value)
      if (parsed.success)
        resolve(parsed.data)
      else
        reject(parsed.error)
    })
    child.once('error', reject)
    child.once('close', () => reject(new Error(`专用控制端未完成暂停即退出：${stderr}`)))
  })
  try {
    const { info, guardianPid, url, deadline } = await within(prepared, 6000, '专用控制端未完成实际暂停')
    const pausedState = kernelState(info, guardianPid)
    assert(pausedState?.startsWith('T'), '终止 Node 之前没有独立观察到停止')
    const killedAt = Date.now()
    assert(child.kill('SIGKILL'), '无法终止本轮创建的专用 Node 控制端')
    assert.deepEqual(await within(exited, 3000, '专用控制端未退出'), { code: null, signal: 'SIGKILL' })
    const caseDirectory = join(directory, 'controller-death')
    const events = await waitJournal(join(caseDirectory, 'native.jsonl'))
    const final = events.at(-1)
    assert(final?.kind === 'finished')
    const record = createPauseRecord({ guardianPid, target: pageTarget(info, url), deadline })
    assert(events.every(event => record.receive(event)), record.snapshot().problems.join(';'))
    // 控制进程死亡时两条管道同时关闭，先观察到哪一条不影响独立恢复义务。
    assert(['controller-eof', 'output-unavailable'].includes(final.reason))
    assert.equal(final.stopSignals, 1)
    assert.equal(final.continueSignals, 1)
    assert.equal(final.resumedConfirmed, true)
    assert.equal(record.snapshot().normalCompletion, false)
    assert(final.continueAt !== null && final.continueAt >= killedAt && final.continueAt - killedAt < 1500)
    const afterState = kernelState(info, guardianPid)
    assert(afterState !== undefined && !afterState.startsWith('T'), 'Node 死亡后目标没有由守护者恢复')
    let ownerCleanup: unknown
    const cleanupDeadline = Date.now() + 8000
    while (Date.now() < cleanupDeadline) {
      try {
        ownerCleanup = JSON.parse(await readFile(join(caseDirectory, 'owner-cleanup.json'), 'utf8'))
        break
      }
      catch { await delay(30) }
    }
    assert.deepEqual(ownerCleanup, { reaped: true, cleanupContinueSignals: 0 })
    assert.equal(kernelState(info, guardianPid), undefined, '空进程没有由其原生父进程回收')
    const result = { name: 'controller-death', passed: true, controllerPid: child.pid, guardianPid, target: info.target, killedAt, pausedState, afterState, events, ownerCleanup }
    await writeFile(join(caseDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    return result
  }
  finally {
    // 只可结束本函数创建的专用控制进程；守护者始终靠独立 EOF / 期限恢复，不向它发 kill。
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
}

async function main() {
  if (process.argv[2] === '--owned-controller' && process.argv.length === 4 && process.send !== undefined) {
    const directory = resolve(process.argv[3]!)
    await runCase(join(directory, 'profile-pause-calibration'), join(directory, 'controller-death'), 'controller-death')
    return
  }
  assert(process.platform === 'darwin' && process.argv.length === 3, '需要 macOS 与一个全新校准输出目录；不接受目标 PID')
  const directory = resolve(process.argv[2]!)
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const source = (name: string) => fileURLToPath(new URL(`../safari/${name}`, import.meta.url))
  const production = join(directory, 'profile-pause-native')
  const calibration = join(directory, 'profile-pause-calibration')
  const files = ['profile-native-core.swift', 'profile-pause-core.swift', 'profile-pause-native.swift', 'profile-pause-calibration.swift']
  compileProfilePause(production)
  execFileSync('swiftc', [source(files[0]!), source(files[1]!), source(files[3]!), '-o', calibration], { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const hashes: Record<string, string> = {}
  const inputs = [...files.map(source), source('profile-pause.ts'), source('profile-pause-adapter.ts'), source('profile-process.ts'), fileURLToPath(import.meta.url), production, calibration]
  for (const file of inputs)
    hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex')
  await writeFile(join(directory, 'source.json'), `${JSON.stringify(hashes, null, 2)}\n`, { flag: 'wx' })
  const refusal = startProfilePause(production, join(directory, 'production-no-target.jsonl'))
  await refusal.ready
  refusal.close()
  const refused = await refusal.finished
  assert.equal(refused.stopSignals, 0)
  assert.equal(refused.continueSignals, 0)
  assert.equal(refused.reason, 'controller-eof')
  const results: { name: Case, passed: boolean, reason: PauseEvent | undefined }[] = []
  for (const name of cases) {
    const result = await runCase(calibration, join(directory, name), name)
    results.push({ name, passed: true, reason: result.events.at(-1) })
    process.stdout.write(`${JSON.stringify({ name, passed: true })}\n`)
  }
  const death = await runControllerDeath(directory)
  results.push({ name: 'controller-death', passed: true, reason: death.events.at(-1) })
  process.stdout.write(`${JSON.stringify({ name: 'controller-death', passed: true })}\n`)
  for (const file of inputs)
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hashes[file], `校准期间输入改变：${file}`)
  await writeFile(join(directory, 'completed.json'), `${JSON.stringify({ storageExperiment: false, realSafari: false, sourceUnchanged: true, productionRefusedWithoutTarget: refused, cases: results }, null, 2)}\n`, { flag: 'wx' })
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

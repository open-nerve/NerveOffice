// Linux 真实进程契约；node --test 直接执行，不启动浏览器、数据库或构建。
import type { ChildProcess } from 'node:child_process'
import type { Mode, OpenMode, PathLike } from 'node:fs'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, mock, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { failureStageSchema, inspectProcessOperation, processDiagnostic } from './e2e-diagnostics.ts'
import { OWNER_VARIABLE, parseProcessStat, prepareRun, readProcess, recordProcessFailure, runOwnedCommand, settleRun, snapshotDiagnostics } from './e2e-process.ts'

assert.equal(process.platform, 'linux', '真实进程契约必须在 Linux 运行；macOS 不能以跳过代替通过')
const moduleUrl = new URL('./e2e-process.ts', import.meta.url).href
const ownerPreload = new URL('../../../tests/e2e/support/ci-process-owner.ts', import.meta.url).href
const directories: string[] = []
const children: ChildProcess[] = []
const extraPids: number[] = []
const owners: { directory: string, root: string }[] = []

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check())
      return
    await delay(20)
  }
  assert.fail('真实子进程未在 6 秒内达到观察点')
}

function running(pid: number): boolean {
  try {
    const row = parseProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), process.getuid?.() ?? -1)
    return row !== undefined && !['Z', 'X'].includes(row.state)
  }
  catch { return false }
}

function fixture(runMs = 200, cleanupMs = 600): { root: string, directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'nerve-ci-process-'))
  directories.push(root)
  const directory = join(root, 'owner')
  prepareRun(directory, root, { runMs, cleanupMs, forceMs: 2000, pollMs: 20 })
  owners.push({ directory, root })
  return { root, directory }
}

function start(root: string, directory: string, code: string): { child: ChildProcess, exit: Promise<number> } {
  const leader = join(root, 'leader.cjs')
  const runner = join(root, 'runner.mjs')
  writeFileSync(leader, code)
  writeFileSync(runner, `import {runOwnedCommand} from ${JSON.stringify(moduleUrl)};
const result=await runOwnedCommand(${JSON.stringify(directory)},${JSON.stringify(root)},process.execPath,[${JSON.stringify(leader)}],{cwd:${JSON.stringify(root)}});process.exit(result.exitCode);`)
  const child = spawn(process.execPath, [runner], { stdio: 'inherit', detached: true })
  children.push(child)
  return { child, exit: new Promise(resolve => child.once('exit', code => resolve(code ?? 1))) }
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}
function pid(path: string): number {
  const value = Number(readFileSync(path, 'utf8'))
  extraPids.push(value)
  return value
}

/** 仅在指定 /proc stat 的底层 open 注入 I/O 故障；归属、停止、持久化均为真实实现。 */
function failProcOpen(target: number, after = 1): () => void {
  const native = fs.openSync
  let attempts = 0
  const replacement = mock.method(fs, 'openSync', (path: PathLike, flags: OpenMode, mode?: Mode) => {
    if (path === `/proc/${target}/stat` && ++attempts >= after)
      throw Object.assign(new Error('synthetic-private-message'), { code: 'EIO' })
    return native(path, flags, mode)
  })
  syncBuiltinESMExports()
  return () => {
    replacement.mock.restore()
    syncBuiltinESMExports()
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
  for (const owner of owners.splice(0))
    await settleRun(owner.directory, owner.root)
  for (const value of extraPids.splice(0)) {
    try {
      process.kill(value, 'SIGKILL')
    }
    catch {}
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

void test('正常退出保持真实退出码，结束后才给归档许可；失败命令不被改为通过', { timeout: 10_000 }, async () => {
  for (const code of [0, 7]) {
    const { root, directory } = fixture(2000)
    assert.equal(await start(root, directory, `process.exit(${code})`).exit, code)
    assert.deepEqual(json(join(directory, 'result.json')), { exitCode: code, stopped: false, forced: false, quiescent: true })
    assert.deepEqual(await settleRun(directory, root), { quiescent: true, forced: false })
  }
})

void test('运行预算到期只软停止一次；重复外层信号不抢走独立的报告/夹具收尾预算', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(300, 1600)
  const signals = join(root, 'signals')
  const report = join(root, 'report')
  const started = start(root, directory, `const fs=require('node:fs');
process.on('SIGINT',()=>{fs.appendFileSync(${JSON.stringify(signals)},'I');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(report)},'complete');process.exit(0)},650)});setInterval(()=>{},1000);`)
  await until(() => existsSync(signals))
  started.child.kill('SIGTERM')
  started.child.kill('SIGHUP')
  assert.equal(await started.exit, 1)
  assert.equal(readFileSync(signals, 'utf8'), 'I')
  assert.equal(readFileSync(report, 'utf8'), 'complete')
  assert.deepEqual(json(join(directory, 'result.json')), { exitCode: 1, stopped: true, forced: false, quiescent: true })
})

void test('主进程先退出：另起进程组的写入者仍必须退出，不能沿用主进程成功码', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(2000, 350)
  const marker = join(root, 'writer.pid')
  const writes = join(root, 'writes')
  const writer = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'x'),20)`
  const started = start(root, directory, `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'});c.unref();`)
  await until(() => existsSync(marker))
  const writerPid = pid(marker)
  assert.equal(await started.exit, 1)
  assert.equal(running(writerPid), false)
  const finalWrites = readFileSync(writes, 'utf8')
  await delay(100)
  assert.equal(readFileSync(writes, 'utf8'), finalWrites)
  assert.deepEqual(json(join(directory, 'result.json')), { exitCode: 1, stopped: false, forced: true, quiescent: true })
})

void test('计算子进程清空环境后仍属于本轮；原父进程退出与重新挂到 init 不丢失所有权', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(2000, 400)
  const marker = join(root, 'unmarked.pid')
  const writer = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`
  const api = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{env:{},stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),300);`
  const started = start(root, directory, `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(api)}],{detached:true,stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),400);`)
  await until(() => existsSync(marker))
  const writerPid = pid(marker)
  assert.equal(await started.exit, 1)
  assert.equal(running(writerPid), false)
  assert.deepEqual(json(join(directory, 'result.json')), { exitCode: 1, stopped: false, forced: true, quiescent: true })
})

void test('忽略软停止会在独立清理预算后强制结束；不会无限等待 leader', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(300, 400)
  const marker = join(root, 'stubborn.pid')
  const started = start(root, directory, `process.on('SIGINT',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)
  await until(() => existsSync(marker))
  const writerPid = pid(marker)
  assert.equal(await started.exit, 1)
  assert.equal(running(writerPid), false)
  assert.deepEqual(json(join(directory, 'result.json')), { exitCode: 1, stopped: true, forced: true, quiescent: true })
})

void test('外层强杀监督器后，独立收尾入口按原身份软停止且等待实际退出', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(5000, 1000)
  const marker = join(root, 'ready')
  const report = join(root, 'report')
  const started = start(root, directory, `const fs=require('node:fs');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(report)},'closed');process.exit(0)},200));fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)
  await until(() => existsSync(marker))
  const writerPid = pid(marker)
  started.child.kill('SIGKILL')
  assert.equal(await started.exit, 1)
  assert.equal(running(writerPid), true)
  assert.deepEqual(await settleRun(directory, root), { quiescent: true, forced: false })
  assert.equal(running(writerPid), false)
  assert.equal(readFileSync(report, 'utf8'), 'closed')
  assert.equal(existsSync(join(directory, 'result.json')), false, '不得补造已被终止执行器的成功结果')
})

void test('另一运行/伪前缀标记与复用 PID 记录都不能授权结束无关进程', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(2000, 300)
  const owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')) as { token: string }
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, [`OTHER_${OWNER_VARIABLE}`]: owner.token } })
  children.push(sentinel)
  const sentinelPid = sentinel.pid ?? 0
  assert.ok(sentinelPid > 0)
  await until(() => running(sentinelPid))
  assert.equal(await start(root, directory, 'process.exit(0)').exit, 0)
  const runtime = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')) as { owned: unknown[] }
  runtime.owned.push({ ...parseProcessStat(readFileSync(`/proc/${sentinelPid}/stat`, 'utf8'), (process.getuid?.() ?? -1)), start: '0' })
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify(runtime))
  assert.deepEqual(await settleRun(directory, root), { quiescent: true, forced: false })
  assert.equal(running(sentinelPid), true)
  const wrongRoot = mkdtempSync(join(tmpdir(), 'nerve-other-worktree-'))
  directories.push(wrongRoot)
  await assert.rejects(settleRun(directory, wrongRoot), /不属于当前 worktree/)
  assert.equal(running(sentinelPid), true)
})

for (const [name, environment] of [
  ['计算池空环境', {}],
  ['图片处理白名单', { MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '1', VIPS_DISC_THRESHOLD: '256m' }],
] as const) {
  void test(`扫描暂停期间快速父退：${name} 后代仍必须被归属和收尾`, { timeout: 10_000 }, async () => {
    const { root, directory } = fixture(5000, 350)
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const marker = join(root, 'fast.pid')
    const worker = join(root, 'worker.cjs')
    const api = join(root, 'api.cjs')
    writeFileSync(worker, `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)
    writeFileSync(api, `const c=require('node:child_process').fork(${JSON.stringify(worker)},[],{env:${JSON.stringify(environment)},stdio:'ignore'});c.unref();process.exit(0);`)
    const started = start(root, directory, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){const c=require('node:child_process').spawn(process.execPath,['--import',${JSON.stringify(ownerPreload)},${JSON.stringify(api)}],{detached:true,stdio:'ignore'});c.unref();process.exit(0)}},10)`)
    await until(() => existsSync(ready))
    started.child.kill('SIGSTOP')
    writeFileSync(release, '')
    await until(() => existsSync(marker))
    const writerPid = pid(marker)
    await until(() => parseProcessStat(readFileSync(`/proc/${writerPid}/stat`, 'utf8'), process.getuid?.() ?? -1)?.parent === 1)
    started.child.kill('SIGCONT')
    assert.equal(await started.exit, 1, '必须拒绝仍有快速孤儿写入者的成功退出')
    assert.equal(running(writerPid), false)
  })
}

void test('诊断发布为静态白名单快照；原运行记录继续变化也不会影响上传或泄露外来字段', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(2000)
  assert.equal(await start(root, directory, 'process.exit(0)').exit, 0)
  assert.deepEqual(await settleRun(directory, root), { quiescent: true, forced: false })
  const runtime = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')) as Record<string, unknown>
  runtime.privateField = 'synthetic-credential-never-publish'
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify(runtime))
  let inspectionError: unknown
  try {
    inspectProcessOperation('read-environment', () => {
      throw Object.assign(new Error('synthetic-credential-never-publish'), { code: 'EIO', path: 'privateField' })
    }, 123)
  }
  catch (error) { inspectionError = error }
  recordProcessFailure(directory, root, 'run', inspectionError)
  recordProcessFailure(directory, root, 'settle', new Error('synthetic-credential-never-publish'))
  const failure = json(join(directory, 'failure-run.json')) as Record<string, unknown>
  failure.privateField = 'synthetic-credential-never-publish'
  writeFileSync(join(directory, 'failure-run.json'), JSON.stringify(failure))
  const snapshot = join(snapshotDiagnostics(directory, root), 'snapshot.json')
  const original = readFileSync(snapshot, 'utf8')
  const saved = JSON.parse(original) as Record<string, unknown>
  assert.deepEqual(saved.unavailable, [])
  assert.deepEqual(saved['failure-run.json'], { at: failure.at, stage: 'run', operation: 'read-environment', code: 'EIO', pid: 123 })
  assert.equal((saved['failure-settle.json'] as Record<string, unknown>).operation, 'unclassified')
  assert.equal('stop.json' in saved, false, '正常结束与静默确认不能制造停止记录')
  assert.equal('soft-stop.json' in saved, false)
  assert.equal(original.includes('synthetic-credential-never-publish'), false)
  assert.equal(original.includes('privateField'), false)
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ exitCode: 1, stopped: true, forced: true, quiescent: false }))
  assert.equal(readFileSync(snapshot, 'utf8'), original)
  assert.throws(() => snapshotDiagnostics(directory, root), /EEXIST/, '重复发布不得覆盖已有快照')
})

void test('可选停止记录损坏仍写入 unavailable，不能冒充正常缺席', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(2000)
  assert.equal(await start(root, directory, 'process.exit(0)').exit, 0)
  assert.deepEqual(await settleRun(directory, root), { quiescent: true, forced: false })
  writeFileSync(join(directory, 'stop.json'), '{')
  writeFileSync(join(directory, 'soft-stop.json'), JSON.stringify({ at: 'invalid' }))
  writeFileSync(join(directory, 'failure-run.json'), JSON.stringify({ at: 1, stage: 'settle', operation: 'read-process', code: 'EIO' }))
  writeFileSync(join(directory, 'failure-settle.json'), JSON.stringify({ at: 1, stage: 'settle', operation: 'read-process', code: 'ESECRET' }))
  try {
    const saved = json(join(snapshotDiagnostics(directory, root), 'snapshot.json')) as Record<string, unknown>
    assert.deepEqual(saved.unavailable, ['stop.json', 'soft-stop.json', 'failure-run.json', 'failure-settle.json'])
    assert.equal('stop.json' in saved, false)
    assert.equal('soft-stop.json' in saved, false)
  }
  finally {
    rmSync(join(directory, 'stop.json'))
    rmSync(join(directory, 'soft-stop.json'))
  }
})

void test('尚无启动记录不得签归档许可；已有独占目录与证据不得被下一轮覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nerve-ci-before-spawn-'))
  directories.push(root)
  const directory = join(root, 'owner')
  prepareRun(directory, root)
  const original = readFileSync(join(directory, 'owner.json'), 'utf8')
  await assert.rejects(settleRun(directory, root), /缺少本轮启动记录/)
  assert.equal(existsSync(join(directory, 'quiescence.json')), false)
  assert.throws(() => prepareRun(directory, root), /EEXIST/)
  assert.equal(readFileSync(join(directory, 'owner.json'), 'utf8'), original)
})

void test('真实 reader 从当前 Linux stat FD 取得 UID、PGID 和启动 tick', () => {
  const uid = process.getuid?.() ?? -1
  const actual = readProcess(process.pid, uid)
  const direct = parseProcessStat(readFileSync(`/proc/${process.pid}/stat`), uid, process.pid)
  assert.ok(actual !== undefined && direct !== undefined)
  assert.equal(actual.pid, process.pid)
  assert.equal(actual.uid, uid)
  assert.equal(actual.group, direct.group)
  assert.equal(actual.start, direct.start)
})

void test('启动身份读取未知时先拒绝，不创建 runtime 或启动产品进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nerve-ci-read-start-'))
  directories.push(root)
  const directory = join(root, 'owner')
  prepareRun(directory, root)
  const marker = join(root, 'must-not-start')
  const restore = failProcOpen(process.pid)
  try {
    await assert.rejects(runOwnedCommand(directory, root, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], { cwd: root }), (error: unknown) => {
      assert.deepEqual(processDiagnostic(error), { operation: 'open-process', code: 'EIO', pid: process.pid })
      return true
    })
    assert.equal(existsSync(join(directory, 'runtime.json')), false)
    assert.equal(existsSync(marker), false)
  }
  finally { restore() }
})

void test('settle 的全量扫描遇到未知 I/O 仍拒绝，不能把本用户未知进程算为空扫描', async () => {
  const { root, directory } = fixture(2000)
  assert.equal(await start(root, directory, 'process.exit(0)').exit, 0)
  const before = readFileSync(join(directory, 'runtime.json'), 'utf8')
  const restore = failProcOpen(process.pid)
  try {
    await assert.rejects(settleRun(directory, root))
    assert.equal(existsSync(join(directory, 'quiescence.json')), false)
    assert.equal(readFileSync(join(directory, 'runtime.json'), 'utf8'), before)
  }
  finally { restore() }
})

void test('signal 再读身份未知时不发送 SIGINT，也不签归档许可', { timeout: 10_000 }, async () => {
  const { root, directory } = fixture(5000, 600)
  const marker = join(root, 'ready')
  const signals = join(root, 'signals')
  const started = start(root, directory, `const fs=require('node:fs');process.on('SIGINT',()=>fs.writeFileSync(${JSON.stringify(signals)},'I'));fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)
  await until(() => existsSync(marker))
  const leader = pid(marker)
  started.child.kill('SIGKILL')
  assert.equal(await started.exit, 1)
  // 扫描取得完整身份；softStop 发信号前的第二次身份观察失败。
  const restore = failProcOpen(leader, 2)
  try {
    await assert.rejects(settleRun(directory, root), (error: unknown) => {
      assert.deepEqual(processDiagnostic(error), { operation: 'open-process', code: 'EIO', pid: leader })
      return true
    })
    assert.equal(existsSync(signals), false)
    assert.equal(existsSync(join(directory, 'quiescence.json')), false)
  }
  finally { restore() }
})

void test('parser 诊断经异常包装、阶段落盘与静态快照保持一致且不泄露 comm', async () => {
  const { root, directory } = fixture(2000)
  assert.equal(await start(root, directory, 'process.exit(0)').exit, 0)
  await settleRun(directory, root)
  const raw = readFileSync(`/proc/${process.pid}/stat`).toString()
  const bad = `${process.pid} (synthetic-private-comm) ?${raw.slice(raw.lastIndexOf(')') + 3)}`
  let caught: unknown
  try {
    inspectProcessOperation('list-processes', () => parseProcessStat(bad, process.getuid?.() ?? -1, process.pid))
  }
  catch (error) { caught = error }
  const diagnostic = processDiagnostic(caught)
  assert.equal(diagnostic.stat?.reason, 'invalid-state')
  for (const stage of failureStageSchema.options)
    recordProcessFailure(directory, root, stage, caught)
  const destination = snapshotDiagnostics(directory, root)
  const snapshot = json(join(destination, 'snapshot.json')) as Record<string, unknown>
  let bytes = 0
  for (const stage of failureStageSchema.options) {
    const name = `failure-${stage}.json`
    const saved = json(join(directory, name)) as Record<string, unknown>
    assert.deepEqual(saved.stat, diagnostic.stat)
    assert.deepEqual(snapshot[name], saved)
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 2048)
    bytes += Buffer.byteLength(JSON.stringify(saved))
  }
  assert.ok(bytes < 16 * 1024)
  assert.equal(readFileSync(join(destination, 'snapshot.json'), 'utf8').includes('synthetic-private-comm'), false)
})

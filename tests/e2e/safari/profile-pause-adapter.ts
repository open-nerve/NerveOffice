import type { PauseEvent, PauseFinished } from './profile-pause.ts'
import type { ProfilePageContext, ProfilePageTarget } from './profile-process.ts'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPauseRecord, pauseEvent, PROFILE_PAUSE_MAX_MS, PROFILE_PAUSE_READY_MS } from './profile-pause.ts'

type Ready = Extract<PauseEvent, { kind: 'ready' }>
type Stopped = Extract<PauseEvent, { kind: 'stopped' }>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // 任一路径都可主动中止；保留原 Promise 的拒绝供调用者 await，不制造未处理拒绝。
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** stdin 关闭就是恢复请求的最后保障；本层没有结束守护者的 kill 退路。 */
export function createPauseChannel(transport: { readonly guardianPid: number, readonly now: () => number, readonly send: (value: unknown) => void, readonly close: () => void }) {
  const ready = deferred<Ready>()
  const stopped = deferred<Stopped>()
  const finished = deferred<PauseFinished>()
  let failed: Error | undefined
  let readyEvent: Ready | undefined
  let record: ReturnType<typeof createPauseRecord> | undefined
  let finalEvent: PauseFinished | undefined
  let stopSeen = false
  let resumeRequested = false
  function fail(value: unknown): Error {
    if (failed !== undefined)
      return failed
    failed = value instanceof Error ? value : new Error(String(value))
    ready.reject(failed)
    stopped.reject(failed)
    finished.reject(failed)
    try {
      transport.close()
    }
    catch { /* 保留第一个错误；原生守护仍有独立期限。 */ }
    return failed
  }
  function receive(value: unknown): void {
    if (failed !== undefined)
      return
    const parsed = pauseEvent.safeParse(value)
    if (!parsed.success) {
      fail(new Error('原生暂停回执格式无效'))
      return
    }
    const event = parsed.data
    if (event.kind === 'ready') {
      if (readyEvent !== undefined || event.guardian.pid !== transport.guardianPid) {
        fail(new Error('守护者身份或就绪顺序不符'))
        return
      }
      readyEvent = event
      ready.resolve(event)
      return
    }
    if (readyEvent === undefined || finalEvent !== undefined || (record === undefined && (event.kind !== 'finished' || event.stopSignals !== 0 || event.continueSignals !== 0 || event.target !== null || event.stoppedConfirmed || event.resumedConfirmed || event.reason === 'requested'))) {
      fail(new Error('原生暂停回执顺序不符'))
      return
    }
    if (event.kind === 'finished' && event.reason === 'requested' && !resumeRequested) {
      fail(new Error('控制端没有请求本次恢复'))
      return
    }
    if (record !== undefined && !record.receive(event)) {
      fail(new Error(record.snapshot().problems.join('；')))
      return
    }
    if (event.kind === 'stopped') {
      stopSeen = true
      stopped.resolve(event)
    }
    else {
      finalEvent = event
      if (!stopSeen)
        stopped.reject(new Error(`原生程序没有确认暂停：${event.reason}`))
    }
  }
  return {
    ready: ready.promise,
    finished: finished.promise,
    fail,
    receive,
    async stop(context: ProfilePageContext, target: ProfilePageTarget): Promise<Stopped> {
      if (failed !== undefined)
        throw failed
      const now = transport.now()
      if (readyEvent === undefined || record !== undefined || finalEvent !== undefined || readyEvent.guardian.uid !== target.uid || now < target.observedAt || now - target.observedAt > 2000 || now >= context.deadline
        || target.pid === context.mainPid || target.pid === transport.guardianPid || target.uid !== context.uid || target.url !== context.url || target.windowId !== context.profile.windowId || target.profileName !== context.profile.name || !context.profile.exclusiveFromCreation || !context.profile.extensionsDisabled) {
        throw fail(new Error('暂停前未就绪、重复操作、观察过期或归属不符'))
      }
      record = createPauseRecord({ guardianPid: transport.guardianPid, target, deadline: context.deadline })
      if (!record.receive(readyEvent))
        throw fail(new Error('守护者的就绪证据无效'))
      const { pid, uid, startedAtUs, executable, bundleId, asn, appleSigned } = target
      try {
        transport.send({ kind: 'stop', target: { pid, uid, startedAtUs, executable, bundleId, asn, appleSigned }, mainPid: context.mainPid, observedAt: target.observedAt, deadline: context.deadline, maxPauseMs: PROFILE_PAUSE_MAX_MS })
      }
      catch (error) { throw fail(error) }
      return stopped.promise
    },
    resume(): void {
      if (failed !== undefined)
        throw failed
      if (!stopSeen || resumeRequested || finalEvent !== undefined)
        throw fail(new Error('尚未暂停、已结束或重复恢复请求'))
      resumeRequested = true
      try {
        transport.send({ kind: 'resume' })
      }
      catch (error) { throw fail(error) }
    },
    close: transport.close,
    exited(code: number | null, signal: NodeJS.Signals | null): void {
      if (failed !== undefined)
        return
      if (code !== 0 || signal !== null || finalEvent === undefined || (finalEvent.stopSignals === 1 && !finalEvent.resumedConfirmed)) {
        fail(new Error('原生守护异常退出、缺少终态或未确认恢复'))
        return
      }
      finished.resolve(finalEvent)
    },
  }
}

export function compileProfilePause(output: string): void {
  const source = ['profile-native-core.swift', 'profile-pause-core.swift', 'profile-pause-native.swift'].map(name => fileURLToPath(new URL(`./${name}`, import.meta.url)))
  execFileSync('swiftc', [...source, '-o', output], { timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 调用方先取得完整页面归属，再在 stop 前二次 capture/revalidate；原生还会独立检查签名/内核/桌面。 */
export function startProfilePause(binary: string, journalPath: string) {
  const fd = openSync(journalPath, 'wx', 0o600)
  let child
  try {
    child = spawn(binary, [], { detached: true, stdio: ['pipe', 'pipe', 'pipe', fd] })
  }
  finally { closeSync(fd) }
  const channel = createPauseChannel({
    guardianPid: child.pid ?? -1,
    now: Date.now,
    send: value => child.stdin!.write(`${JSON.stringify(value)}\n`),
    close: () => { child.stdin!.end() },
  })
  let buffer = ''
  const timer = setTimeout(() => channel.fail(new Error('原生守护未在独立总期限内退出')), PROFILE_PAUSE_READY_MS + PROFILE_PAUSE_MAX_MS + 10_000)
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (text: string) => {
    buffer += text
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0)
        break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > 8192) {
        channel.fail(new Error('原生回执超限'))
        return
      }
      try {
        channel.receive(JSON.parse(line))
      }
      catch (error) { channel.fail(error) }
    }
    if (Buffer.byteLength(buffer) > 8192)
      channel.fail(new Error('原生回执超限或缺少分隔'))
  })
  child.stderr!.resume()
  child.stdin!.on('error', error => channel.fail(error))
  child.once('error', error => channel.fail(error))
  child.once('close', (code, signal) => {
    clearTimeout(timer)
    if (buffer !== '')
      channel.fail(new Error('原生回执被截断'))
    channel.exited(code, signal)
  })
  return { ...channel, guardianPid: child.pid }
}

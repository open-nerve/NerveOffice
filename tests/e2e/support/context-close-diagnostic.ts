// 测试专用补证：不等待或替代原关闭，只观察固定用例的公开调用。
import type { BrowserContext, TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

const TITLE = '另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接'
const FILE = 'context-close-diagnostic.json'
const MAX_BYTES = 32 * 1024
const MAX_EVENTS = 64
type Method = 'context.close' | 'request.dispose' | 'tracing.stopChunk'
type Stage = Method | 'observer.registered' | 'context.closed' | 'browser.disconnected'
type Outcome = 'event' | 'start' | 'fulfilled' | 'rejected' | 'threw'
interface Entry {
  seq: number
  stage: Stage
  outcome: Outcome
  monotonicMs: number
  callId?: number
}

export function isContextCloseTarget(target: { file: string, title: string, project: string, retry: number }, enabled: string | undefined): boolean {
  return enabled === '1' && target.project === 'chrome' && target.title === TITLE
    && target.file.endsWith('/tests/e2e/specs/local-drafts/catalog-boundaries.spec.ts')
    && (target.retry === 0 || target.retry === 1)
}

function ownerFor(retry: number) {
  const runId = process.env.NERVE_TEST_RUN_ID
  const githubRunId = process.env.GITHUB_RUN_ID
  const githubRunAttempt = process.env.GITHUB_RUN_ATTEMPT
  const sha = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId ?? '')
    || !/^[1-9]\d{0,19}$/.test(githubRunId ?? '')
    || !/^[1-9]\d{0,5}$/.test(githubRunAttempt ?? '')
    || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    return undefined
  }
  return { runId, githubRunId, githubRunAttempt, sha, project: 'chrome', retry }
}

/** 同步登记开始事件；即使默认 fixture 在 provide 返回之后挂起，已写入的前缀仍存在。 */
export function watchContextCloseDiagnostic(context: BrowserContext, testInfo: TestInfo): void {
  if (!isContextCloseTarget({ file: testInfo.file, title: testInfo.title, project: testInfo.project.name, retry: testInfo.retry }, process.env.E2E_CONTEXT_CLOSE_DIAGNOSTIC))
    return
  let annotated = false
  const incomplete = (description: string): void => {
    if (annotated)
      return
    annotated = true
    // 不覆盖原浏览器异常，也不在 Promise 观察回调里制造新的拒绝。
    try {
      testInfo.annotations.push({ type: 'context-close-diagnostic-incomplete', description })
    }
    catch { /* 缺附件或缺少完整终态同样拒绝诊断接受。 */ }
  }
  const owner = ownerFor(testInfo.retry)
  if (owner === undefined) {
    incomplete('identity-unavailable')
    return
  }
  const events: Entry[] = []
  const reasons = new Set<string>()
  const pending = new Set<number>()
  let closed = false
  let closeFulfilled = false
  let stopped = false
  let callSequence = 0
  let detach = (): void => {}
  let write: (text: string) => void
  try {
    const path = testInfo.outputPath(FILE)
    if (!isAbsolute(path) || basename(path) !== FILE)
      throw new Error('invalid-output')
    const root = realpathSync(testInfo.project.outputDir)
    const parent = realpathSync(dirname(path))
    const inside = relative(root, parent)
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
      throw new Error('outside-output')
    const parentIdentity = lstatSync(parent)
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink())
      throw new Error('invalid-parent')
    const target = join(parent, FILE)
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let identity
    try {
      identity = fstatSync(fd)
      // 登记早于首条记录和方法包装；不调用 attach(path) 提前复制一个尚未完成的快照。
      testInfo.attachments.push({ name: 'context-close-diagnostic', path, contentType: 'application/json' })
    }
    finally { closeSync(fd) }
    let size = 0
    write = (text) => {
      const bytes = Buffer.from(text)
      if (bytes.length > MAX_BYTES)
        throw new Error('byte-limit')
      const parentNow = lstatSync(parent)
      if (parentNow.dev !== parentIdentity.dev || parentNow.ino !== parentIdentity.ino || !parentNow.isDirectory())
        throw new Error('parent-changed')
      // 替换成无 reader 的 FIFO 时也不能在 fstat 前阻塞，避免诊断反过来挂住原调用。
      const output = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const now = fstatSync(output)
        if (!now.isFile() || now.nlink !== 1 || now.dev !== identity.dev || now.ino !== identity.ino || now.size !== size)
          throw new Error('file-changed')
        ftruncateSync(output, 0)
        if (writeSync(output, bytes) !== bytes.length)
          throw new Error('partial-write')
        fsyncSync(output)
        size = bytes.length
      }
      finally { closeSync(output) }
    }
  }
  catch {
    incomplete('report-unavailable')
    return
  }

  const note = (stage: Stage, outcome: Outcome, callId?: number): void => {
    if (stopped)
      return
    try {
      if (events.length === MAX_EVENTS) {
        reasons.add('event-limit')
        stopped = true
        incomplete('event-limit')
      }
      else {
        events.push({ seq: events.length + 1, stage, outcome, monotonicMs: performance.now(), ...(callId === undefined ? {} : { callId }) })
      }
      const isIncomplete = !closed || !closeFulfilled || pending.size > 0 || reasons.size > 0
      write(JSON.stringify({ version: 1, owner, incomplete: isIncomplete, reasons: [...reasons], events }))
      if (stopped || !isIncomplete)
        detach()
    }
    catch {
      stopped = true
      incomplete('report-unavailable')
      detach()
    }
  }
  const finished = (stage: Method, callId: number, outcome: 'fulfilled' | 'rejected' | 'threw'): void => {
    pending.delete(callId)
    if (stage === 'context.close' && outcome === 'fulfilled')
      closeFulfilled = true
    if (outcome !== 'fulfilled')
      reasons.add('observed-call-failed')
    note(stage, outcome, callId)
  }
  const wrap = <Args extends unknown[], Result>(stage: Method, original: (...args: Args) => Promise<Result>) => {
    // eslint-disable-next-line ts/promise-function-async -- async 会替换原 Promise 并把同步异常转为拒绝；这里必须透明透传。
    return function (this: unknown, ...args: Args): Promise<Result> {
      const callId = ++callSequence
      pending.add(callId)
      note(stage, 'start', callId)
      let result: Promise<Result>
      try {
        result = original.apply(this, args)
      }
      catch (error) {
        finished(stage, callId, 'threw')
        throw error
      }
      try {
        void result.then(
          () => finished(stage, callId, 'fulfilled'),
          () => finished(stage, callId, 'rejected'),
        )
      }
      catch {
        reasons.add('observation-unavailable')
        incomplete('observation-unavailable')
      }
      return result
    }
  }
  note('observer.registered', 'event')
  if (stopped)
    return
  const request = context.request
  const tracing = context.tracing
  // eslint-disable-next-line ts/unbound-method -- 保存原方法供动态 this 的 apply 与原样恢复，不能预先绑定改变调用语义。
  const originalClose = context.close
  // eslint-disable-next-line ts/unbound-method -- 同上，包装器将原 this/参数透传。
  const originalDispose = request.dispose
  // eslint-disable-next-line ts/unbound-method -- 同上，包装器将原 this/参数透传。
  const originalStopChunk = tracing.stopChunk
  const close = wrap('context.close', originalClose)
  const dispose = wrap('request.dispose', originalDispose)
  const stopChunk = wrap('tracing.stopChunk', originalStopChunk)
  const browser = context.browser()
  const onClose = () => {
    closed = true
    note('context.closed', 'event')
  }
  const onDisconnect = () => {
    note('browser.disconnected', 'event')
    browser?.off('disconnected', onDisconnect)
  }
  detach = () => {
    try {
      if (context.close === close)
        context.close = originalClose
      if (request.dispose === dispose)
        request.dispose = originalDispose
      if (tracing.stopChunk === stopChunk)
        tracing.stopChunk = originalStopChunk
      context.off('close', onClose)
      browser?.off('disconnected', onDisconnect)
    }
    catch { incomplete('observer-release-unavailable') }
  }
  try {
    context.close = close
    request.dispose = dispose
    tracing.stopChunk = stopChunk
    context.on('close', onClose)
    browser?.on('disconnected', onDisconnect)
  }
  catch {
    incomplete('observer-unavailable')
    detach()
  }
}

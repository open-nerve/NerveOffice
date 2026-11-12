// 测试专用补证：不等待或替代原关闭，只观察固定用例的公开调用；同一开关下另记关闭前后的协议消息（context-close-protocol.ts）。
import type { BrowserContext, TestInfo } from '@playwright/test'
import type { ProtocolTapFactory } from './context-close-protocol.ts'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { startCloseProtocolRecorder, tapPlaywrightProtocol } from './context-close-protocol.ts'
import { createExclusiveReport } from './exclusive-report.ts'

const TITLE = '另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接'
const FILE = 'context-close-diagnostic.json'
const MAX_BYTES = 32 * 1024
const MAX_EVENTS = 64
/** 同一种关闭卡住先后出在 Chrome（CI95）与 Edge（#102）：两种完整浏览器都记 */
const PROJECTS: ReadonlySet<string> = new Set(['chrome', 'msedge'])
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
  return enabled === '1' && PROJECTS.has(target.project) && target.title === TITLE
    && target.file.endsWith('/tests/e2e/specs/local-drafts/catalog-boundaries.spec.ts')
    && (target.retry === 0 || target.retry === 1)
}

function ownerFor(retry: number, project: string) {
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
  return { runId, githubRunId, githubRunAttempt, sha, project, retry }
}

export interface ContextCloseDiagnosticOptions {
  /** 协议记录的接法；省略时接运行中的 Playwright，null 不记协议（只留公开调用的阶段） */
  readonly protocol?: ProtocolTapFactory | null
}

/** 同步登记开始事件；即使默认 fixture 在 provide 返回之后挂起，已写入的前缀仍存在。 */
export function watchContextCloseDiagnostic(context: BrowserContext, testInfo: TestInfo, options: ContextCloseDiagnosticOptions = {}): void {
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
  const owner = ownerFor(testInfo.retry, testInfo.project.name)
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
    // 登记早于首条记录和方法包装（见 exclusive-report.ts）。
    write = createExclusiveReport(testInfo, FILE, MAX_BYTES, 'context-close-diagnostic')
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
  const wrap = <Args extends unknown[], Result>(stage: Method, original: (...args: Args) => Promise<Result>, onStart?: () => void) => {
    // eslint-disable-next-line ts/promise-function-async -- async 会替换原 Promise 并把同步异常转为拒绝；这里必须透明透传。
    return function (this: unknown, ...args: Args): Promise<Result> {
      const callId = ++callSequence
      pending.add(callId)
      note(stage, 'start', callId)
      try {
        onStart?.()
      }
      catch { /* 协议记录自己登记不完整；不影响原调用。 */ }
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
  // 协议记录从这里开始（本条用例的页面都在这之后创建），context 关闭、浏览器断连或到兜底时限时自行释放。
  const protocol = options.protocol === null ? undefined : startCloseProtocolRecorder(context, testInfo, owner, options.protocol ?? tapPlaywrightProtocol)
  const request = context.request
  const tracing = context.tracing
  // eslint-disable-next-line ts/unbound-method -- 保存原方法供动态 this 的 apply 与原样恢复，不能预先绑定改变调用语义。
  const originalClose = context.close
  // eslint-disable-next-line ts/unbound-method -- 同上，包装器将原 this/参数透传。
  const originalDispose = request.dispose
  // eslint-disable-next-line ts/unbound-method -- 同上，包装器将原 this/参数透传。
  const originalStopChunk = tracing.stopChunk
  const close = wrap('context.close', originalClose, () => protocol?.closeStarted())
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

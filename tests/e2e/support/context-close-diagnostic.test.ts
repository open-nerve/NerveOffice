// KiB 级记录器验证；浏览器边界用 EventEmitter/原 Promise，不启动真实浏览器。
/* eslint-disable ts/promise-function-async -- 样例必须保留原 Promise 对象和同步抛错，async 会改变被验证的边界。 */
import type { BrowserContext, TestInfo } from '@playwright/test'
import type { ProtocolTapFactory } from './context-close-protocol.ts'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runCloseFixtureModel, runReportFifoReplacementModel } from './context-close-diagnostic.test-support.ts'
import { isContextCloseTarget, watchContextCloseDiagnostic } from './context-close-diagnostic.ts'
import { PROTOCOL_FILE } from './context-close-protocol.ts'

const TARGET = {
  file: '/repo/tests/e2e/specs/local-drafts/catalog-boundaries.spec.ts',
  title: '另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接',
  project: 'chrome',
  retry: 0,
}
const NAME = 'context-close-diagnostic.json'
const reportSchema = z.object({
  version: z.literal(1),
  owner: z.object({
    runId: z.string(),
    githubRunId: z.string(),
    githubRunAttempt: z.string(),
    sha: z.string(),
    project: z.enum(['chrome', 'msedge']),
    retry: z.number(),
  }).strict(),
  incomplete: z.boolean(),
  reasons: z.array(z.string()),
  events: z.array(z.object({
    seq: z.number(),
    stage: z.string(),
    outcome: z.string(),
    monotonicMs: z.number(),
    callId: z.number().optional(),
  }).strict()),
}).strict()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class ContextBoundary extends EventEmitter {
  readonly browserEvents = new EventEmitter()
  request = { dispose: (_options?: { reason?: string }): Promise<void> => Promise.resolve() }
  tracing = { stopChunk: (_options?: { path?: string }): Promise<void> => Promise.resolve() }
  browser() { return this.browserEvents }
  close = (options?: { reason?: string }): Promise<void> => {
    return this.request.dispose(options).then(() => this.tracing.stopChunk()).then(() => {
      this.emit('close')
    })
  }
}

const roots: string[] = []
function input(project = 'chrome') {
  const dir = mkdtempSync(join(tmpdir(), 'nerve-close-diagnostic-'))
  roots.push(dir)
  const context = new ContextBoundary()
  const attachments: TestInfo['attachments'] = []
  const annotations: TestInfo['annotations'] = []
  const info = {
    ...TARGET,
    project: { name: project, outputDir: dir },
    outputPath: (name: string) => join(dir, name),
    attachments,
    annotations,
  } as unknown as TestInfo
  const path = join(dir, NAME)
  return { context, info, path, dir, attachments, annotations, read: () => reportSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
}
/** 公开调用阶段的样例不接协议日志（协议记录另见 context-close-protocol.test.ts 与本文件末尾的接线样例） */
function watch(value: ReturnType<typeof input>, protocol: ProtocolTapFactory | null = null) {
  watchContextCloseDiagnostic(value.context as unknown as BrowserContext, value.info, { protocol })
}

beforeEach(() => {
  vi.stubEnv('E2E_CONTEXT_CLOSE_DIAGNOSTIC', '1')
  vi.stubEnv('NERVE_TEST_RUN_ID', '11111111-2222-4333-8444-555555555555')
  vi.stubEnv('GITHUB_RUN_ID', '41852824657')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
  vi.stubEnv('GITHUB_SHA', '1234567890abcdef1234567890abcdef12345678')
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('固定 Chrome、Edge 默认上下文关闭的有界补证', () => {
  it('只选择显式开关下原 file/title 在 chrome、msedge 上的 attempt 0/1', () => {
    expect(isContextCloseTarget(TARGET, '1')).toBe(true)
    expect(isContextCloseTarget({ ...TARGET, retry: 1 }, '1')).toBe(true)
    expect(isContextCloseTarget({ ...TARGET, project: 'msedge' }, '1')).toBe(true)
    expect(isContextCloseTarget({ ...TARGET, project: 'msedge', retry: 1 }, '1')).toBe(true)
    for (const enabled of [undefined, '', 'true', '0'])
      expect(isContextCloseTarget(TARGET, enabled)).toBe(false)
    for (const target of [
      { ...TARGET, project: 'chromium' },
      { ...TARGET, project: 'webkit' },
      { ...TARGET, project: 'crash-chrome' },
      { ...TARGET, project: 'crash-msedge' },
      { ...TARGET, project: 'Msedge' },
      { ...TARGET, title: `${TARGET.title}额外` },
      { ...TARGET, file: `${TARGET.file}.old` },
      { ...TARGET, file: '/repo/tests/e2e/specs/editor/catalog-boundaries.spec.ts' },
      { ...TARGET, retry: 2 },
      { ...TARGET, retry: -1 },
      { ...TARGET, retry: 0.5 },
    ]) expect(isContextCloseTarget(target, '1')).toBe(false)
  })

  it('非目标不创建文件、不修改方法、也不登记附件', () => {
    const value = input()
    vi.stubEnv('E2E_CONTEXT_CLOSE_DIAGNOSTIC', '')
    const close = value.context.close
    watch(value)
    expect(value.context.close).toBe(close)
    expect(existsSync(value.path)).toBe(false)
    expect(value.attachments).toEqual([])
    expect(value.annotations).toEqual([])
  })

  it('关闭前已经独占落档并登记；默认不完整，完整路径记录三个公开阶段而不携带参数', async () => {
    const value = input()
    const original = value.context.close
    watch(value)
    expect(value.attachments).toEqual([{ name: 'context-close-diagnostic', path: value.path, contentType: 'application/json' }])
    expect(value.read()).toMatchObject({ incomplete: true, events: [{ seq: 1, stage: 'observer.registered', outcome: 'event' }] })
    expect(statSync(value.path).mode & 0o777).toBe(0o600)
    await value.context.close({ reason: 'PRIVATE-CLOSE-REASON' })
    const report = value.read()
    expect(report.incomplete).toBe(false)
    expect(report.reasons).toEqual([])
    expect(report.events.map(event => [event.stage, event.outcome])).toEqual([
      ['observer.registered', 'event'],
      ['context.close', 'start'],
      ['request.dispose', 'start'],
      ['request.dispose', 'fulfilled'],
      ['tracing.stopChunk', 'start'],
      ['tracing.stopChunk', 'fulfilled'],
      ['context.closed', 'event'],
      ['context.close', 'fulfilled'],
    ])
    expect(report.owner).toEqual({ runId: '11111111-2222-4333-8444-555555555555', githubRunId: '41852824657', githubRunAttempt: '1', sha: '1234567890abcdef1234567890abcdef12345678', project: 'chrome', retry: 0 })
    expect(readFileSync(value.path, 'utf8')).not.toContain('PRIVATE-CLOSE-REASON')
    expect(value.context.close).toBe(original)
    expect(value.context.browserEvents.listenerCount('disconnected')).toBe(0)
  })

  it('透传原 this、参数对象与挂起 Promise，开始事件立即可读，不额外调用关闭', async () => {
    const value = input()
    const pending = deferred()
    const calls: { receiver: unknown, options: unknown }[] = []
    value.context.close = function (this: ContextBoundary, options) {
      calls.push({ receiver: this, options })
      return pending.promise
    }
    watch(value)
    const options = { reason: 'PRIVATE-ARGUMENT' }
    const result = value.context.close(options)
    expect(result).toBe(pending.promise)
    expect(calls).toEqual([{ receiver: value.context, options }])
    expect(calls[0]?.options).toBe(options)
    expect(value.read()).toMatchObject({ incomplete: true, events: [
      { stage: 'observer.registered' },
      { stage: 'context.close', outcome: 'start', callId: 1 },
    ] })
    value.context.emit('close')
    pending.resolve()
    await result
    expect(calls).toHaveLength(1)
    expect(value.read().events.at(-1)).toMatchObject({ stage: 'context.close', outcome: 'fulfilled', callId: 1 })
  })

  it('原同步异常不转成 Promise，原异步拒绝的 Promise 与错误对象都保持', async () => {
    for (const kind of ['sync', 'async']) {
      const value = input()
      const error = new Error('PRIVATE-ERROR-BODY')
      let originalPromise: Promise<void> | undefined
      value.context.close = () => {
        if (kind === 'sync')
          throw error
        return (originalPromise = Promise.reject(error))
      }
      watch(value)
      if (kind === 'sync') {
        let actual: unknown
        let returned: Promise<void> | undefined
        try {
          returned = value.context.close()
        }
        catch (caught) { actual = caught }
        void returned?.catch(() => {})
        expect(actual).toBe(error)
      }
      else {
        const result = value.context.close()
        expect(result).toBe(originalPromise)
        await expect(result).rejects.toBe(error)
      }
      expect(value.read().events.at(-1)).toMatchObject({ stage: 'context.close', outcome: kind === 'sync' ? 'threw' : 'rejected' })
      expect(value.read().incomplete).toBe(true)
      expect(readFileSync(value.path, 'utf8')).not.toContain('PRIVATE-ERROR-BODY')
    }
  })

  it('并发请求释放仍返回各自原 Promise，按 callId 关联乱序完成，不串到另一 attempt', async () => {
    const value = input()
    const other = input()
    const one = deferred()
    const two = deferred()
    let calls = 0
    value.context.request.dispose = () => (++calls === 1 ? one.promise : two.promise)
    watch(value)
    watch(other)
    const first = value.context.request.dispose()
    const second = value.context.request.dispose()
    expect(first).toBe(one.promise)
    expect(second).toBe(two.promise)
    two.resolve()
    await second
    one.resolve()
    await first
    expect(value.read().events.slice(1).map(event => [event.callId, event.outcome])).toEqual([[1, 'start'], [2, 'start'], [2, 'fulfilled'], [1, 'fulfilled']])
    expect(other.read().events).toHaveLength(1)
  })

  it('挂起时浏览器断连也留证，不能把断连冒充 close Promise 已完成', () => {
    const value = input()
    value.context.close = () => deferred().promise
    watch(value)
    void value.context.close()
    value.context.browserEvents.emit('disconnected')
    const report = value.read()
    expect(report.incomplete).toBe(true)
    expect(report.events.at(-1)).toMatchObject({ stage: 'browser.disconnected', outcome: 'event' })
    expect(report.events.some(event => event.stage === 'context.close' && event.outcome === 'fulfilled')).toBe(false)
  })

  it('既有文件、符号链接和重复安装不覆盖，错误只登记固定不完整注解', () => {
    for (const kind of ['existing', 'symlink', 'duplicate']) {
      const value = input()
      const original = value.context.close
      if (kind === 'existing')
        writeFileSync(value.path, 'existing evidence')
      if (kind === 'symlink') {
        const outside = join(value.dir, 'other-evidence.json')
        writeFileSync(outside, 'other evidence')
        symlinkSync(outside, value.path)
      }
      if (kind === 'duplicate')
        watch(value)
      const before = readFileSync(value.path, 'utf8')
      const installed = value.context.close
      expect(() => watch(value)).not.toThrow()
      expect(readFileSync(value.path, 'utf8')).toBe(before)
      expect(value.context.close).toBe(kind === 'duplicate' ? installed : original)
      expect(value.annotations).toContainEqual({ type: 'context-close-diagnostic-incomplete', description: 'report-unavailable' })
    }
  })

  it('文件中途被替换时不覆盖新文件；原关闭仍完成，诊断明确不完整', async () => {
    const value = input()
    watch(value)
    renameSync(value.path, `${value.path}.saved`)
    writeFileSync(value.path, 'unrelated replacement')
    await value.context.close()
    expect(readFileSync(value.path, 'utf8')).toBe('unrelated replacement')
    expect(value.annotations).toContainEqual({ type: 'context-close-diagnostic-incomplete', description: 'report-unavailable' })
    expect(reportSchema.parse(JSON.parse(readFileSync(`${value.path}.saved`, 'utf8'))).incomplete).toBe(true)
  })

  it('超过 64 条只保留有界前缀和不完整状态；另一轮目录不受影响', async () => {
    const value = input()
    const other = input()
    watch(value)
    watch(other)
    const otherBefore = readFileSync(other.path, 'utf8')
    for (let i = 0; i < 80; i++) await value.context.request.dispose()
    const report = value.read()
    expect(report.events).toHaveLength(64)
    expect(report.incomplete).toBe(true)
    expect(report.reasons).toContain('event-limit')
    expect(statSync(value.path).size).toBeLessThanOrEqual(32 * 1024)
    expect(readFileSync(other.path, 'utf8')).toBe(otherBefore)
  })

  it.each([
    ['NERVE_TEST_RUN_ID', ''],
    ['GITHUB_SHA', 'PRIVATE-SHA'],
    ['GITHUB_RUN_ID', '9'.repeat(21)],
    ['GITHUB_RUN_ATTEMPT', '0'],
  ])('缺失或畸形 %s 不创建报告、不透出原值，也不修改浏览器方法', (name, invalid) => {
    const value = input()
    const original = value.context.close
    vi.stubEnv(name, invalid)
    watch(value)
    expect(existsSync(value.path)).toBe(false)
    expect(value.context.close).toBe(original)
    expect(value.annotations).toContainEqual({ type: 'context-close-diagnostic-incomplete', description: 'identity-unavailable' })
    expect(JSON.stringify(value.annotations)).not.toContain('PRIVATE-SHA')
  })

  it('报告替换为无读取者 FIFO 时拒绝观察，原关闭仍执行且不改动 FIFO', () => {
    const result = runReportFifoReplacementModel()
    expect(result.status).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.originalCalled).toBe(true)
    expect(result.summary).toEqual({
      fifoPreserved: true,
      annotations: [{ type: 'context-close-diagnostic-incomplete', description: 'report-unavailable' }],
    })
  })

  it.each(['complete', 'pending'] as const)('实际默认 context fixture 在项目 provide 返回后关闭，%s 模型留存原结果和阶段', (mode) => {
    const result = runCloseFixtureModel(mode)
    expect(result.bodyFinished).toBe(true)
    expect(result.status).toBe(mode === 'complete' ? 0 : 1)
    expect(result.statuses).toEqual([mode === 'complete' ? 'passed' : 'timedOut'])
    expect(result.reports).toHaveLength(1)
    const report = reportSchema.parse(result.reports[0])
    expect(report.events.slice(0, 3).map(event => [event.stage, event.outcome])).toEqual([
      ['observer.registered', 'event'],
      ['context.close', 'start'],
      ['request.dispose', 'start'],
    ])
    expect(report.incomplete).toBe(mode === 'pending')
    if (mode === 'pending')
      expect(report.events.some(event => event.stage === 'request.dispose' && event.outcome === 'fulfilled')).toBe(false)
    else
      expect(report.events.at(-1)).toMatchObject({ stage: 'context.close', outcome: 'fulfilled' })
    // 真实 Playwright 工作进程里接上了运行中的 playwright-core 的日志对象（假浏览器没有协议消息），关闭开始已传到协议记录
    expect(result.protocols).toHaveLength(1)
    expect(result.protocols[0]).toMatchObject({
      version: 1,
      coreVersion: '1.63.0',
      state: mode === 'complete' ? 'closed' : 'disconnected',
      incomplete: mode === 'pending',
      reasons: [],
      messages: 0,
      closeStartedT: expect.any(Number) as unknown,
      owner: { project: 'chrome', retry: 0 },
    })
  }, 20_000)

  it('msedge 的 attempt 同样落档，归属写明项目', async () => {
    const value = input('msedge')
    watch(value)
    await value.context.close()
    expect(value.read()).toMatchObject({ incomplete: false, owner: { project: 'msedge', retry: 0 } })
  })

  it('同一开关下接上协议记录：关闭开始传给协议记录，context 关闭后释放并写下最终快照', async () => {
    const value = input()
    let feed: (message: string) => void = () => {}
    let released = 0
    watch(value, (onMessage) => {
      feed = onMessage
      return { release: () => {
        released++
      } }
    })
    expect(value.attachments.map(item => item.name)).toEqual(['context-close-diagnostic', 'context-close-protocol'])
    const closing = value.context.close()
    feed('SEND ► {"id":7,"method":"Target.disposeBrowserContext","params":{"browserContextId":"ABCDEF0123456789ABCDEF0123456789"}}')
    feed('◀ RECV {"id":7,"result":{}}')
    await closing
    const protocol = JSON.parse(readFileSync(join(value.dir, PROTOCOL_FILE), 'utf8')) as Record<string, unknown>
    expect(protocol).toMatchObject({ state: 'closed', incomplete: false, reasons: [], owner: { project: 'chrome' } })
    expect(protocol.closeStartedT).toEqual(expect.any(Number))
    expect(protocol.contexts).toEqual([expect.objectContaining({ id: 'ABCDEF01', disposeLatencyMs: expect.any(Number) as unknown, pendingAtDispose: [] })])
    expect(released).toBe(1)
    expect(value.annotations).toEqual([])
    expect(value.read().incomplete).toBe(false)
  })

  it('协议日志接不上时只登记协议的不完整原因，公开调用阶段照常记完', async () => {
    const value = input()
    watch(value, () => 'unsupported-version')
    await value.context.close()
    expect(value.read().incomplete).toBe(false)
    expect(value.annotations).toEqual([{ type: 'context-close-protocol-incomplete', description: 'unsupported-version' }])
    expect(JSON.parse(readFileSync(join(value.dir, PROTOCOL_FILE), 'utf8'))).toMatchObject({ state: 'stopped', incomplete: true, reasons: ['unsupported-version'] })
  })
})

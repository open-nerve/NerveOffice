import type { FakeTask } from '../../shared/worker-pool-fakes.test-support.ts'
import type { SnapshotInspectionSettings } from './snapshot-inspector.ts'
import { Buffer } from 'node:buffer'
import { Worker } from 'node:worker_threads'
import { ERROR_CODES, sheetSnapshotFor, SNAPSHOT_RULES, snapshotInvalidDetailsSchema } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { inspectSnapshot } from './snapshot-inspection.ts'
import { inspectionWorkerEntry, SnapshotInspector, snapshotInvalid } from './snapshot-inspector.ts'

const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const SETTINGS: SnapshotInspectionSettings = { threads: 2, queue: { maxWaiting: 8, maxWaitMs: 2_500 }, timeoutMs: 10_000, heapMb: 512 }
/** 假的工作线程入口：按交来的字节（一个假任务的 JSON）做假的工作，用来核对线程池的失败怎样换成回答 */
const FAKE_ENTRY = { script: new URL('../../shared/worker-pool-fake-worker.test-support.ts', import.meta.url), execArgv: [] }

const inspectors: SnapshotInspector[] = []

function setup(settings: Partial<SnapshotInspectionSettings> = {}, entry = inspectionWorkerEntry()) {
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const error = vi.spyOn(AppLogger.prototype, 'error')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const inspector = new SnapshotInspector({ ...SETTINGS, ...settings }, logger, entry)
  inspectors.push(inspector)
  return { inspector, warn, error }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(inspectors.splice(0).map(async inspector => inspector.onApplicationShutdown()))
})

function fake(task: FakeTask): Buffer {
  return Buffer.from(JSON.stringify(task), 'utf8')
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof AppError))
    throw new Error(`期望 AppError，得到 ${String(error)}`)
  return error
}

describe('SnapshotInspector：在工作线程里检查（源码运行：入口是 .ts，按源码条件解析 contracts）', () => {
  it('模板通过，结果与在主线程里检查的相同；线程按需创建', async () => {
    const { inspector } = setup()
    expect(inspector.liveThreads).toBe(0)
    const raw = Buffer.from(sheetSnapshotFor(UNIT_ID), 'utf8')
    const outcome = await inspector.inspect(raw, 'sheet@1')
    expect(outcome).toEqual(inspectSnapshot(raw, 'sheet@1'))
    expect(outcome.ok).toBe(true)
    expect(inspector.liveThreads).toBe(1)
  })

  it('不合格的快照给出规则；极深的嵌套在线程里按规则拒绝', async () => {
    const { inspector } = setup()
    expect(await inspector.inspect(Buffer.from('{"id":"x","sheetOrder":["a"],"sheets":{}}'), 'sheet@1')).toEqual({ ok: false, rule: 'structure' })
    expect(await inspector.inspect(Buffer.from(`{"a":${'['.repeat(300_000)}${']'.repeat(300_000)}}`), 'sheet@1')).toEqual({ ok: false, rule: 'depth' })
  })

  it('多份同时提交：每份各自得到自己的结果', async () => {
    const { inspector } = setup({ threads: 2 })
    const raws = ['a', 'b', 'c', 'd', 'e'].map(suffix => Buffer.from(sheetSnapshotFor(`${UNIT_ID.slice(0, -1)}${suffix}`), 'utf8'))
    const outcomes = await Promise.all(raws.map(async raw => inspector.inspect(raw, 'sheet@1')))
    expect(outcomes.map(outcome => (outcome.ok ? outcome.unitId : outcome.rule))).toEqual(['a', 'b', 'c', 'd', 'e'].map(suffix => `${UNIT_ID.slice(0, -1)}${suffix}`))
    expect(inspector.liveThreads).toBeLessThanOrEqual(2)
  })
})

describe('工作线程的入口', () => {
  it('与这个模块同一个目录、同一个扩展名：源码运行时是 .ts 并按源码条件解析，构建产物里是 .js', () => {
    expect(inspectionWorkerEntry('file:///app/src/modules/documents/snapshot-inspector.ts')).toEqual({
      script: new URL('file:///app/src/modules/documents/snapshot-inspection.worker.ts'),
      execArgv: ['--conditions=@nerve-office/source'],
    })
    expect(inspectionWorkerEntry('file:///app/dist/modules/documents/snapshot-inspector.js?v=1')).toEqual({
      script: new URL('file:///app/dist/modules/documents/snapshot-inspection.worker.js'),
      execArgv: [],
    })
  })

  it('入口不存在时建不起来（启动即失败），不退回主线程', () => {
    expect(() => setup({}, { script: new URL('./missing.worker.ts', import.meta.url), execArgv: [] })).toThrow(/工作线程入口不存在/)
  })
})

describe('线程池没有给出结果时的回答', () => {
  it('线程的内存超过上限：这份快照按 too-complex 拒绝（记 warn），线程被结束', async () => {
    const posted = vi.spyOn(Worker.prototype, 'postMessage')
    const { inspector, warn } = setup({ threads: 1, heapMb: 64 }, FAKE_ENTRY)
    expect(await inspector.inspect(fake({ kind: 'thread' }), 'sheet@1')).toEqual(expect.any(Number))
    // 配置的堆上限确实加在线程上
    expect((posted.mock.contexts[0] as Worker).resourceLimits?.maxOldGenerationSizeMb).toBe(64)
    expect(await inspector.inspect(fake({ kind: 'allocate' }), 'sheet@1')).toEqual({ ok: false, rule: 'too-complex' })
    const [message, fields] = warn.mock.calls[0] ?? []
    expect(message).toContain('too-complex')
    expect(fields?.rawBytes).toBe(JSON.stringify({ kind: 'allocate' }).length)
  })

  it('排队满了：503 带 Retry-After（排队等待的时限，向上取整到秒）', async () => {
    const { inspector } = setup({ threads: 1, queue: { maxWaiting: 0, maxWaitMs: 2_500 } }, FAKE_ENTRY)
    const running = inspector.inspect(fake({ kind: 'spin' }), 'sheet@1').catch((error: unknown) => error)
    await vi.waitFor(() => expect(inspector.liveThreads).toBe(1))
    const error = await rejection(inspector.inspect(fake({ kind: 'echo', value: 1 }), 'sheet@1'))
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.status).toBe(ERROR_CODES.SERVICE_UNAVAILABLE.status)
    expect(error.headers).toEqual({ 'Retry-After': '3' })
    await inspector.onApplicationShutdown()
    expect(await running).toBeInstanceOf(AppError)
  })

  it('线程出错：503 带 Retry-After，记 error（带原因）', async () => {
    const { inspector, error: logged } = setup({ threads: 1 }, FAKE_ENTRY)
    const error = await rejection(inspector.inspect(fake({ kind: 'throw' }), 'sheet@1'))
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.headers['Retry-After']).toBe('3')
    const [message, fields] = logged.mock.calls[0] ?? []
    expect(message).toContain('工作线程出错')
    expect(fields?.err).toBeInstanceOf(Error)
  })

  it('超过时限：503，记 warn；下一份照常检查', async () => {
    // 时限从交出任务算起，下一份的新线程也要在时限之内加载好：留足余量（慢机器上源码运行的加载要几百毫秒）
    const { inspector, warn } = setup({ threads: 1, timeoutMs: 2_000 }, FAKE_ENTRY)
    expect((await rejection(inspector.inspect(fake({ kind: 'spin' }), 'sheet@1'))).code).toBe('SERVICE_UNAVAILABLE')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('超过时限'), expect.anything())
    expect(await inspector.inspect(fake({ kind: 'echo', value: 'next' }), 'sheet@1')).toBe('next')
  })

  it('应用退出：线程都结束，之后的检查 503', async () => {
    const { inspector } = setup()
    await inspector.inspect(Buffer.from(sheetSnapshotFor(UNIT_ID), 'utf8'), 'sheet@1')
    await inspector.onApplicationShutdown()
    expect(inspector.liveThreads).toBe(0)
    expect((await rejection(inspector.inspect(Buffer.from('{}'), 'sheet@1'))).code).toBe('SERVICE_UNAVAILABLE')
  })

  it('Retry-After 至少 1 秒', async () => {
    const { inspector } = setup({ threads: 1, queue: { maxWaiting: 0, maxWaitMs: 100 } }, FAKE_ENTRY)
    void inspector.inspect(fake({ kind: 'spin' }), 'sheet@1').catch(() => undefined)
    await vi.waitFor(() => expect(inspector.liveThreads).toBe(1))
    expect((await rejection(inspector.inspect(fake({ kind: 'echo', value: 1 }), 'sheet@1'))).headers).toEqual({ 'Retry-After': '1' })
  })
})

describe('SNAPSHOT_INVALID 的错误（snapshotInvalid）', () => {
  it.each(SNAPSHOT_RULES)('%s：422，details 是规则（契约能解析），说明不空', (rule) => {
    const error = snapshotInvalid(rule)
    expect(error.code).toBe('SNAPSHOT_INVALID')
    expect(error.status).toBe(422)
    expect(error.details).toEqual({ rule })
    expect(snapshotInvalidDetailsSchema.parse(error.details)).toEqual({ rule })
    expect(error.message.length).toBeGreaterThan(0)
  })

  it('三条链接的规则说法相同（页面按规则给出自己的说法）', () => {
    expect(new Set(['link-structure', 'link-address', 'link-range-id'].map(rule => snapshotInvalid(rule as 'link-address').message)).size).toBe(1)
  })
})

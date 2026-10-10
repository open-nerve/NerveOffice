import type { DraftRead, KeyChange } from '../../../shared/outbox/draft-writer.ts'
import type { WorkerEventType, WorkerLike } from './outbox-worker-client.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import * as writers from '../../../shared/outbox/draft-writer.ts'
import { fakeLeaseClock, settle } from '../fake-lease-clock.test-support.ts'
import { createOutboxHost, OUTBOX_REQUEST_TIMEOUT_MS } from './outbox-host.ts'
import { OUTBOX_PROTOCOL_VERSION } from './outbox-protocol.ts'

afterEach(() => vi.restoreAllMocks())

function scriptedWorker() {
  const events = new EventTarget()
  const posted: { readonly id: number, readonly type: string, readonly keepAlive?: boolean }[] = []
  const terminate = vi.fn()
  const worker: WorkerLike = {
    postMessage: (message) => {
      posted.push(message as typeof posted[number])
    },
    addEventListener: (type: WorkerEventType, listener) => events.addEventListener(type, listener),
    removeEventListener: (type: WorkerEventType, listener) => events.removeEventListener(type, listener),
    terminate,
  }
  return {
    worker,
    posted,
    terminate,
    ready: () => events.dispatchEvent(new MessageEvent('message', { data: { v: OUTBOX_PROTOCOL_VERSION, id: posted[0]?.id, ok: true, result: { kind: 'ready' } } })),
    crash: () => events.dispatchEvent(new Event('error')),
  }
}

function fallback() {
  const writer = writers.createDraftWriter({ store: fakeDraftStore().store, now: () => 1_000 })
  const dispose = vi.spyOn(writer, 'dispose')
  return { writer, dispose, create: vi.fn(() => writer) }
}

describe('编辑会话的发件箱宿主', () => {
  it('默认 15 秒看门狗，成功握手使用 Worker；保留 P1 的空定时器，不创建退路', async () => {
    const worker = scriptedWorker()
    const time = fakeLeaseClock()
    const local = fallback()
    const pending = createOutboxHost({ createWorker: () => worker.worker, createFallback: local.create, clock: time.clock })
    expect(OUTBOX_REQUEST_TIMEOUT_MS).toBe(15_000)
    expect(worker.posted).toMatchObject([{ type: 'hello', keepAlive: true }])
    worker.ready()
    const host = await pending
    expect(host.kind).toBe('worker')
    expect(host.broken()).toBe(false)
    expect(local.create).not.toHaveBeenCalled()
    expect(time.pending()).toBe(0)
    host.dispose()
    host.dispose()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(host.broken()).toBe(true)
  })

  it('创建失败只准备一次进程内退路，销毁幂等', async () => {
    const local = fallback()
    const host = await createOutboxHost({ createWorker: () => {
      throw new Error('Worker 被禁止')
    }, createFallback: local.create, clock: fakeLeaseClock().clock })
    expect(host.kind).toBe('in-process')
    const read = vi.spyOn(local.writer, 'read').mockResolvedValue({ kind: 'absent' })
    expect(await host.writer.read({ userId: 'user', documentId: 'doc' })).toEqual({ kind: 'absent' })
    expect(read).toHaveBeenCalledExactlyOnceWith({ userId: 'user', documentId: 'doc' })
    expect(host.broken()).toBe(false)
    expect(local.create).toHaveBeenCalledTimes(1)
    host.dispose()
    host.dispose()
    expect(local.dispose).toHaveBeenCalledTimes(1)
    expect(host.broken()).toBe(true)
  })

  it('握手前出错先终止 Worker，再创建退路', async () => {
    const worker = scriptedWorker()
    const local = fallback()
    const pending = createOutboxHost({ createWorker: () => worker.worker, createFallback: local.create, clock: fakeLeaseClock().clock })
    worker.crash()
    const host = await pending
    expect(host.kind).toBe('in-process')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.terminate.mock.invocationCallOrder[0]).toBeLessThan(local.create.mock.invocationCallOrder[0] ?? 0)
    host.dispose()
  })

  it('握手挂住到 15 秒才退路；随后 Worker 晚到不恢复', async () => {
    const worker = scriptedWorker()
    const time = fakeLeaseClock()
    const local = fallback()
    const pending = createOutboxHost({ createWorker: () => worker.worker, createFallback: local.create, clock: time.clock })
    await time.advance(14_999)
    expect(local.create).not.toHaveBeenCalled()
    await time.advance(1)
    const host = await pending
    worker.ready()
    expect(host.kind).toBe('in-process')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(local.create).toHaveBeenCalledTimes(1)
    expect(time.pending()).toBe(0)
    host.dispose()
  })

  it('握手成功后崩溃：有界结束当前操作并报告 broken，不自动换成进程内管道', async () => {
    const worker = scriptedWorker()
    const local = fallback()
    const pending = createOutboxHost({ createWorker: () => worker.worker, createFallback: local.create, clock: fakeLeaseClock().clock })
    worker.ready()
    const host = await pending
    const reading = host.writer.read({ userId: 'user', documentId: 'doc' })
    worker.crash()
    expect(await reading).toMatchObject({ kind: 'failed', error: { name: 'OutboxWorkerError' } })
    expect(host.broken()).toBe(true)
    expect(local.create).not.toHaveBeenCalled()
    host.dispose()
  })

  it('运行中的请求沿用注入时限，超时也不能自动降级或循环重建', async () => {
    const worker = scriptedWorker()
    const time = fakeLeaseClock()
    const local = fallback()
    const pending = createOutboxHost({ createWorker: () => worker.worker, createFallback: local.create, clock: time.clock, requestTimeoutMs: 100 })
    worker.ready()
    const host = await pending
    const reading = host.writer.read({ userId: 'user', documentId: 'doc' })
    await time.advance(100)
    expect(await reading).toMatchObject({ kind: 'failed' })
    expect(host.broken()).toBe(true)
    expect(local.create).not.toHaveBeenCalled()
    host.dispose()
  })

  it('准备前已取消：不创建 Worker 或退路', async () => {
    const controller = new AbortController()
    controller.abort()
    const createWorker = vi.fn(() => scriptedWorker().worker)
    const local = fallback()
    await expect(createOutboxHost({ createWorker, createFallback: local.create, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(createWorker).not.toHaveBeenCalled()
    expect(local.create).not.toHaveBeenCalled()
  })

  it('握手途中取消：立即终止，晚到失败或 ready 都不能创建退路', async () => {
    const worker = scriptedWorker()
    const time = fakeLeaseClock()
    const local = fallback()
    const controller = new AbortController()
    const pending = createOutboxHost({ createWorker: () => worker.worker, createFallback: local.create, clock: time.clock, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    worker.ready()
    worker.crash()
    await settle()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(local.create).not.toHaveBeenCalled()
    expect(time.pending()).toBe(0)
  })

  it('默认进程内工厂使用 P1 的恢复策略，不注入空 recovery 或主线程 OPFS 写入镜像', async () => {
    const create = vi.spyOn(writers, 'createDraftWriter')
    const host = await createOutboxHost({ createWorker: () => {
      throw new Error('启动失败')
    }, clock: fakeLeaseClock().clock, now: () => 123 })
    expect(host.kind).toBe('in-process')
    expect(create).toHaveBeenCalledTimes(1)
    const options = create.mock.calls[0]?.[0]
    expect(options?.now()).toBe(123)
    expect(options).not.toHaveProperty('recovery')
    expect(options).not.toHaveProperty('mirror')
    expect(options?.store).toBeDefined()
    host.dispose()
  })

  it('退路本身创建失败直接结束，不再尝试另建宿主', async () => {
    const createFallback = vi.fn(() => {
      throw new Error('退路也失败')
    })
    await expect(createOutboxHost({ createWorker: () => {
      throw new Error('启动失败')
    }, createFallback })).rejects.toThrow('退路也失败')
    expect(createFallback).toHaveBeenCalledTimes(1)
  })

  it('进程内存储挂住同样有 15 秒上限：结束全部等待，停用宿主，晚到结果不复活', async () => {
    const local = fallback()
    const time = fakeLeaseClock()
    let finishRead!: (value: DraftRead) => void
    const read = vi.spyOn(local.writer, 'read').mockImplementation(async () => new Promise((resolve) => {
      finishRead = resolve
    }))
    const set = vi.spyOn(local.writer, 'setKey').mockImplementation(async () => new Promise<KeyChange>(() => {}))
    const host = await createOutboxHost({ createWorker: () => {
      throw new Error('启动失败')
    }, createFallback: local.create, clock: time.clock })
    const reading = host.writer.read({ userId: 'user', documentId: 'doc' })
    const setting = host.writer.setKey(undefined)
    await time.advance(14_999)
    expect(host.broken()).toBe(false)
    await time.advance(1)
    expect(await reading).toMatchObject({ kind: 'failed', error: { name: 'OutboxHostTimeout' } })
    expect(await setting).toMatchObject({ kind: 'failed', error: { name: 'OutboxHostTimeout' } })
    expect(host.broken()).toBe(true)
    expect(local.dispose).toHaveBeenCalledTimes(1)
    expect(time.pending()).toBe(0)
    finishRead({ kind: 'absent' })
    await settle()
    expect(await host.writer.read({ userId: 'user', documentId: 'doc' })).toMatchObject({ kind: 'failed' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledTimes(1)
    expect(local.create).toHaveBeenCalledTimes(1)
  })

  it('进程内的正常完成会取消看门狗；销毁使尚未完成的等待有界结束', async () => {
    const local = fallback()
    const time = fakeLeaseClock()
    const read = vi.spyOn(local.writer, 'read').mockResolvedValueOnce({ kind: 'absent' }).mockImplementation(async () => new Promise<DraftRead>(() => {}))
    const host = await createOutboxHost({ createWorker: () => {
      throw new Error('启动失败')
    }, createFallback: local.create, clock: time.clock })
    expect(await host.writer.read({ userId: 'user', documentId: 'doc' })).toEqual({ kind: 'absent' })
    expect(time.pending()).toBe(0)
    const pending = host.writer.read({ userId: 'user', documentId: 'doc' })
    host.dispose()
    expect(await pending).toMatchObject({ kind: 'failed' })
    expect(time.pending()).toBe(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(local.dispose).toHaveBeenCalledTimes(1)
  })
})

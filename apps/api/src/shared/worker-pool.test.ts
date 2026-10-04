import type { FakeTask } from './worker-pool-fakes.test-support.ts'
import type { WorkerPoolOptions } from './worker-pool.ts'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE, STARTED } from './worker-pool-fakes.test-support.ts'
import { WorkerPool, WorkerPoolError } from './worker-pool.ts'

const SCRIPT = new URL('./worker-pool-fake-worker.test-support.ts', import.meta.url)

const pools: WorkerPool<FakeTask, unknown>[] = []

function pool(options: Partial<WorkerPoolOptions> = {}): WorkerPool<FakeTask, unknown> {
  const created = new WorkerPool<FakeTask, unknown>({
    script: SCRIPT,
    execArgv: [],
    threads: 2,
    queue: {},
    taskTimeoutMs: 10_000,
    resourceLimits: {},
    ...options,
  })
  pools.push(created)
  return created
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(pools.splice(0).map(async created => created.close()))
})

/** 共享的计数：挡住的任务数与放行 */
function gate(): { readonly shared: SharedArrayBuffer, readonly started: () => number, readonly release: () => void } {
  const shared = new SharedArrayBuffer(8)
  const counters = new Int32Array(shared)
  return {
    shared,
    started: () => Atomics.load(counters, STARTED),
    release: () => {
      Atomics.store(counters, RELEASE, 1)
      Atomics.notify(counters, RELEASE)
    },
  }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error('等不到条件成立')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function failure(promise: Promise<unknown>): Promise<WorkerPoolError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof WorkerPoolError))
    throw new Error(`期望 WorkerPoolError，得到 ${String(error)}`)
  return error
}

describe('WorkerPool', () => {
  it('交给线程执行、拿回它回的消息；线程按需创建、留着复用', async () => {
    const workers = pool()
    expect(workers.liveThreads).toBe(0)
    expect(await workers.run({ kind: 'echo', value: { a: [1, 'x'] } })).toEqual({ a: [1, 'x'] })
    expect(workers.liveThreads).toBe(1)
    const first = await workers.run({ kind: 'thread' })
    expect(await workers.run({ kind: 'thread' })).toBe(first)
    expect(workers.liveThreads).toBe(1)
  })

  it('同时执行的任务不超过线程数，超出的排队，按先来后到执行', async () => {
    const workers = pool({ threads: 2 })
    const blocking = gate()
    const tasks = Array.from({ length: 4 }, async () => workers.run({ kind: 'block', shared: blocking.shared }))
    await until(() => blocking.started() === 2)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(blocking.started()).toBe(2)
    expect(workers.liveThreads).toBe(2)
    blocking.release()
    expect(await Promise.all(tasks)).toEqual(['released', 'released', 'released', 'released'])
    expect(workers.liveThreads).toBe(2)
  })

  it('排队满了：再来的立即失败（queue-full），没有执行', async () => {
    const workers = pool({ threads: 1, queue: { maxWaiting: 1 } })
    const blocking = gate()
    const running = workers.run({ kind: 'block', shared: blocking.shared })
    await until(() => blocking.started() === 1)
    const queued = workers.run({ kind: 'echo', value: 'queued' })
    expect((await failure(workers.run({ kind: 'echo', value: 'rejected' }))).reason).toBe('queue-full')
    blocking.release()
    expect(await running).toBe('released')
    expect(await queued).toBe('queued')
  })

  it('排队等待超时：失败（wait-timeout）并离开队列', async () => {
    const workers = pool({ threads: 1, queue: { maxWaitMs: 50 } })
    const blocking = gate()
    const running = workers.run({ kind: 'block', shared: blocking.shared })
    await until(() => blocking.started() === 1)
    expect((await failure(workers.run({ kind: 'echo', value: 'late' }))).reason).toBe('wait-timeout')
    blocking.release()
    expect(await running).toBe('released')
    expect(await workers.run({ kind: 'echo', value: 'next' })).toBe('next')
  })

  it('超过时限：结束那个线程（timeout），下一个任务用新的线程', async () => {
    const workers = pool({ threads: 1, taskTimeoutMs: 200 })
    const before = await workers.run({ kind: 'thread' })
    expect((await failure(workers.run({ kind: 'spin' }))).reason).toBe('timeout')
    expect(workers.liveThreads).toBe(0)
    const after = await workers.run({ kind: 'thread' })
    expect(after).not.toBe(before)
    expect(workers.liveThreads).toBe(1)
  })

  it('线程抛出：这个任务失败（crashed，cause 是原因），线程被丢弃，下一个任务用新的线程', async () => {
    const workers = pool({ threads: 1 })
    const before = await workers.run({ kind: 'thread' })
    const error = await failure(workers.run({ kind: 'throw' }))
    expect(error.reason).toBe('crashed')
    expect(String((error.cause as Error).message)).toContain('假任务按要求抛出')
    expect(await workers.run({ kind: 'thread' })).not.toBe(before)
  })

  it('线程意外退出：这个任务失败（crashed），下一个任务照常', async () => {
    const workers = pool({ threads: 1 })
    const error = await failure(workers.run({ kind: 'exit' }))
    expect(error.reason).toBe('crashed')
    expect(String((error.cause as Error).message)).toContain('退出码 3')
    expect(await workers.run({ kind: 'echo', value: 'again' })).toBe('again')
  })

  it('线程的堆超过 resourceLimits：这个任务失败（out-of-memory），线程被结束，下一个任务用新的线程', async () => {
    const workers = pool({ threads: 1, resourceLimits: { maxOldGenerationSizeMb: 64 } })
    // 先确认线程加载得起来：内存超限发生在任务里，不是加载时
    const before = await workers.run({ kind: 'thread' })
    expect((await failure(workers.run({ kind: 'allocate' }))).reason).toBe('out-of-memory')
    expect(await workers.run({ kind: 'thread' })).not.toBe(before)
  })

  it('任务不能复制给线程：原样抛出，线程照常留着', async () => {
    const workers = pool({ threads: 1 })
    await workers.run({ kind: 'echo', value: 1 })
    await expect(workers.run({ kind: 'echo', value: () => 1 })).rejects.toThrow(/could not be cloned/)
    expect(workers.liveThreads).toBe(1)
    expect(await workers.run({ kind: 'echo', value: 2 })).toBe(2)
  })

  it('关闭：执行中与排队的任务都失败（closed），线程都结束，之后的任务立即失败', async () => {
    const workers = pool({ threads: 1, queue: { maxWaiting: 4 } })
    const blocking = gate()
    const running = failure(workers.run({ kind: 'block', shared: blocking.shared }))
    await until(() => blocking.started() === 1)
    const queued = failure(workers.run({ kind: 'echo', value: 'queued' }))
    await workers.close()
    expect((await running).reason).toBe('closed')
    expect((await queued).reason).toBe('closed')
    expect(workers.liveThreads).toBe(0)
    expect((await failure(workers.run({ kind: 'echo', value: 'after' }))).reason).toBe('closed')
  })

  it('线程数必须是正整数', () => {
    expect(() => pool({ threads: 0 })).toThrow(RangeError)
  })

  it('空闲的线程不留住进程（unref），执行任务期间留住（ref）', async () => {
    const ref = vi.spyOn(Worker.prototype, 'ref')
    const unref = vi.spyOn(Worker.prototype, 'unref')
    const workers = pool({ threads: 1 })
    await workers.run({ kind: 'echo', value: 1 })
    // 建线程时 unref；交出任务时 ref，回了结果再 unref
    expect(ref).toHaveBeenCalledTimes(1)
    expect(unref).toHaveBeenCalledTimes(2)
    await workers.run({ kind: 'echo', value: 2 })
    expect(ref).toHaveBeenCalledTimes(2)
    expect(unref).toHaveBeenCalledTimes(3)
    expect(unref.mock.invocationCallOrder.at(-1)).toBeGreaterThan(ref.mock.invocationCallOrder.at(-1) ?? 0)
  })
})

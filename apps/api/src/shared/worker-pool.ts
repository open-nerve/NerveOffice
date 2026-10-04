// 工作线程池（M3-P3 设计 §3.3，DEF-018）：把占 CPU 与内存的同步计算（例如快照的解析、检查与规范化）放进 worker_threads，
// 主线程的事件循环不被阻塞；每个线程的堆有上限，超限只结束那一个线程，不拖垮进程。
// - 线程数就是同时执行的任务数；超出的按先来后到排队（Semaphore），排队的数量与等待的时长有上限，满了或等不到立即失败；
// - 每个任务有时限，超时就结束那个线程；
// - 线程按需创建，出错（内存超限、超时、崩溃）之后丢弃，下一个任务再建新的：不在出错时立即重建，入口加载不了时不会反复重建；
// - 空闲的线程不留住进程（unref），执行任务期间留住；
// - 关闭：不再接受任务，结束全部线程（执行中与排队的任务都失败）。
// 一个线程一次只执行一个任务：交出任务，等它回一条消息。工作线程一侧用 worker-task.ts 的 serveWorkerTasks 接任务
import type { ResourceLimits } from 'node:worker_threads'
import type { SemaphoreLimits } from './semaphore.ts'
import { Worker } from 'node:worker_threads'
import { Semaphore, SemaphoreBusyError } from './semaphore.ts'

export interface WorkerPoolOptions {
  /** 工作线程的入口（文件地址） */
  readonly script: URL
  /**
   * 工作线程的 Node 选项。不继承主线程的：进程入口带的选项（例如 E2E 给后端进程的 --import）不该在每个线程里再执行一遍
   */
  readonly execArgv: readonly string[]
  /** 线程数：同时执行的任务数的上限 */
  readonly threads: number
  /** 排队的上限：数量与等待的时长 */
  readonly queue: SemaphoreLimits
  /** 每个任务从交给线程到回结果的时限（毫秒），超时就结束那个线程 */
  readonly taskTimeoutMs: number
  /** 每个线程的资源上限（V8 的堆等），超出时这个线程被结束，任务按 out-of-memory 失败 */
  readonly resourceLimits: ResourceLimits
}

/**
 * 任务没有得到结果的原因：
 * - 没有执行：queue-full（排队满了）、wait-timeout（排队等待超时）、closed（线程池已经关闭）；
 * - 执行了但没有结果：out-of-memory（线程的内存超过上限）、timeout（超过时限）、crashed（线程出错或意外退出，cause 是原因）
 */
export type WorkerPoolFailure = 'queue-full' | 'wait-timeout' | 'closed' | 'out-of-memory' | 'timeout' | 'crashed'

export class WorkerPoolError extends Error {
  constructor(readonly reason: WorkerPoolFailure, options?: ErrorOptions) {
    super(`工作线程的任务没有结果：${reason}`, options)
    this.name = 'WorkerPoolError'
  }
}

type Settlement = { readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: unknown }

/** 一个线程的位置：线程按需创建，出错之后丢弃（worker 回到 undefined） */
interface Slot {
  worker: Worker | undefined
  /** 执行中的任务：线程回消息、出错或超时之后交出结果（只交一次） */
  settle: ((settlement: Settlement) => void) | undefined
}

/** 线程的堆超过 resourceLimits 时，Node 结束它并报这个错误 */
function isOutOfMemory(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
}

export class WorkerPool<Task, Result> {
  readonly #options: WorkerPoolOptions
  readonly #permits: Semaphore
  readonly #slots: readonly Slot[]
  /** 空闲的位置：持有名额的任务取一个，结束时放回（名额数等于位置数，取的时候一定有） */
  readonly #idle: Slot[]
  /** 正在结束的线程：关闭时等它们都退出 */
  readonly #exiting = new Set<Promise<unknown>>()
  #closed = false

  constructor(options: WorkerPoolOptions) {
    this.#options = options
    this.#permits = new Semaphore(options.threads, options.queue)
    this.#slots = Array.from({ length: options.threads }, (): Slot => ({ worker: undefined, settle: undefined }))
    this.#idle = [...this.#slots]
  }

  /** 现有的线程数（含空闲的）：线程按需创建，出错之后丢弃 */
  get liveThreads(): number {
    return this.#slots.filter(slot => slot.worker !== undefined).length
  }

  /** 交给一个线程执行，返回它回的消息；没有结果时抛出 WorkerPoolError */
  async run(task: Task): Promise<Result> {
    if (this.#closed)
      throw new WorkerPoolError('closed')
    try {
      return await this.#permits.run(async () => this.#execute(task))
    }
    catch (error) {
      if (error instanceof SemaphoreBusyError)
        throw new WorkerPoolError(error.reason, { cause: error })
      throw error
    }
  }

  /** 不再接受任务；结束全部线程（执行中的任务按 closed 失败，排队的轮到时同样失败），等它们都退出 */
  async close(): Promise<void> {
    this.#closed = true
    for (const slot of this.#slots) {
      if (slot.worker !== undefined)
        this.#discard(slot, slot.worker, new WorkerPoolError('closed'))
    }
    await Promise.all(this.#exiting)
  }

  async #execute(task: Task): Promise<Result> {
    if (this.#closed)
      throw new WorkerPoolError('closed')
    const slot = this.#idle.pop()
    if (slot === undefined)
      throw new Error('线程池的名额与空闲的线程对不上')
    return new Promise<Result>((resolve, reject) => {
      const worker = slot.worker ?? this.#spawn(slot)
      const timer = setTimeout(() => this.#discard(slot, worker, new WorkerPoolError('timeout')), this.#options.taskTimeoutMs)
      worker.ref()
      slot.settle = (settlement) => {
        clearTimeout(timer)
        slot.settle = undefined
        if (slot.worker === worker)
          worker.unref()
        this.#idle.push(slot)
        if (settlement.ok)
          resolve(settlement.value as Result)
        else
          reject(settlement.error)
      }
      try {
        worker.postMessage(task)
      }
      catch (error) {
        // 任务不能复制（DataCloneError）：调用方写错了，线程还在、照常留着
        slot.settle({ ok: false, error })
      }
    })
  }

  #spawn(slot: Slot): Worker {
    const worker = new Worker(this.#options.script, { execArgv: [...this.#options.execArgv], resourceLimits: this.#options.resourceLimits })
    worker.unref()
    slot.worker = worker
    // 常驻的监听：线程空闲时出错也有人接（没有监听的 error 事件会让主进程抛出）。丢弃之后来的事件一律不管
    worker.on('message', (message: unknown) => {
      if (slot.worker === worker)
        slot.settle?.({ ok: true, value: message })
    })
    worker.on('error', (error: Error) => this.#discard(slot, worker, new WorkerPoolError(isOutOfMemory(error) ? 'out-of-memory' : 'crashed', { cause: error })))
    worker.on('messageerror', (error: Error) => this.#discard(slot, worker, new WorkerPoolError('crashed', { cause: error })))
    worker.on('exit', (code: number) => this.#discard(slot, worker, new WorkerPoolError('crashed', { cause: new Error(`工作线程退出了，退出码 ${code}`) })))
    return worker
  }

  /** 丢弃这个线程（结束它），执行中的任务按 error 失败。同一个线程只处理一次：出错之后还会有退出事件 */
  #discard(slot: Slot, worker: Worker, error: WorkerPoolError): void {
    if (slot.worker !== worker)
      return
    slot.worker = undefined
    const exiting = worker.terminate()
    this.#exiting.add(exiting)
    const forget = (): void => {
      this.#exiting.delete(exiting)
    }
    exiting.then(forget, forget)
    slot.settle?.({ ok: false, error })
  }
}

// 子进程池（M3-P3 设计 §3.3，DEF-018）：把占 CPU 与内存的同步计算（例如快照的解析、检查与规范化）放进子进程（child_process.fork），
// 主进程的事件循环不被阻塞；每个子进程的 V8 堆有上限（--max-old-space-size），撞上上限时 V8 中止的只是那个子进程，主进程照常。
// 工作线程做不到这一点（S3 实测）：线程在 V8 的内置函数里（JSON.parse 正在建对象、对大字典取键）撞上 resourceLimits 时，
// Node 结束不了那个线程，整个进程中止。
// - 子进程数就是同时执行的任务数；超出的按先来后到排队（Semaphore），排队的数量与等待的时长有上限，满了或等不到立即失败；
// - 子进程按需创建：先等它加载好（回 ready）再交出任务。加载与每个任务各有时限（taskTimeoutMs），超时就结束那个子进程；
// - 出错（内存超限、超时、崩溃、回了不认识的消息）之后丢弃，下一个任务再起新的：不在出错时立即重建，入口加载不了时不会反复重建；
// - 空闲超过 idleTimeoutMs 的子进程结束掉，内存还给系统（V8 不会很快把检查用过的堆还回去），下一个任务再起；
//   空闲的位置后进先出，忙的时候总是同一个子进程先接活，其余的空闲到期退出；
// - 子进程不继承主进程的 Node 选项（execArgv 与 NODE_OPTIONS：进程入口带的选项，例如 E2E 给后端的 --import，不该在子进程里再执行），
//   只带调用方给的选项、堆上限与新生代的上限；环境变量为空：子进程处理的是外来的输入，用不着数据库口令这类机密；
// - 主进程不在了（退出、崩溃、被强制结束）时 IPC 断开，子进程随之退出（process-task.ts），不留孤儿；
// - 空闲的子进程不留住主进程（进程、IPC 通道与标准错误都 unref），有任务时留住；
// - 关闭：不再接受任务，结束全部子进程（执行中与排队的任务都失败），等它们都退出。
// 任务与结果经 IPC 传，序列化方式是 advanced（V8 的序列化）：Buffer 与 Uint8Array 按原样的字节过去，不转成 base64 或数组。
// 实测 5 MiB 的正文：主进程一侧同步的耗时约 0.3 ms、交到子进程手里约 2 ms；JSON 加 base64 是 4 ms 与 10 ms，还要两边各编解码一遍。
// 子进程一侧用 process-task.ts 的 serveProcessTasks 接任务
import type { ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import type { ChildMessage, TaskMessage } from './process-task.ts'
import type { SemaphoreLimits } from './semaphore.ts'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Semaphore, SemaphoreBusyError } from './semaphore.ts'

export interface ProcessPoolOptions {
  /** 子进程的入口（文件地址） */
  readonly script: URL
  /** 子进程的 Node 选项（不继承主进程的，见文件开头）；堆与新生代的上限由池子加上 */
  readonly execArgv: readonly string[]
  /** 子进程数：同时执行的任务数的上限 */
  readonly processes: number
  /** 排队的上限：数量与等待的时长 */
  readonly queue: SemaphoreLimits
  /** 子进程加载的时限，与每个任务从交给子进程到回结果的时限（毫秒）：超时就结束那个子进程 */
  readonly taskTimeoutMs: number
  /** 每个子进程的 V8 老生代的上限（MiB，--max-old-space-size）：超出时 V8 中止这个子进程，任务按 out-of-memory 失败 */
  readonly heapMb: number
  /** 子进程空闲多久之后结束（毫秒，正整数） */
  readonly idleTimeoutMs: number
}

/**
 * 任务没有得到结果的原因：
 * - 没有执行：queue-full（排队满了）、wait-timeout（排队等待超时）、closed（池子已经关闭）；
 * - 执行了但没有结果：out-of-memory（子进程的堆超过上限，V8 中止了它）、timeout（加载或执行超过时限）、
 *   crashed（子进程出错、意外退出、加载不了或回了不认识的消息，cause 是原因）
 */
export type ProcessPoolFailure = 'queue-full' | 'wait-timeout' | 'closed' | 'out-of-memory' | 'timeout' | 'crashed'

export class ProcessPoolError extends Error {
  readonly reason: ProcessPoolFailure

  constructor(reason: ProcessPoolFailure, options?: ErrorOptions) {
    super(`子进程的任务没有结果：${reason}`, options)
    this.name = 'ProcessPoolError'
    this.reason = reason
  }
}

/** 子进程退出了（不是池子结束的）：退出码或信号，与标准错误的开头（V8 的内存超限、加载失败与未捕获的异常写在这里） */
export class ChildProcessExitError extends Error {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string

  constructor(exitCode: number | null, signal: NodeJS.Signals | null, stderr: string) {
    super(`子进程退出了：${signal === null ? `退出码 ${exitCode}` : `信号 ${signal}`}`)
    this.name = 'ChildProcessExitError'
    this.exitCode = exitCode
    this.signal = signal
    this.stderr = stderr
  }
}

/**
 * 新生代每个半区的上限（MiB，--max-semi-space-size）。不设时 V8 按机器的内存取（16 GiB 以上的机器是 64 MiB，新生代合计 192 MiB），
 * 堆的实际上限比 heapMb 多出将近 200 MiB；16 MiB（V8 原来在 64 位上的默认）实测检查 5 MiB 的真实形状耗时不变（约 270 ms），
 * 子进程 RSS 的峰值从约 340 MiB 降到约 220 MiB
 */
const SEMI_SPACE_MB = 16

/** 标准错误只留开头这么多字符：内存超限的说明在最前面，后面是几 KiB 的本地调用栈 */
const STDERR_HEAD_CHARS = 16 * 1024

/** V8 的堆超过上限时 Node 写到标准错误的说明（OOMErrorHandler），随后 abort（SIGABRT） */
const OUT_OF_MEMORY = /Allocation failed - (?:JavaScript heap|process) out of memory/

type Settlement = { readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: unknown }

/** 一个子进程：按需创建，出错、超时、空闲太久或关闭时丢弃 */
interface PooledChild {
  readonly process: ChildProcess
  /** 退出之后兑现（关闭时等它） */
  readonly exited: Promise<void>
  /** 回过 ready */
  ready: boolean
  /** 正在等它的那一方：等 ready 或等结果；收到消息、出错或超时时交出（只交一次） */
  waiting: { readonly expect: 'ready' | 'result', readonly settle: (settlement: Settlement) => void } | undefined
  /** 标准错误的开头 */
  stderr: string
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

/** 一个子进程的位置：子进程按需创建，丢弃之后回到 undefined */
interface Slot {
  child: PooledChild | undefined
}

export class ProcessPool<Task, Result> {
  readonly #options: ProcessPoolOptions
  readonly #permits: Semaphore
  readonly #slots: readonly Slot[]
  /** 空闲的位置：持有名额的任务取一个，结束时放回（名额数等于位置数，取的时候一定有）；后进先出 */
  readonly #idle: Slot[]
  /** 正在结束的子进程：关闭时等它们都退出 */
  readonly #exiting = new Set<Promise<void>>()
  #closed = false

  constructor(options: ProcessPoolOptions) {
    if (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1)
      throw new RangeError(`空闲的时限必须是正整数：${options.idleTimeoutMs}`)
    this.#options = options
    this.#permits = new Semaphore(options.processes, options.queue)
    this.#slots = Array.from({ length: options.processes }, (): Slot => ({ child: undefined }))
    this.#idle = [...this.#slots]
  }

  /** 现有的子进程数（含空闲的）：按需创建，出错或空闲到期之后丢弃 */
  get liveProcesses(): number {
    return this.#slots.filter(slot => slot.child !== undefined).length
  }

  /** 交给一个子进程执行，返回它的结果；没有结果时抛出 ProcessPoolError（任务不能序列化时原样抛出序列化的错误） */
  async run(task: Task): Promise<Result> {
    if (this.#closed)
      throw new ProcessPoolError('closed')
    try {
      return await this.#permits.run(async () => this.#execute(task))
    }
    catch (error) {
      if (error instanceof SemaphoreBusyError)
        throw new ProcessPoolError(error.reason, { cause: error })
      throw error
    }
  }

  /** 不再接受任务；结束全部子进程（执行中的任务按 closed 失败，排队的轮到时同样失败），等它们都退出 */
  async close(): Promise<void> {
    this.#closed = true
    for (const slot of this.#slots) {
      if (slot.child !== undefined)
        this.#discard(slot, slot.child, new ProcessPoolError('closed'))
    }
    await Promise.all(this.#exiting)
  }

  async #execute(task: Task): Promise<Result> {
    if (this.#closed)
      throw new ProcessPoolError('closed')
    const slot = this.#idle.pop()
    if (slot === undefined)
      throw new Error('子进程池的名额与空闲的位置对不上')
    try {
      const child = slot.child ?? this.#spawn(slot)
      clearTimeout(child.idleTimer)
      this.#hold(child, true)
      try {
        if (!child.ready)
          await this.#await(slot, child, 'ready', undefined)
        return await this.#await(slot, child, 'result', { type: 'task', task }) as Result
      }
      finally {
        if (slot.child === child) {
          this.#hold(child, false)
          // 空闲到期：没有在等它的任务，丢弃的原因用不上
          child.idleTimer = setTimeout(() => this.#discard(slot, child, new ProcessPoolError('closed')), this.#options.idleTimeoutMs)
          child.idleTimer.unref()
        }
      }
    }
    finally {
      this.#idle.push(slot)
    }
  }

  /** 等子进程回 expect（message 不是 undefined 时先交出它）；时限之内没回就结束这个子进程 */
  async #await(slot: Slot, child: PooledChild, expect: 'ready' | 'result', message: TaskMessage<Task> | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#discard(slot, child, new ProcessPoolError('timeout')), this.#options.taskTimeoutMs)
      timer.unref()
      child.waiting = {
        expect,
        settle: (settlement) => {
          clearTimeout(timer)
          child.waiting = undefined
          if (settlement.ok)
            resolve(settlement.value)
          else
            reject(settlement.error)
        },
      }
      if (message === undefined)
        return
      try {
        child.process.send(message, undefined, undefined, (error: Error | null) => {
          if (error !== null)
            this.#discard(slot, child, new ProcessPoolError('crashed', { cause: error }))
        })
      }
      catch (error) {
        // 任务不能序列化（DataCloneError，同步抛出、什么也没有发出去）：调用方写错了，子进程还在、照常留着
        child.waiting?.settle({ ok: false, error })
      }
    })
  }

  #spawn(slot: Slot): PooledChild {
    let subprocess: ChildProcess
    try {
      subprocess = fork(fileURLToPath(this.#options.script), [], {
        execArgv: [`--max-old-space-size=${this.#options.heapMb}`, `--max-semi-space-size=${SEMI_SPACE_MB}`, ...this.#options.execArgv],
        env: {},
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
    }
    catch (error) {
      throw new ProcessPoolError('crashed', { cause: error })
    }
    // 退出（含起不来：先 error 后 close）之后兑现；close 在标准错误读完之后才来，判断内存超限要等它
    const exited = new Promise<void>((resolve) => {
      subprocess.once('close', () => resolve())
    })
    const child: PooledChild = { process: subprocess, exited, ready: false, waiting: undefined, stderr: '', idleTimer: undefined }
    slot.child = child
    subprocess.stderr?.setEncoding('utf8')
    subprocess.stderr?.on('data', (chunk: string) => {
      if (child.stderr.length < STDERR_HEAD_CHARS)
        child.stderr += chunk.slice(0, STDERR_HEAD_CHARS - child.stderr.length)
    })
    // 管道读出错时子进程的退出照样由 close 处理；没有监听的 error 事件会让主进程抛出
    subprocess.stderr?.on('error', () => {})
    // 常驻的监听：子进程空闲时出错、退出也有人接（没有监听的 error 事件会让主进程抛出）。丢弃之后来的事件一律不管
    subprocess.on('message', (message: ChildMessage<Result> | null) => this.#received(slot, child, message))
    subprocess.on('error', (error: Error) => this.#discard(slot, child, new ProcessPoolError('crashed', { cause: error })))
    subprocess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const cause = new ChildProcessExitError(code, signal, child.stderr)
      this.#discard(slot, child, new ProcessPoolError(OUT_OF_MEMORY.test(child.stderr) ? 'out-of-memory' : 'crashed', { cause }))
    })
    this.#hold(child, false)
    return child
  }

  #received(slot: Slot, child: PooledChild, message: ChildMessage<Result> | null): void {
    if (slot.child !== child)
      return
    const waiting = child.waiting
    if (message?.type === 'error') {
      this.#discard(slot, child, new ProcessPoolError('crashed', { cause: message.error }))
      return
    }
    // 子进程只回 ready、result 与 error（process-task.ts）；别的（包括不是对象的）都算出了错，不在监听里抛出
    if (waiting === undefined || typeof message !== 'object' || message === null || message.type !== waiting.expect) {
      this.#discard(slot, child, new ProcessPoolError('crashed', { cause: new Error(`子进程回了不该回的消息：${String(message?.type)}`) }))
      return
    }
    if (message.type === 'ready') {
      child.ready = true
      waiting.settle({ ok: true, value: undefined })
      return
    }
    waiting.settle({ ok: true, value: message.value })
  }

  /** 有任务时留住主进程，空闲时不留：子进程本身、IPC 通道与标准错误的管道 */
  #hold(child: PooledChild, held: boolean): void {
    const handles: readonly ({ ref: () => unknown, unref: () => unknown } | null | undefined)[] = [child.process, child.process.channel, child.process.stderr as Socket | null]
    for (const handle of handles) {
      if (held)
        handle?.ref()
      else
        handle?.unref()
    }
  }

  /**
   * 丢弃这个子进程（结束它），等着它的一方按 error 失败。同一个子进程只处理一次：出错之后还会有 close。
   * 结束之前重新留住主进程，直到它退出（close 事件）：关闭时要等到它，空闲时的 unref 会让主进程不等它就退出
   */
  #discard(slot: Slot, child: PooledChild, error: ProcessPoolError): void {
    if (slot.child !== child)
      return
    slot.child = undefined
    clearTimeout(child.idleTimer)
    this.#hold(child, true)
    // 已经退出的再结束一次什么也不做；SIGKILL：子进程里没有要收尾的东西，同步执行中的任务也立即停下
    child.process.kill('SIGKILL')
    this.#exiting.add(child.exited)
    void child.exited.then(() => this.#exiting.delete(child.exited))
    child.waiting?.settle({ ok: false, error })
  }
}

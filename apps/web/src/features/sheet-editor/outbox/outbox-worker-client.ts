// 发件箱 Worker 的客户端（M4-P1 设计 §3.1、§3.4.8）：主线程这一侧，实现 DraftWriter——编辑器页（P2）只依赖那个接口，不知道管道在 Worker 里
// （WebKit 改在主线程放置时换成进程内的 createDraftWriter，DEF-011）。
// - 握手：一创建就发 hello（带协议版本与空定时器的开关）；ready() 交回握手的结果。
// - 按 id 对应：回复可以乱序；结果按请求的种类核对之后才交出去。每个请求有看门狗时限：IndexedDB 在 Safari 上偶尔挂住，Worker 不回应也不能
//   挂住页面（M0 审查 S5）。
// - 到点、error、messageerror、读不懂的消息、Worker 的通知、终止时：在途的全部以失败结束，之后的请求立即失败（broken() 交回原因），
//   Worker 随之终止、监听摘掉——页面按"本机写入失败"处理（P2）。只有一条消息克隆不了（postMessage 抛出）时只那一个请求失败。
// - 转移：写入的字节交出去之后归 Worker（调用方那一份随之清空）；交回的 gzip 由 Worker 转移过来。
// 只在主线程：Worker 不引用这个文件
import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { DraftWriter } from '../../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../../shared/outbox/failure.ts'
import type { LeaseClock } from '../edit-lease.ts'
import type { KeyTransfer, OutboxCall, OutboxReply, OutboxResults } from './outbox-protocol.ts'
import { describeFailure } from '../../../shared/outbox/failure.ts'
import { failedResult, OUTBOX_PROTOCOL_VERSION, readOutboxMessage, readOutboxResult } from './outbox-protocol.ts'

/**
 * Worker 坏了的原因：
 * - load-failed：起不来（创建时抛出、握手之前出错——脚本加载失败、被 CSP 拦下——或者握手回的不是 ready）；
 * - crashed：握手之后出错；
 * - message-error：消息解不开（messageerror）、读不懂、结果认不出，或者 Worker 通知它收到了解不开的消息；
 * - terminated：本页关掉了它（dispose）；
 * - timeout：有请求过了时限没有回应
 */
export type OutboxWorkerFailure = 'load-failed' | 'crashed' | 'message-error' | 'terminated' | 'timeout'

export type WorkerEventType = 'message' | 'error' | 'messageerror'

/** Worker 里客户端用到的几样（测试换成假的） */
export interface WorkerLike {
  readonly postMessage: (message: unknown, transfer: Transferable[]) => void
  readonly addEventListener: (type: WorkerEventType, listener: (event: Event) => void) => void
  readonly removeEventListener: (type: WorkerEventType, listener: (event: Event) => void) => void
  readonly terminate: () => void
}

export type OutboxWorkerReady = { readonly kind: 'ready' } | { readonly kind: 'broken', readonly failure: OutboxWorkerFailure }

export interface OutboxWorkerClient extends DraftWriter {
  /** 握手的结果：Worker 回了 ready，或者坏了及原因 */
  readonly ready: () => Promise<OutboxWorkerReady>
  /** 坏了的原因；没坏为 undefined */
  readonly broken: () => OutboxWorkerFailure | undefined
}

export interface OutboxWorkerClientOptions {
  /** 建出 Worker（生产：编辑器页的发件箱 Worker 脚本） */
  readonly create: () => WorkerLike
  /** 看门狗的计时器（编辑器页的时钟：E2E 的 page.clock 拨得动） */
  readonly clock: Pick<LeaseClock, 'schedule'>
  /** 每个请求等回应的时限（毫秒） */
  readonly requestTimeoutMs: number
  /** 空定时器（DEF-011）：默认开着；只有测试构建的对照关它（生产的 Worker 入口不认） */
  readonly keepAlive?: boolean
}

const FAILURE_MESSAGES: Readonly<Record<OutboxWorkerFailure, string>> = {
  'load-failed': '发件箱 Worker 起不来（load-failed）',
  'crashed': '发件箱 Worker 出错停下了（crashed）',
  'message-error': '发件箱 Worker 的消息解不开或认不出（message-error）',
  'terminated': '发件箱 Worker 已经关掉（terminated）',
  'timeout': '发件箱 Worker 没有在时限内回应（timeout）',
}

function brokenError(failure: OutboxWorkerFailure): FailureDescription {
  return { name: 'OutboxWorkerError', message: FAILURE_MESSAGES[failure] }
}

/**
 * 生产：编辑器页的发件箱 Worker（outbox.worker.ts）。静态的 new Worker(new URL(…), { type: 'module' }) 才会被打包成同源的模块
 * Worker 脚本（与公式 Worker 同一个写法，editor/sheet-editor.ts）；name 便于在调试工具与真实 Safari 的自检里认出它。
 * 创建本身可能抛出（被策略拦下），客户端接住、按 load-failed 处理
 */
export function createOutboxWorker(): WorkerLike {
  return new Worker(new URL('./outbox.worker.ts', import.meta.url), { type: 'module', name: 'nerve-outbox' })
}

/**
 * 本机密钥交给 Worker 的交法（设计 §3.4.8）：不可导出的 CryptoKey 经结构化克隆交过去，不转移。真实 Safari 的复核（S1）如果说不行
 * （弹钥匙串的提示、克隆失败），改为交原始字节（form: 'raw'，放进 transfer；Worker 那边已经认、导入之后清零）——只动这里
 */
export function keyTransferOf(handle: LocalKeyHandle): { readonly key: KeyTransfer, readonly transfer: Transferable[] } {
  return { key: { form: 'crypto-key', version: handle.version, key: handle.key }, transfer: [] }
}

/** 一个在途的请求 */
interface Pending {
  /** 收到回复：按请求的种类核对、交给调用方；结果认不出时交回 false（不交给调用方，由客户端当作坏了） */
  readonly answer: (reply: OutboxReply) => boolean
  /** 没等到回复就结束（Worker 坏了） */
  readonly abandon: (failure: OutboxWorkerFailure) => void
  readonly cancelTimer: () => void
}

export function createOutboxWorkerClient(options: OutboxWorkerClientOptions): OutboxWorkerClient {
  const pending = new Map<number, Pending>()
  let nextId = 0
  let failure: OutboxWorkerFailure | undefined
  let handshaken = false
  let worker: WorkerLike | undefined
  let settleReady: (ready: OutboxWorkerReady) => void = () => {}
  const readiness = new Promise<OutboxWorkerReady>((resolve) => {
    settleReady = resolve
  })

  function breakWith(reason: OutboxWorkerFailure): void {
    if (failure !== undefined)
      return
    failure = reason
    const abandoned = [...pending.values()]
    pending.clear()
    for (const entry of abandoned) {
      entry.cancelTimer()
      entry.abandon(reason)
    }
    if (worker !== undefined) {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
    }
    settleReady({ kind: 'broken', failure: reason })
  }

  function onMessage(event: Event): void {
    const message = readOutboxMessage('data' in event ? event.data : undefined)
    if (message === null || 'notice' in message) {
      breakWith('message-error')
      return
    }
    const entry = pending.get(message.id)
    // 不认识的 id：迟到的回复（那个请求已经以失败结束），不管
    if (entry === undefined)
      return
    pending.delete(message.id)
    entry.cancelTimer()
    if (!entry.answer(message)) {
      entry.abandon('message-error')
      breakWith('message-error')
    }
  }

  function onError(): void {
    breakWith(handshaken ? 'crashed' : 'load-failed')
  }

  function onMessageError(): void {
    breakWith('message-error')
  }

  /** 发一个请求、等它的回复；坏了之后立即以这种请求失败的样子结束。从不失败 */
  async function call<C extends OutboxCall>(request: C, transfer: Transferable[]): Promise<OutboxResults[C['type']]> {
    const type: C['type'] = request.type
    const target = worker
    if (failure !== undefined || target === undefined)
      return failedResult(type, brokenError(failure ?? 'load-failed'))
    const id = nextId
    nextId += 1
    return new Promise((resolve) => {
      const cancelTimer = options.clock.schedule(() => breakWith('timeout'), options.requestTimeoutMs)
      pending.set(id, {
        answer: (reply) => {
          if (!reply.ok) {
            resolve(failedResult(type, reply.error))
            return true
          }
          const result = readOutboxResult(type, reply.result)
          if (result === null)
            return false
          resolve(result)
          return true
        },
        abandon: reason => resolve(failedResult(type, brokenError(reason))),
        cancelTimer,
      })
      try {
        target.postMessage({ ...request, v: OUTBOX_PROTOCOL_VERSION, id }, transfer)
      }
      catch (error) {
        // 这一条克隆不了（DataCloneError、缓冲已经转移过）：只这一个请求失败，Worker 照常
        pending.delete(id)
        cancelTimer()
        resolve(failedResult(type, describeFailure(error)))
      }
    })
  }

  async function handshake(): Promise<void> {
    const hello = await call({ type: 'hello', keepAlive: options.keepAlive ?? true }, [])
    if (hello.kind !== 'ready') {
      breakWith('load-failed')
      return
    }
    handshaken = true
    settleReady({ kind: 'ready' })
  }

  try {
    worker = options.create()
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
  }
  catch {
    breakWith('load-failed')
  }
  void handshake()

  return {
    register: async (key, writer, force) => call({ type: 'register', draft: key, writer, force }, []),
    write: async capture => call({ type: 'write', capture }, [capture.bytes.buffer]),
    markInFlight: async (key, writer, inFlight) => call({ type: 'mark-in-flight', draft: key, writer, inFlight }, []),
    confirm: async (key, writer, confirmedSeq, revision) => call({ type: 'confirm', draft: key, writer, confirmedSeq, revision }, []),
    read: async key => call({ type: 'read', draft: key }, []),
    remove: async (key, expectedSeq) => call({ type: 'remove', draft: key, expectedSeq: expectedSeq ?? null }, []),
    setKey: async (handle) => {
      if (handle === undefined)
        return call({ type: 'set-key', key: null }, [])
      const { key, transfer } = keyTransferOf(handle)
      return call({ type: 'set-key', key }, transfer)
    },
    seedDigest: async (key, seed) => {
      await call({ type: 'seed-digest', draft: key, seed: seed ?? null }, [])
    },
    release: async (key) => {
      await call({ type: 'release', draft: key }, [])
    },
    reconcile: async userId => call({ type: 'reconcile', userId }, []),
    takeRecoveryEvents: async () => {
      const result = await call({ type: 'take-events' }, [])
      // Worker 坏了：事件跟着没了（库里写回的照样在，恢复时照常发现）
      return result.kind === 'events' ? result.events : []
    },
    dispose: () => breakWith('terminated'),
    ready: async () => readiness,
    broken: () => failure,
  }
}

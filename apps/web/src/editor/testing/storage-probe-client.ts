// 页面一侧的探针 Worker 客户端（M4-P1 S1，设计 §3.6）：起 ./storage-probe-worker.ts、按 id 对上回应、每个请求有时限。Worker 加载失败、
// 出错或回不来的消息（error、messageerror）时，在途的请求全部以失败结束，之后的请求立即失败——不挂住页面（M0 原型审查修过的坑：Worker 崩溃时
// 请求一直挂住）。Worker 交回的出错带着它那边的错误名字（例如 OperationError），场景按名字记下事实
import type { ProbeCalls, ProbeCallType } from './storage-probe-protocol.ts'
import { isProbeReply } from './storage-probe-protocol.ts'

/** 一个请求默认最多等多久（5 MiB 的写入管道在 CI 的慢机器上也在几秒以内） */
const DEFAULT_TIMEOUT_MS = 30_000

/** 客户端自己的失败：Worker 出错、回不来、超时、已经终止 */
export class ProbeWorkerError extends Error {
  override readonly name = 'ProbeWorkerError'
}

export interface ProbeCallOptions {
  /** 一起转移的（写入管道的字节） */
  readonly transfer?: readonly Transferable[]
  readonly timeoutMs?: number
}

export interface ProbeWorker {
  readonly call: <K extends ProbeCallType>(type: K, input: ProbeCalls[K]['input'], options?: ProbeCallOptions) => Promise<ProbeCalls[K]['output']>
  /** 终止 Worker；在途的请求以失败结束 */
  readonly terminate: () => void
}

interface Pending {
  readonly resolve: (output: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Worker 那边的错误：名字照原样（DOMException 的名字），场景按它记下 */
function remoteError(error: { readonly name: string, readonly message: string }): Error {
  return Object.assign(new Error(error.message), { name: error.name })
}

/** 起一个探针 Worker（每次一个新的：停顿的对照要两个条件的 Worker 不同时存在） */
export function startProbeWorker(): ProbeWorker {
  const worker = new Worker(new URL('./storage-probe-worker.ts', import.meta.url), { type: 'module', name: 'nerve-storage-probe' })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let broken: string | undefined
  const failAll = (reason: string): void => {
    broken ??= reason
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(new ProbeWorkerError(reason))
    }
  }
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const reply: unknown = event.data
    if (!isProbeReply(reply))
      return
    const entry = pending.get(reply.id)
    if (entry === undefined)
      return
    pending.delete(reply.id)
    clearTimeout(entry.timer)
    const settled = reply
    if (settled.ok)
      entry.resolve(settled.output)
    else
      entry.reject(remoteError(settled.error))
  })
  worker.addEventListener('error', (event: ErrorEvent) => {
    event.preventDefault()
    failAll(`探针 Worker 出错（加载失败或没接住的异常）：${event.message === '' ? '（浏览器没有给出说明）' : event.message}`)
  })
  worker.addEventListener('messageerror', () => failAll('探针 Worker 的回应解不开（messageerror）'))
  return {
    call: async <K extends ProbeCallType>(type: K, input: ProbeCalls[K]['input'], options: ProbeCallOptions = {}) => {
      if (broken !== undefined)
        throw new ProbeWorkerError(broken)
      const id = nextId
      nextId += 1
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      return new Promise<ProbeCalls[K]['output']>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new ProbeWorkerError(`探针 Worker ${timeoutMs / 1000} 秒内没有回应 ${type}`))
        }, timeoutMs)
        // Worker 交回的是结构化克隆的值，形状由 ProbeCalls 约定（只在测试构建里，不另做核对）
        pending.set(id, { resolve: output => resolve(output as ProbeCalls[K]['output']), reject, timer })
        try {
          worker.postMessage({ id, type, input }, [...(options.transfer ?? [])])
        }
        catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new ProbeWorkerError(String(error)))
        }
      })
    },
    terminate: () => {
      worker.terminate()
      failAll('探针 Worker 已终止')
    },
  }
}

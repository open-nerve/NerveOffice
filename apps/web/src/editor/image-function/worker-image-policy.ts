// 等公式 Worker 回报 IMAGE() 限制的安装结果（P4 设计 §3.6.7）：回报 ok 才算 Worker 这边就绪。
// 回报也顺带证明 Worker 已经启动、收到了工作簿；脚本加载失败（404、CSP）、执行出错、消息无法解析，都按 Worker 起不来处理。
// M4-P5：从监听开始计握手期限；成功之后继续监听错误，直到实例销毁。首错锁存，页面订阅前的错误也能读到。
import type { FormulaWorkerFailure } from '../formula-worker-failure.ts'
import { deferred } from '../async-tools.ts'
import { FORMULA_WORKER_READY_TIMEOUT_MS, FormulaWorkerError } from '../formula-worker-failure.ts'
import { readImagePolicyReport } from './worker-report.ts'

export interface WorkerImagePolicy {
  readonly installed: Promise<void>
  /** 首个故障；订阅不回放，调用方订阅之后再读它以补齐接线间隙。 */
  readonly failure: () => FormulaWorkerFailure | undefined
  readonly onFailure: (listener: (failure: FormulaWorkerFailure) => void) => () => void
  /** 实例销毁或放弃加载时移除监听和期限；成功回报之后仍须保留运行期监听。 */
  readonly dispose: () => void
}

export function watchWorkerImagePolicy(worker: Pick<Worker, 'addEventListener' | 'removeEventListener'>): WorkerImagePolicy {
  const installed = deferred<void>()
  // 挂载的同步部分可能先抛出别的错误、还没来得及等待 installed；保留原 Promise 的失败，同时不留下无人接住的拒绝。
  void installed.promise.catch(() => undefined)
  const listeners = new Set<(failure: FormulaWorkerFailure) => void>()
  let ready = false
  let disposed = false
  let failure: FormulaWorkerFailure | undefined
  const timer = setTimeout(fail, FORMULA_WORKER_READY_TIMEOUT_MS, 'ready-timeout')

  function fail(reason: FormulaWorkerFailure): void {
    if (disposed || failure !== undefined)
      return
    failure = reason
    clearTimeout(timer)
    if (!ready)
      installed.reject(new FormulaWorkerError(reason))
    for (const listener of [...listeners]) {
      if (disposed)
        break
      try {
        listener(reason)
      }
      catch (error) {
        reportError(error)
      }
    }
  }

  const onMessage = (event: MessageEvent): void => {
    if (disposed || ready || failure !== undefined)
      return
    const report = readImagePolicyReport(event.data)
    if (report === null)
      return
    if (report.ok) {
      ready = true
      clearTimeout(timer)
      installed.resolve()
    }
    else {
      fail('image-policy')
    }
  }
  const onError = (event: Event): void => {
    // 这个 Worker 的错误由明确的启动失败/运行期信号接住；不同时冒泡成未处理页面错误，也不处理其他来源的异常。
    event.preventDefault()
    if (event.type === 'messageerror')
      fail(ready ? 'messageerror-after-ready' : 'messageerror-before-ready')
    else
      fail(ready ? 'error-after-ready' : 'error-before-ready')
  }
  worker.addEventListener('message', onMessage)
  worker.addEventListener('error', onError)
  worker.addEventListener('messageerror', onError)
  return {
    installed: installed.promise,
    failure: () => failure,
    onFailure(listener) {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      listeners.clear()
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onError)
    },
  }
}

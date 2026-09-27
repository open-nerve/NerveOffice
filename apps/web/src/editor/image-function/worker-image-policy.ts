// 等公式 Worker 回报 IMAGE() 限制的安装结果（P4 设计 §3.6.7）：回报 ok 才算 Worker 这边就绪。
// 回报也顺带证明 Worker 已经启动、收到了工作簿；脚本加载失败（404、CSP）、执行出错、消息无法解析，都按 Worker 起不来处理。
// 超时由调用方统一计算（编辑器就绪的时限）
import { deferred } from '../async-tools.ts'
import { SheetEditorLoadError } from '../sheet-editor-error.ts'
import { readImagePolicyReport } from './worker-report.ts'

export interface WorkerImagePolicy {
  readonly installed: Promise<void>
  /** 不再需要结果时移除监听（就绪之后，或者放弃加载时） */
  readonly dispose: () => void
}

export function watchWorkerImagePolicy(worker: Pick<Worker, 'addEventListener' | 'removeEventListener'>): WorkerImagePolicy {
  const installed = deferred<void>()
  const onMessage = (event: MessageEvent): void => {
    const report = readImagePolicyReport(event.data)
    if (report === null)
      return
    if (report.ok)
      installed.resolve()
    else
      installed.reject(new SheetEditorLoadError('image-policy-failed', '公式 Worker 里没有装上 IMAGE() 的限制'))
  }
  const onError = (event: Event): void => {
    installed.reject(new SheetEditorLoadError('worker-failed', `公式 Worker 起不来（${event.type}）`))
  }
  worker.addEventListener('message', onMessage)
  worker.addEventListener('error', onError)
  worker.addEventListener('messageerror', onError)
  return {
    installed: installed.promise,
    dispose() {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onError)
    },
  }
}

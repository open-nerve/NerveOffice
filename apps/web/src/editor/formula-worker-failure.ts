// 公式 Worker 的故障事实（M4-P5）：浏览器 error 不能区分加载失败和脚本执行失败，不猜测更细的原因。
// 只读的有限种类给页面决定退路；异常的原文不属于诊断上报的契约。
import { SheetEditorLoadError } from './sheet-editor-error.ts'

export type FormulaWorkerFailure
  = | 'create'
    | 'error-before-ready'
    | 'messageerror-before-ready'
    | 'ready-timeout'
    | 'image-policy'
    | 'error-after-ready'
    | 'messageerror-after-ready'

/** Worker 必须在原有的 20 秒内回报 IMAGE 限制已经安装；普通 RPC 消息不能延长期限。 */
export const FORMULA_WORKER_READY_TIMEOUT_MS = 20_000

export class FormulaWorkerError extends SheetEditorLoadError {
  readonly failure: FormulaWorkerFailure

  constructor(failure: FormulaWorkerFailure, options?: { cause?: unknown }) {
    super(failure === 'image-policy' ? 'image-policy-failed' : 'worker-failed', `公式 Worker 不可用（${failure}）`, options)
    this.name = 'FormulaWorkerError'
    this.failure = failure
  }
}

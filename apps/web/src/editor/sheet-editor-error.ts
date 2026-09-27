// 编辑器没能进入编辑的原因（P4 设计 §3.6.1）：页面对所有原因都显示"编辑器加载失败"，不进入编辑；原因用于日志与测试
export type SheetEditorFailure
  /** 快照不是 JSON 对象，或者没有工作簿的基本结构 */
  = | 'snapshot-invalid'
  /** SDK 用快照创建工作簿时出错 */
    | 'create-failed'
  /** 创建出的工作簿的 unitId 与快照的 id 不同 */
    | 'unit-mismatch'
  /** 公式 Worker 起不来（脚本加载失败、执行出错、消息无法解析） */
    | 'worker-failed'
  /** IMAGE() 的限制在主线程或 Worker 里没有装上 */
    | 'image-policy-failed'
  /** 到时限还没有全部就绪（渲染、两处 IMAGE() 的限制） */
    | 'ready-timeout'

export class SheetEditorLoadError extends Error {
  readonly reason: SheetEditorFailure

  constructor(reason: SheetEditorFailure, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SheetEditorLoadError'
    this.reason = reason
  }
}

// 真实浏览器复核调用生产发件箱的那一部分（M4-P1 设计 §3.6 第 9 项的生产 Worker、第 11 项）交给页面自检的形状：editor/testing 不能引用
// features，生产的发件箱在 features/sheet-editor/outbox；页面自检的挂接（features/sheet-editor/selftest-hook.ts）动态引入那一侧的实现
// （outbox/testing/outbox-review-probe.ts）、按这里的形状交进 SelftestHost（类型在两边各写一份、结构一致，挂接那里由类型检查核对）。
// 只有类型，不引用任何模块

/** 生产的发件箱 Worker 的一次写入：结果的种类（written 是写成了）、页面这一侧的往返（毫秒）、交回的 gzip 的字节数（没有时 null） */
export interface OutboxReviewWrite {
  readonly kind: string
  readonly roundTripMs: number
  readonly gzipBytes: number | null
}

/** 一个生产的发件箱 Worker（带空定时器）：握手的结果（ready，或坏了的原因）、写一份（字节转移过去）、关掉 */
export interface OutboxReviewWorker {
  readonly ready: string
  readonly write: (bytes: Uint8Array<ArrayBuffer>) => Promise<OutboxReviewWrite>
  readonly dispose: () => void
}

/** 进程内走一遍生产的写入与恢复（磁盘上）：各段的毫秒与核对；problem 是没走完时的原因 */
export interface OutboxReviewSegments {
  readonly rawBytes: number
  readonly gzipBytes: number
  readonly digestMs: number
  readonly gzipMs: number
  readonly sealMs: number
  readonly storeWriteMs: number
  readonly rawStrictMs: number
  readonly rawDefaultMs: number
  readonly strictAttribute: string | null
  readonly defaultAttribute: string | null
  readonly readMs: number
  readonly openMs: number
  readonly gunzipMs: number
  readonly parseMs: number
  readonly roundTrip: boolean
  readonly problem: string | undefined
}

export interface OutboxReviewApi {
  readonly startWorker: () => Promise<OutboxReviewWorker>
  readonly segments: (bytes: Uint8Array<ArrayBuffer>) => Promise<OutboxReviewSegments>
  readonly cleanup: () => Promise<void>
}

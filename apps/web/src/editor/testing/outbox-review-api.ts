// 真实浏览器复核调用生产发件箱的那一部分（M4-P1 设计 §3.6 第 9 项的生产 Worker、第 11 项）交给页面自检的形状：editor/testing 不能引用
// features，生产的发件箱在 features/sheet-editor/outbox；页面自检的挂接（features/sheet-editor/selftest-hook.ts）动态引入那一侧的实现
// （outbox/testing/outbox-review-probe.ts）、按这里的形状交进 SelftestHost（类型在两边各写一份、结构一致，挂接那里由类型检查核对）。
// 只有类型，不引用任何模块

/**
 * 生产的发件箱 Worker 的一次写入：结果的种类（written 是写成了）、页面这一侧的往返（毫秒）、交回的 gzip 的字节数（没有时 null）、
 * OPFS 的镜像（写成时：mirrored，或 not-mirrored:<原因>——这个上下文没有 OPFS 时是 not-mirrored:unsupported；没写成时 null）
 */
export interface OutboxReviewWrite {
  readonly kind: string
  readonly roundTripMs: number
  readonly gzipBytes: number | null
  readonly mirror: string | null
}

/**
 * 一个生产的发件箱 Worker（带空定时器）：握手的结果（ready，或坏了的原因）、登记时镜像拿到句柄了没有（同上的写法；没登记时 null）、
 * 写一份（字节转移过去）、关掉
 */
export interface OutboxReviewWorker {
  readonly ready: string
  readonly registerMirror: string | null
  readonly write: (bytes: Uint8Array<ArrayBuffer>) => Promise<OutboxReviewWrite>
  readonly dispose: () => void
}

/** 进程内走一遍生产的写入与恢复（磁盘上），接着 OPFS 的镜像：各段的毫秒与核对；problem 是没走完时的原因 */
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
  /** OPFS 的镜像这一次：mirrored；这个上下文没有 OPFS 时 not-mirrored:unsupported */
  readonly mirror: string
  /**
   * 镜像的各段（在测试 Worker 里调用生产的镜像；没写成、没读的为 null）：登记（拿句柄、读两个槽位并校验）、整个写入（编码、截断、
   * 写内容、写头、flush）、其中截断与写、其中 flush；读两个槽位并校验（临时拿句柄）、其中拿句柄、与库里那一份比对
   */
  readonly mirrorAttachMs: number | null
  readonly mirrorWriteMs: number | null
  readonly mirrorIoMs: number | null
  readonly mirrorFlushMs: number | null
  readonly mirrorReadMs: number | null
  readonly mirrorOpenMs: number | null
  readonly mirrorCompareMs: number | null
  readonly mirrorSlots: string | null
  readonly roundTrip: boolean
  readonly problem: string | undefined
}

export interface OutboxReviewApi {
  readonly startWorker: () => Promise<OutboxReviewWorker>
  readonly segments: (bytes: Uint8Array<ArrayBuffer>) => Promise<OutboxReviewSegments>
  /** 收尾；交回 OPFS 里的镜像目录删成了没有：removed、unsupported（没有 OPFS）、busy（到点还被占着）、failed:<名字> */
  readonly cleanup: () => Promise<string>
}

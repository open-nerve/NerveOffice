// 捕获规则的参考实现（M3-P4 设计 §3.2；S1 真实 Safari 复核用）：自动保存实现之前，页面自检（./selftest-capture.ts）按它决定什么时候捕获，
// 核对捕获里的公式值与按定义算出的一致。S3 的正式实现是 features/sheet-editor/capture-policy.ts（纯函数、时钟注入）；
// 两边按同一份设计写，S3 之后自检改用正式的那一份，这一份删掉。只在测试构建里（editor/testing/，生产构建里没有）。
// 记号（设计 §3.2）：seq 本地修改序号；capturedSeq 最近一次捕获时的序号；firstUncapturedAt 最近一次捕获之后第一处修改的时刻；
// lastChangeAt；组合输入的 composing 与 lastCompositionEndAt；settled 公式收齐（编辑器的跟踪器）。
// 1. seq > capturedSeq：
//    - 静默可捕：距 max(lastChangeAt, lastCompositionEndAt) 满 quietMs、settled、不在组字 → 捕获，不带标记；
//    - 上限：距 firstUncapturedAt 满 maxMs → 照常捕获，formulasPending = !settled（组字中写进模型的拼音不打标记，由下一次捕获覆盖）；
//    - 否则到两者中较早的时刻再看；修改、公式进度、组合结束时立即再看。
// 2. seq == capturedSeq、最近一次捕获带标记，而现在 settled、不在组字 → 补捕获（不另等防抖）。
// 这里只给出"现在该做什么"；捕获本身（同步的 JSON.stringify(save())，序号在同一个同步段里读）由调用方做。

/** 设计 §3.1 的捕获常量（contracts 的 AUTOSAVE_CAPTURE_QUIET_MS、AUTOSAVE_CAPTURE_MAX_MS 由 S3 加；这里先写设计里的值） */
export const CAPTURE_QUIET_MS = 1_000
export const CAPTURE_MAX_MS = 3_000

export interface CaptureLimits {
  /** 修改（与组合结束）之后静默多久可以捕获 */
  readonly quietMs: number
  /** 从第一处未捕获的修改算起最长多久必须捕获（公式没收齐就带标记） */
  readonly maxMs: number
}

export const CAPTURE_LIMITS: CaptureLimits = { quietMs: CAPTURE_QUIET_MS, maxMs: CAPTURE_MAX_MS }

/** 判断用的状态（时刻都是同一个时钟的毫秒数，例如 performance.now()） */
export interface CaptureState {
  readonly now: number
  readonly seq: number
  readonly capturedSeq: number
  /** 最近一次捕获之后第一处修改的时刻；seq > capturedSeq 时必须有 */
  readonly firstUncapturedAt: number | undefined
  /** 最近一次修改的时刻；seq > capturedSeq 时必须有 */
  readonly lastChangeAt: number | undefined
  /** 正在组字（compositionstart 之后、compositionend 之前） */
  readonly composing: boolean
  /** 最近一次组合结束的时刻；没有过时为 undefined */
  readonly lastCompositionEndAt: number | undefined
  /** 公式收齐 */
  readonly settled: boolean
  /** 最近一次捕获带"公式待更新" */
  readonly lastCaptureFlagged: boolean
}

export type CaptureReason = 'quiet' | 'cap' | 'recapture'

export type CaptureDecision
  /** 现在捕获 */
  = | { readonly kind: 'capture', readonly reason: CaptureReason, readonly formulasPending: boolean }
  /** 到 until 再看（undefined：没有定时要等，只等修改、公式进度、组合结束这些事件）；blockedBy 说明为什么现在不捕获 */
    | { readonly kind: 'wait', readonly until: number | undefined, readonly blockedBy: readonly ('quiet' | 'formulas' | 'composition')[] }
  /** 全部捕获过了，没有要补的 */
    | { readonly kind: 'idle' }

export class CaptureStateError extends Error {
  override readonly name = 'CaptureStateError'
}

/** 现在该做什么（设计 §3.2 的规则） */
export function decideCapture(state: CaptureState, limits: CaptureLimits = CAPTURE_LIMITS): CaptureDecision {
  const { now, seq, capturedSeq, composing, settled } = state
  if (seq > capturedSeq) {
    if (state.firstUncapturedAt === undefined || state.lastChangeAt === undefined)
      throw new CaptureStateError('有未捕获的修改，却没有第一处或最近一次修改的时刻')
    const quietSince = Math.max(state.lastChangeAt, state.lastCompositionEndAt ?? Number.NEGATIVE_INFINITY)
    const quietAt = quietSince + limits.quietMs
    const capAt = state.firstUncapturedAt + limits.maxMs
    if (now >= quietAt && settled && !composing)
      return { kind: 'capture', reason: 'quiet', formulasPending: false }
    if (now >= capAt)
      return { kind: 'capture', reason: 'cap', formulasPending: !settled }
    const blockedBy: ('quiet' | 'formulas' | 'composition')[] = []
    if (now < quietAt)
      blockedBy.push('quiet')
    if (!settled)
      blockedBy.push('formulas')
    if (composing)
      blockedBy.push('composition')
    // 静默的时刻已过、只差公式或组字时，定时只剩上限；公式收齐与组合结束是事件
    return { kind: 'wait', until: now < quietAt ? Math.min(quietAt, capAt) : capAt, blockedBy }
  }
  if (state.lastCaptureFlagged) {
    if (settled && !composing)
      return { kind: 'capture', reason: 'recapture', formulasPending: false }
    return { kind: 'wait', until: undefined, blockedBy: [...(settled ? [] : ['formulas' as const]), ...(composing ? ['composition' as const] : [])] }
  }
  return { kind: 'idle' }
}

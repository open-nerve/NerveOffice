// 捕获的规则（00 号计划书 §7.3，M3-P4 设计 §3.2）写成纯函数：给出此刻的状态与"现在"，回答现在捕获（带不带"公式待更新"）、补捕获、
// 到某个时刻再看，或者没有要捕获的。不依赖 Univer、不读时钟，表驱动地单元测试（capture-policy.test.ts）；调度在 autosave.ts。
// 规则（记号见 CaptureState）：
// 1. 有没捕获的修改（seq > capturedSeq）：
//    - 静默：距 max(最后一次修改, 最后一次组合输入结束) 满 quietMs、公式收齐、不在组字 → 捕获，不带标记；
//    - 上限：距最近一次捕获之后的第一处修改满 maxMs → 照常捕获，公式没收齐就带上"公式待更新"（组字中写进模型的拼音不打标记，
//      由下一次捕获覆盖：组合结束时的输入本身是一次修改）；
//    - 否则到两者中较早的那一刻再看（公式没收齐、正在组字时静默不算数，只等上限）；修改、公式进度、组合结束由调度立即再看；
// 2. 捕获覆盖了全部修改、最近一次捕获带标记（没捕获过时是进入编辑时服务端给的标记），而现在公式收齐、不在组字 → 补捕获，不另等静默
//    （M0-P6 原型的做法）；
// 3. 大文档拉长间隔（计划书 §7.2）：上一次捕获结束之后，至少隔开它的耗时的 spacingFactor 倍才再捕获——上面任何一条到了都推到那一刻。
// 立即上传（保存按钮、退出编辑、切到后台等，设计 §3.4）不经这里：它们按自己的规则当场捕获。
import { AUTOSAVE_CAPTURE_MAX_MS, AUTOSAVE_CAPTURE_QUIET_MS, AUTOSAVE_CAPTURE_SPACING_FACTOR } from '@nerve-office/contracts'

export interface CaptureLimits {
  /** 捕获的静默（毫秒） */
  readonly quietMs: number
  /** 捕获的上限（毫秒）：从最近一次捕获之后的第一处修改算起 */
  readonly maxMs: number
  /** 两次捕获之间至少隔开上一次捕获耗时的这么多倍 */
  readonly spacingFactor: number
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  quietMs: AUTOSAVE_CAPTURE_QUIET_MS,
  maxMs: AUTOSAVE_CAPTURE_MAX_MS,
  spacingFactor: AUTOSAVE_CAPTURE_SPACING_FACTOR,
}

/** 此刻的状态。时刻都在调度的时钟（单调）上，毫秒 */
export interface CaptureState {
  /** 本地修改序号 */
  readonly seq: number
  /** 最近一次捕获时的修改序号（没捕获过时是基线：进入编辑时的序号） */
  readonly capturedSeq: number
  /** 最近一次捕获之后第一处修改的时刻；之后没有修改时为 undefined */
  readonly firstUncapturedAt: number | undefined
  /** 最后一次修改的时刻；进入编辑之后没有修改过时为 undefined */
  readonly lastChangeAt: number | undefined
  /** 正在组合输入（输入法组字中） */
  readonly composing: boolean
  /** 最后一次组合输入结束的时刻；没有过时为 undefined */
  readonly lastCompositionEndAt: number | undefined
  /** 公式收齐（formula-settle-tracker.ts 的三个条件） */
  readonly settled: boolean
  /** 最近一次捕获带"公式待更新"；没捕获过时是进入编辑时服务端给的标记（带标记的文档进入编辑时强制重算，收齐之后补存，设计 §3.5） */
  readonly capturePending: boolean
  /** 上一次捕获的耗时与结束的时刻（大文档拉长间隔）；没捕获过时为 undefined */
  readonly lastCapture: { readonly durationMs: number, readonly endedAt: number } | undefined
}

/**
 * 捕获的原因：quiet 静默满了；cap 到了上限（可能带标记）；formulas 补捕获（最近一次带标记，公式收齐了）
 */
export type CaptureReason = 'quiet' | 'cap' | 'formulas'

export type CaptureDecision
  /** 现在捕获；formulasPending 是这次捕获算不算"公式待更新" */
  = | { readonly kind: 'capture', readonly reason: CaptureReason, readonly formulasPending: boolean }
  /** 现在还不能捕获：到 until 再看（修改、公式进度、组合结束时调度会提前再看） */
    | { readonly kind: 'wait', readonly until: number }
  /** 没有要捕获的：等下一处修改或下一个信号 */
    | { readonly kind: 'idle' }

/** 规则 1、2（不计大文档的间隔） */
function baseDecision(state: CaptureState, now: number, limits: CaptureLimits): CaptureDecision {
  if (state.seq > state.capturedSeq) {
    // 第一处没捕获的修改的时刻由调度在修改时记下；万一没有，按最后一次修改算（上限只会更晚）；连它也没有时当作早已到了上限，
    // 宁可早捕获，不让上限随"现在"一直往后挪
    const firstAt = state.firstUncapturedAt ?? state.lastChangeAt ?? Number.NEGATIVE_INFINITY
    const capDue = firstAt + limits.maxMs
    const quietFrom = Math.max(state.lastChangeAt ?? Number.NEGATIVE_INFINITY, state.lastCompositionEndAt ?? Number.NEGATIVE_INFINITY)
    const quietDue = quietFrom + limits.quietMs
    // 公式没收齐、正在组字时静默不算数：只等上限（收齐与组合结束由调度立即再看）
    const quietCounts = state.settled && !state.composing
    if (quietCounts && now >= quietDue)
      return { kind: 'capture', reason: 'quiet', formulasPending: false }
    if (now >= capDue)
      return { kind: 'capture', reason: 'cap', formulasPending: !state.settled }
    return { kind: 'wait', until: quietCounts ? Math.min(quietDue, capDue) : capDue }
  }
  if (state.capturePending && state.settled && !state.composing)
    return { kind: 'capture', reason: 'formulas', formulasPending: false }
  return { kind: 'idle' }
}

/** 按此刻的状态决定捕获（见文件头）。纯函数 */
export function decideCapture(state: CaptureState, now: number, limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS): CaptureDecision {
  const decision = baseDecision(state, now, limits)
  // 规则 3：上一次捕获之后至少隔开它的耗时的 spacingFactor 倍；之前任何捕获都推到那一刻（等的时刻也不早于它）
  const earliest = state.lastCapture === undefined ? Number.NEGATIVE_INFINITY : state.lastCapture.endedAt + limits.spacingFactor * state.lastCapture.durationMs
  if (decision.kind === 'capture' && now < earliest)
    return { kind: 'wait', until: earliest }
  if (decision.kind === 'wait')
    return { kind: 'wait', until: Math.max(decision.until, earliest) }
  return decision
}

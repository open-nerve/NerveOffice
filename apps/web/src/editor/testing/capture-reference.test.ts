// 捕获规则的参考实现（capture-reference.ts，设计 §3.2）：表驱动，逐条核对静默、上限、组字、补捕获与"下一次什么时候再看"
import type { CaptureDecision, CaptureState } from './capture-reference.ts'
import { describe, expect, it } from 'vitest'
import { CAPTURE_LIMITS, CAPTURE_MAX_MS, CAPTURE_QUIET_MS, CaptureStateError, decideCapture } from './capture-reference.ts'

/** 第一处修改在 1000，最近一次在 1500（seq 2，capturedSeq 0），没有组字，公式收齐 */
const BASE: CaptureState = {
  now: 1500,
  seq: 2,
  capturedSeq: 0,
  firstUncapturedAt: 1000,
  lastChangeAt: 1500,
  composing: false,
  lastCompositionEndAt: undefined,
  settled: true,
  lastCaptureFlagged: false,
}

function at(now: number, overrides: Partial<CaptureState> = {}): CaptureState {
  return { ...BASE, now, ...overrides }
}

describe('捕获规则（设计 §3.2）', () => {
  it('常量：停 1 秒、最长 3 秒', () => {
    expect([CAPTURE_QUIET_MS, CAPTURE_MAX_MS]).toEqual([1000, 3000])
    expect(CAPTURE_LIMITS).toEqual({ quietMs: 1000, maxMs: 3000 })
  })

  it.each<[string, CaptureState, CaptureDecision]>([
    ['刚改完：等到静默的时刻（最近一次修改 + 1 秒）', at(1500), { kind: 'wait', until: 2500, blockedBy: ['quiet'] }],
    ['静默差一点', at(2499), { kind: 'wait', until: 2500, blockedBy: ['quiet'] }],
    ['静默满 1 秒、公式收齐、不在组字：捕获，不带标记', at(2500), { kind: 'capture', reason: 'quiet', formulasPending: false }],
    ['静默满了、公式没收齐：只剩上限的定时（第一处修改 + 3 秒），收齐是事件', at(2500, { settled: false }), { kind: 'wait', until: 4000, blockedBy: ['formulas'] }],
    ['还没静默、公式也没收齐：先等静默的时刻', at(2000, { settled: false }), { kind: 'wait', until: 2500, blockedBy: ['quiet', 'formulas'] }],
    ['上限到了、公式没收齐：照常捕获，带"公式待更新"', at(4000, { settled: false }), { kind: 'capture', reason: 'cap', formulasPending: true }],
    ['一直在改（还没静默）、上限到了：照常捕获；公式收齐就不带标记', at(4000, { lastChangeAt: 3900 }), { kind: 'capture', reason: 'cap', formulasPending: false }],
    ['一直在改、上限比静默早：等上限', at(3800, { lastChangeAt: 3700 }), { kind: 'wait', until: 4000, blockedBy: ['quiet'] }],
    ['正在组字：静默满了也不捕获，只剩上限的定时', at(2600, { composing: true }), { kind: 'wait', until: 4000, blockedBy: ['composition'] }],
    ['正在组字、上限到了：照常捕获（拼音不打标记，由下一次捕获覆盖）', at(4000, { composing: true }), { kind: 'capture', reason: 'cap', formulasPending: false }],
    ['组合结束不满 1 秒：静默从组合结束算', at(2600, { lastCompositionEndAt: 2000 }), { kind: 'wait', until: 3000, blockedBy: ['quiet'] }],
    ['组合结束满 1 秒：捕获', at(3000, { lastCompositionEndAt: 2000 }), { kind: 'capture', reason: 'quiet', formulasPending: false }],
    ['组合结束早于最近一次修改：静默从修改算', at(2500, { lastCompositionEndAt: 1200 }), { kind: 'capture', reason: 'quiet', formulasPending: false }],
    ['全部捕获过、上一次不带标记：没有要做的', at(9000, { capturedSeq: 2 }), { kind: 'idle' }],
    ['全部捕获过、上一次带标记、现在收齐：补捕获（不另等防抖）', at(9000, { capturedSeq: 2, lastCaptureFlagged: true }), { kind: 'capture', reason: 'recapture', formulasPending: false }],
    ['上一次带标记、还没收齐：只等事件', at(9000, { capturedSeq: 2, lastCaptureFlagged: true, settled: false }), { kind: 'wait', until: undefined, blockedBy: ['formulas'] }],
    ['上一次带标记、收齐了但在组字：等组合结束', at(9000, { capturedSeq: 2, lastCaptureFlagged: true, composing: true }), { kind: 'wait', until: undefined, blockedBy: ['composition'] }],
  ])('%s', (_name, state, expected) => {
    expect(decideCapture(state)).toEqual(expected)
  })

  it('有新的修改时，上一次的标记不另外补捕获：按静默与上限的规则捕获新的内容（规则 1 先于规则 2）', () => {
    expect(decideCapture(at(1600, { capturedSeq: 1, lastCaptureFlagged: true, firstUncapturedAt: 1500 }))).toEqual({ kind: 'wait', until: 2500, blockedBy: ['quiet'] })
  })

  it('调小的上限（自检的"超过上限"用 50 毫秒，M0 的做法）', () => {
    expect(decideCapture(at(1050, { lastChangeAt: 1000, settled: false }), { quietMs: 1000, maxMs: 50 })).toEqual({ kind: 'capture', reason: 'cap', formulasPending: true })
  })

  it('有未捕获的修改却没有修改的时刻：调用方写错了，抛错', () => {
    expect(() => decideCapture(at(2000, { lastChangeAt: undefined }))).toThrow(CaptureStateError)
    expect(() => decideCapture(at(2000, { firstUncapturedAt: undefined }))).toThrow(CaptureStateError)
  })
})

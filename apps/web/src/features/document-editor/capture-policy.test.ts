import type { CaptureDecision, CaptureState } from './capture-policy.ts'
import { describe, expect, it } from 'vitest'
import { decideCapture, DEFAULT_CAPTURE_LIMITS } from './capture-policy.ts'

/**
 * 基线：最近一次捕获在序号 3（10_000 时结束，耗时 5 毫秒），之后没有修改、公式收齐、不在组字、不带标记。
 * 时刻都是毫秒；用例只写与基线不同的几项
 */
const BASE: CaptureState = {
  seq: 3,
  capturedSeq: 3,
  firstUncapturedAt: undefined,
  lastChangeAt: 9_000,
  composing: false,
  lastCompositionEndAt: undefined,
  settled: true,
  capturePending: false,
  lastCapture: { durationMs: 5, endedAt: 10_000 },
}

/** 序号 3 之后在 t 时刻改了一处（第一处没捕获的修改） */
function changedAt(t: number, more: Partial<CaptureState> = {}): CaptureState {
  return { ...BASE, seq: 4, firstUncapturedAt: t, lastChangeAt: t, ...more }
}

const quiet = (formulasPending = false): CaptureDecision => ({ kind: 'capture', reason: 'quiet', formulasPending })
const cap = (formulasPending: boolean): CaptureDecision => ({ kind: 'capture', reason: 'cap', formulasPending })
const formulas: CaptureDecision = { kind: 'capture', reason: 'formulas', formulasPending: false }
const wait = (until: number): CaptureDecision => ({ kind: 'wait', until })
const IDLE: CaptureDecision = { kind: 'idle' }

describe('参数（contracts 的 AUTOSAVE_*）', () => {
  it('静默 1 秒、上限 3 秒、大文档的间隔是捕获耗时的 10 倍', () => {
    expect(DEFAULT_CAPTURE_LIMITS).toEqual({ quietMs: 1000, maxMs: 3000, spacingFactor: 10 })
  })
})

describe('静默（计划书 §7.3：修改停下 1 秒、公式收齐、不在组字）', () => {
  it.each<[string, CaptureState, number, CaptureDecision]>([
    ['打开之后没有修改：没有要捕获的', BASE, 20_000, IDLE],
    ['改了一处、还不到 1 秒：到 1 秒那一刻再看', changedAt(20_000), 20_400, wait(21_000)],
    ['刚好满 1 秒：捕获，不带标记', changedAt(20_000), 21_000, quiet()],
    ['满 1 秒之后很久才来看（例如计时器被推迟）：照样捕获', changedAt(20_000), 26_000, quiet()],
    // 期间又改：第一处没捕获的修改不变（上限照旧），最后一次修改换成新的，静默从它重新算
    ['静默窗口内又改了一处：静默从后一处重新算', changedAt(20_000, { seq: 5, lastChangeAt: 20_700 }), 21_000, wait(21_700)],
    ['又改之后满 1 秒：捕获', changedAt(20_000, { seq: 5, lastChangeAt: 20_700 }), 21_700, quiet()],
  ])('%s', (_case, state, now, expected) => {
    expect(decideCapture(state, now)).toEqual(expected)
  })
})

describe('上限（计划书 §7.3：从最近一次捕获之后的第一处修改算起最长 3 秒）', () => {
  it.each<[string, CaptureState, number, CaptureDecision]>([
    // 每 0.5 秒改一处、一直不停：静默总也满不了，第一处之后 3 秒照常捕获
    ['持续编辑：等的是两者较早的那一刻', changedAt(20_000, { seq: 8, lastChangeAt: 22_500 }), 22_600, wait(23_000)],
    ['持续编辑满 3 秒：捕获，公式收齐时不带标记', changedAt(20_000, { seq: 9, lastChangeAt: 22_900 }), 23_000, cap(false)],
    ['持续编辑满 3 秒、公式还在算：照常捕获，带上"公式待更新"', changedAt(20_000, { seq: 9, lastChangeAt: 22_900, settled: false }), 23_000, cap(true)],
    // 第一处没捕获的修改的时刻缺了（不该发生）：按最后一次修改算，上限只会更晚；连它也缺了就当作早已到了上限
    ['第一处的时刻缺了：按最后一次修改算上限', { ...changedAt(20_000, { settled: false, lastChangeAt: 20_500 }), firstUncapturedAt: undefined }, 22_000, wait(23_500)],
    ['修改的时刻都缺了：当作早已到了上限，立即捕获', { ...changedAt(20_000, { settled: false }), firstUncapturedAt: undefined, lastChangeAt: undefined }, 22_000, cap(true)],
  ])('%s', (_case, state, now, expected) => {
    expect(decideCapture(state, now)).toEqual(expected)
  })
})

describe('公式没收齐（M0 的"静默窗口内再改一次""计算进行中再改一次"）', () => {
  it.each<[string, CaptureState, number, CaptureDecision]>([
    ['静默满了、公式还在算：不捕获，只等上限（收齐时由调度立即再看）', changedAt(20_000, { settled: false }), 21_500, wait(23_000)],
    ['公式在上限之前收齐了：静默早已满，立即捕获，不带标记', changedAt(20_000), 21_500, quiet()],
    // 计算进行中又改了一处：没收齐，静默从后一处算，上限仍从第一处算
    ['计算进行中又改：只等上限', changedAt(20_000, { seq: 5, lastChangeAt: 21_200, settled: false }), 21_300, wait(23_000)],
    ['计算进行中又改、之后收齐了：静默从后一处算', changedAt(20_000, { seq: 5, lastChangeAt: 21_200 }), 21_300, wait(22_200)],
  ])('%s', (_case, state, now, expected) => {
    expect(decideCapture(state, now)).toEqual(expected)
  })
})

describe('组合输入（计划书 §7.3：组字中不捕获，静默从最后一次修改与最后一次组合结束中较晚的算起，上限同时约束它）', () => {
  it.each<[string, CaptureState, number, CaptureDecision]>([
    // 批注的输入框组字时按 300 ms 防抖把拼音写进模型：这是一处修改，但正在组字，静默不算数
    ['组字中：静默满了也不捕获，只等上限', changedAt(20_000, { composing: true }), 21_500, wait(23_000)],
    ['组字中到了上限：照常捕获；组字中的拼音不打标记（由下一次捕获覆盖）', changedAt(20_000, { composing: true }), 23_000, cap(false)],
    ['组字中到了上限、公式也没收齐：标记只看公式', changedAt(20_000, { composing: true, settled: false }), 23_000, cap(true)],
    ['组合刚结束：静默从组合结束算', changedAt(20_000, { lastCompositionEndAt: 21_800 }), 22_000, wait(22_800)],
    ['组合结束满 1 秒：捕获', changedAt(20_000, { lastCompositionEndAt: 21_800 }), 22_800, quiet()],
    ['组合结束早于最后一次修改：静默从修改算', changedAt(20_000, { lastChangeAt: 20_500, lastCompositionEndAt: 20_100 }), 21_400, wait(21_500)],
  ])('%s', (_case, state, now, expected) => {
    expect(decideCapture(state, now)).toEqual(expected)
  })
})

describe('补捕获（计划书 §7.3：超过上限的捕获带标记，公式收齐之后补捕获一次，不另等静默）', () => {
  /** 最近一次捕获（序号 4）带标记，之后没有修改 */
  const FLAGGED: CaptureState = { ...BASE, seq: 4, capturedSeq: 4, lastChangeAt: 20_000, capturePending: true, settled: false }

  it.each<[string, CaptureState, CaptureDecision]>([
    ['公式还在算：没有要捕获的（收齐时由调度立即再看）', FLAGGED, IDLE],
    ['公式收齐了：立即补捕获，不带标记', { ...FLAGGED, settled: true }, formulas],
    ['公式收齐了、正在组字：等组字结束', { ...FLAGGED, settled: true, composing: true }, IDLE],
    ['最近一次不带标记：没有要补的', { ...FLAGGED, settled: true, capturePending: false }, IDLE],
    // 带标记的文档进入编辑：还没捕获过，标记是服务端给的初值；强制全量重算收齐之后补存，清掉服务端的标记（设计 §3.5）
    ['进入编辑时服务端说"公式待更新"、重算收齐了：没捕获过也补捕获', { ...BASE, seq: 0, capturedSeq: 0, lastChangeAt: undefined, lastCapture: undefined, capturePending: true }, formulas],
  ])('%s', (_case, state, expected) => {
    expect(decideCapture(state, 23_500)).toEqual(expected)
  })

  it('补捕获之后又有修改：照静默与上限（不是补捕获）', () => {
    expect(decideCapture({ ...FLAGGED, seq: 5, firstUncapturedAt: 23_000, lastChangeAt: 23_000, settled: true }, 23_500)).toEqual(wait(24_000))
  })
})

describe('大文档拉长间隔（计划书 §7.2：两次捕获的间隔不小于上一次捕获耗时的 10 倍）', () => {
  /** 上一次捕获耗时 300 毫秒，10_000 时结束：13_000 之前不再捕获 */
  const SLOW = { durationMs: 300, endedAt: 10_000 }
  /** 耗时 500 毫秒：15_000 之前不再捕获，比上限（第一处修改之后 3 秒）还晚 */
  const SLOWER = { durationMs: 500, endedAt: 10_000 }

  it.each<[string, CaptureState, number, CaptureDecision]>([
    ['静默满了、还没隔开：推到隔开的那一刻', changedAt(10_200, { lastCapture: SLOW }), 11_200, wait(13_000)],
    ['上限到了、还没隔开：同样推后', changedAt(10_100, { lastCapture: SLOWER, settled: false }), 13_100, wait(15_000)],
    ['推后之后到了那一刻：按上限捕获，公式没收齐照样带标记', changedAt(10_100, { lastCapture: SLOWER, settled: false }), 15_000, cap(true)],
    ['等的时刻早于隔开的那一刻：等到隔开', changedAt(10_200, { lastCapture: SLOW }), 10_500, wait(13_000)],
    ['隔开了：照常捕获', changedAt(10_200, { lastCapture: SLOW }), 13_000, quiet()],
    ['补捕获同样隔开', { ...BASE, lastCapture: SLOW, capturePending: true }, 12_000, wait(13_000)],
    ['平常的文档（5 毫秒）：隔开 50 毫秒，静默早就满了', changedAt(10_010), 11_010, quiet()],
    ['没捕获过：不受限', { ...changedAt(500), lastCapture: undefined }, 1_500, quiet()],
  ])('%s', (_case, state, now, expected) => {
    expect(decideCapture(state, now)).toEqual(expected)
  })
})

describe('可替换的上限（测试构建的控制：M0 把上限调到 50 ms 测"超过上限"）', () => {
  it('上限 50 毫秒：改完 50 毫秒公式还在算就带标记捕获', () => {
    const limits = { ...DEFAULT_CAPTURE_LIMITS, maxMs: 50 }
    expect(decideCapture(changedAt(20_000, { settled: false }), 20_049, limits)).toEqual(wait(20_050))
    expect(decideCapture(changedAt(20_000, { settled: false }), 20_050, limits)).toEqual(cap(true))
  })
})

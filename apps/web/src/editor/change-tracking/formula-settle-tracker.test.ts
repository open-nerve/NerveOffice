import type { CommandRecord } from './command-record.ts'
import type { RecordedStep } from './formula-sequences.test-support.ts'
import type { CalculationTriggerCheck } from './formula-settle-tracker.ts'
import { describe, expect, it, vi } from 'vitest'
import { EDIT_DURING_CALCULATION, EDIT_WITHOUT_FORMULA, SINGLE_EDIT_CROSS_SHEET, UNIT } from './formula-sequences.test-support.ts'
import { createFormulaSettleTracker } from './formula-settle-tracker.ts'

/** 按录制的结果回答"会不会触发"：queues 为 null 的不会触发，否则延后求值时给出录制的脏区判断 */
function recordedTriggers(steps: readonly RecordedStep[]): CalculationTriggerCheck {
  const byRecord = new Map(steps.map(step => [step.record, step.queues]))
  return (record) => {
    const queues = byRecord.get(record)
    return queues === null || queues === undefined ? null : () => queues
  }
}

function replay(steps: readonly RecordedStep[]): boolean[] {
  const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: recordedTriggers(steps) })
  return steps.map((step) => {
    tracker.observe(step.record)
    return tracker.isSettled()
  })
}

const mutation = (id: string, params: object = {}, options?: Record<string, unknown>): CommandRecord => ({ id, kind: 'mutation', params, options })
const START = mutation('formula.mutation.set-formula-calculation-start', {}, { onlyLocal: true })
const STOP = mutation('formula.mutation.set-formula-calculation-stop', {}, { onlyLocal: true })
const edit = (sheet = 'sheet-1'): CommandRecord => mutation('sheet.mutation.set-range-values', { unitId: UNIT, subUnitId: sheet })
const result = (unitData: Record<string, Record<string, unknown> | null>): CommandRecord => mutation('formula.mutation.set-formula-calculation-result', { unitData }, { onlyLocal: true })
const writeBack = (sheet: string, unitId = UNIT, apply = true): CommandRecord => mutation('sheet.mutation.set-range-values', { unitId, subUnitId: sheet }, { onlyLocal: true, fromFormula: true, ...(apply ? { applyFormulaCalculationResult: true } : {}) })
const completed = (state: number): CommandRecord => mutation('formula.mutation.set-formula-calculation-notification', { functionsExecutedState: state })
/** 用户的修改会排队（脏区非空），其余命令不触发 */
const editsQueue: CalculationTriggerCheck = record => (record.id === 'sheet.mutation.set-range-values' && record.options === undefined ? () => true : null)

describe('公式收齐：录制的命令序列（公式 Worker 模式）', () => {
  it.each([
    ['单表与跨表：结果含两张表，逐表写回之后才收齐', SINGLE_EDIT_CROSS_SHEET],
    ['修改没有牵动公式：只有完成通知（NOT_EXECUTED），以它为准', EDIT_WITHOUT_FORMULA],
    ['计算进行中再改一次：第一轮完成时仍在排队，第二轮写回之后才收齐', EDIT_DURING_CALCULATION],
  ])('%s', (_, steps) => {
    expect(replay(steps)).toEqual(steps.map(step => step.settled))
  })
})

describe('公式收齐：三个条件', () => {
  it('还没开始过计算：收齐', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    expect(tracker.isSettled()).toBe(true)
  })

  it('刚修改完、下一轮还没开始（触发服务 10 ms 的防抖之内）：没收齐', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: editsQueue })
    tracker.observe(edit())
    expect(tracker.isSettled()).toBe(false)
    expect(tracker.progress().queued).toBe(true)
  })

  it('脏区为空的修改不排队', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => () => false })
    tracker.observe(edit())
    expect(tracker.isSettled()).toBe(true)
  })

  it('被 stop 的一轮：即使写回了也没收齐，要等下一轮开始并写回', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    tracker.observe(START)
    tracker.observe(STOP)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {} } }))
    tracker.observe(writeBack('sheet-1'))
    tracker.observe(completed(1))
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(START)
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {} } }))
    tracker.observe(writeBack('sheet-1'))
    expect(tracker.isSettled()).toBe(true)
  })

  it('开始新的一轮时，之前排队的命令都并进了这一轮', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: editsQueue })
    tracker.observe(edit())
    tracker.observe(START)
    expect(tracker.progress().queued).toBe(false)
    tracker.observe(completed(2))
    expect(tracker.isSettled()).toBe(true)
  })

  it('还没有结果时以完成通知为准；初始状态（INITIAL = 0）与进度通知都不算完成', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    tracker.observe(START)
    tracker.observe(mutation('formula.mutation.set-formula-calculation-notification', { stageInfo: {} }))
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(completed(0))
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(completed(3))
    expect(tracker.isSettled()).toBe(true)
  })

  it('只等本文档里带结果的表：cellData 为 null 的表与别的单元不等', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    tracker.observe(START)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {}, 'sheet-2': null }, 'other-unit': { 'sheet-9': {} } }))
    expect(tracker.progress().resultSheets).toEqual(['sheet-1'])
    tracker.observe(writeBack('sheet-1'))
    expect(tracker.isSettled()).toBe(true)
  })

  it('结果里没有本文档：视为收齐', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    tracker.observe(START)
    tracker.observe(result({ 'other-unit': { 'sheet-9': {} } }))
    expect(tracker.isSettled()).toBe(true)
  })

  it('不带 applyFormulaCalculationResult 的写入、别的单元的写回都不算写回', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    tracker.observe(START)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {} } }))
    tracker.observe(writeBack('sheet-1', UNIT, false))
    tracker.observe(writeBack('sheet-1', 'other-unit'))
    expect(tracker.isSettled()).toBe(false)
    expect(tracker.progress().appliedSheets).toEqual([])
  })

  it('等写回期间删掉了工作表：删除会触发新的一轮，下一轮的结果里没有它', () => {
    // 删除工作表的脏区转换清掉依赖缓存（sheets-formula 的 active-dirty.controller.ts:260-273），所以它会排队
    const removeSheet = mutation('sheet.mutation.remove-sheet', { unitId: UNIT, subUnitId: 'sheet-2' })
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: record => (record === removeSheet ? () => true : null) })
    tracker.observe(START)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {}, 'sheet-2': {} } }))
    tracker.observe(writeBack('sheet-1'))
    tracker.observe(removeSheet)
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(completed(3))
    tracker.observe(START)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {} } }))
    tracker.observe(writeBack('sheet-1'))
    expect(tracker.isSettled()).toBe(true)
  })
})

describe('公式收齐：触发判断的求值', () => {
  it('脏区是否非空延后到询问时才算，而且只算一次', () => {
    const isDirty = vi.fn(() => false)
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => isDirty })
    tracker.observe(edit())
    expect(isDirty).not.toHaveBeenCalled()
    tracker.isSettled()
    tracker.isSettled()
    tracker.progress()
    expect(isDirty).toHaveBeenCalledTimes(1)
  })

  it('每条命令都交给触发判断，包括开始一轮的那一条之后的命令', () => {
    const triggerCheck = vi.fn<CalculationTriggerCheck>(() => null)
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck })
    const records = [edit(), START, writeBack('sheet-1')]
    records.forEach(record => tracker.observe(record))
    expect(triggerCheck.mock.calls.map(([record]) => record)).toEqual(records)
  })

  it('progress 给出当前一轮的快照', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    tracker.observe(START)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {} } }))
    tracker.observe(writeBack('sheet-1'))
    expect(tracker.progress()).toEqual({ round: 1, started: true, stopped: false, completed: false, resultSheets: ['sheet-1'], appliedSheets: ['sheet-1'], queued: false, awaitingForcedRound: false })
  })
})

/** 强制全量重算的触发命令（initialFormulaComputing 为 FORCED 时 SDK 执行的那一条，参数是脏区） */
const forcedTrigger = (forceCalculation = true): CommandRecord => mutation('formula.mutation.set-trigger-formula-calculation-start', { forceCalculation, dirtyRanges: [] }, { onlyLocal: true })
/** 触发判断：强制重算的触发命令一定排队（calculation-trigger.ts 的口径），用户的修改也排队 */
const triggersQueue: CalculationTriggerCheck = record => (record.id === 'formula.mutation.set-trigger-formula-calculation-start' || editsQueue(record) !== null ? () => true : null)

describe('公式收齐：进入编辑时强制全量重算（M3-P4 设计 §3.5 第 3 条）', () => {
  it('看到强制重算的触发命令之前一律不算收齐（还没开始过计算也不算）：自动保存不会先补存重算之前的旧值', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: triggersQueue, forcedRound: true })
    expect(tracker.isSettled()).toBe(false)
    expect(tracker.progress().awaitingForcedRound).toBe(true)
    // 别的一轮（例如 WHEN_EMPTY 的那种、或者用户改了一处）算完也不算：强制的那一轮还没来
    tracker.observe(edit())
    tracker.observe(START)
    tracker.observe(completed(2))
    expect(tracker.isSettled()).toBe(false)
  })

  it('看到之后它就是排队的一轮：开始、逐表写回之后才收齐', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: triggersQueue, forcedRound: true })
    tracker.observe(forcedTrigger())
    expect(tracker.progress().awaitingForcedRound).toBe(false)
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(START)
    tracker.observe(result({ [UNIT]: { 'sheet-1': {}, 'sheet-2': {} } }))
    tracker.observe(writeBack('sheet-1'))
    expect(tracker.isSettled()).toBe(false)
    tracker.observe(writeBack('sheet-2'))
    expect(tracker.isSettled()).toBe(true)
  })

  it('不带 forceCalculation 的触发命令（WHEN_EMPTY 的初次计算）不算强制的那一轮', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: triggersQueue, forcedRound: true })
    tracker.observe(forcedTrigger(false))
    tracker.observe(START)
    tracker.observe(completed(3))
    expect(tracker.isSettled()).toBe(false)
    expect(tracker.progress().awaitingForcedRound).toBe(true)
  })

  it('不要求强制重算时照旧：还没开始过计算就是收齐', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: triggersQueue })
    expect(tracker.isSettled()).toBe(true)
    expect(tracker.progress().awaitingForcedRound).toBe(false)
  })
})

describe('公式收齐：observe 交回收齐与否可能变了（公式进度的信号，M3-P4）', () => {
  it('一轮的开始、停止、结果、完成通知、本文档的写回，以及会触发计算的命令：交回 true', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: editsQueue })
    expect([edit(), START, STOP, result({ [UNIT]: { 'sheet-1': {} } }), writeBack('sheet-1'), completed(3)].map(record => tracker.observe(record))).toEqual([true, true, true, true, true, true])
  })

  it('计算中的进度通知、初始状态的通知、别的单元与不带写回标记的写入、不触发计算的命令：交回 false', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null })
    expect([
      mutation('formula.mutation.set-formula-calculation-notification', { stageInfo: {} }),
      completed(0),
      writeBack('sheet-1', 'other-unit'),
      writeBack('sheet-1', UNIT, false),
      mutation('sheet.mutation.set-worksheet-name', { unitId: UNIT }),
    ].map(record => tracker.observe(record))).toEqual([false, false, false, false, false])
  })

  it('强制重算的触发命令：交回 true（等它的那一刻结束）', () => {
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: () => null, forcedRound: true })
    expect(tracker.observe(forcedTrigger())).toBe(true)
  })
})

describe('DEF-020：判定不看 trigger（M3-P4 设计 §3.16）', () => {
  /** 被入口守卫取消的命令留在 SDK 的执行栈里，之后命令之外的 mutation 带上它的 trigger（M1-P4 S2 探针 e 实测的那一个） */
  const TRIGGERS = [undefined, 'sheet.operation.insert-hyper-link-toolbar', 'sheet.command.set-range-bold', 'sheet.command.clear-selection-format', 'x']

  function withTrigger(steps: readonly RecordedStep[], trigger: string | undefined): RecordedStep[] {
    return steps.map(step => ({ ...step, record: { ...step.record, params: { ...(step.record.params as object), trigger } } }))
  }

  it.each(TRIGGERS)('录制的序列里每条命令都带 trigger=%s：每一步的收齐与不带时相同', (trigger) => {
    for (const steps of [SINGLE_EDIT_CROSS_SHEET, EDIT_WITHOUT_FORMULA, EDIT_DURING_CALCULATION])
      expect(replay(withTrigger(steps, trigger))).toEqual(steps.map(step => step.settled))
  })

  it('交给触发判断的是同一个 params 对象（含 trigger）：与 SDK 的触发服务读的一样，被串改的 trigger 两边一致', () => {
    const seen: unknown[] = []
    const tracker = createFormulaSettleTracker({ unitId: UNIT, triggerCheck: (record) => {
      seen.push(record.params)
      return null
    } })
    const params = { unitId: UNIT, subUnitId: 'sheet-1', trigger: 'sheet.operation.insert-hyper-link-toolbar' }
    tracker.observe(mutation('sheet.mutation.set-range-values', params))
    expect(seen[0]).toBe(params)
  })
})

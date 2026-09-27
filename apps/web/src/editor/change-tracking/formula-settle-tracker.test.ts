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
    expect(tracker.progress()).toEqual({ round: 1, started: true, stopped: false, completed: false, resultSheets: ['sheet-1'], appliedSheets: ['sheet-1'], queued: false })
  })
})

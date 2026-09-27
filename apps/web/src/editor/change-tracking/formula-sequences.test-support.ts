// 公式计算的命令序列（测试数据）：P4 S2 的探针在公式 Worker 模式下录制（Chromium；Chrome、WebKit 的顺序相同），
// 只留下与公式收齐有关的命令。queues 是 SDK 触发口径下这条命令会不会开始（或排队）新的一轮（null 表示不会触发），
// settled 是生产的跟踪器在这一条之后的判断——录制时它的值与重算一致（单表、跨表、计算进行中再改一次）。
// unitId 与工作表 id 换成了易读的值：unit-1、sheet-1（工作表1）、sheet-2（表二）
import type { CommandRecord } from './command-record.ts'

export const UNIT = 'unit-1'

export interface RecordedStep {
  readonly record: CommandRecord
  readonly queues: boolean | null
  readonly settled: boolean
}

const START = 'formula.mutation.set-formula-calculation-start'
const NOTIFICATION = 'formula.mutation.set-formula-calculation-notification'
const RESULT = 'formula.mutation.set-formula-calculation-result'
const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
const FROM_WORKER = { onlyLocal: true, fromSync: true }

function step(record: Omit<CommandRecord, 'kind'>, queues: boolean | null, settled: boolean): RecordedStep {
  return { record: { kind: 'mutation', ...record }, queues, settled }
}

/** 用户修改一个单元格（参数里只留跟踪器用到的字段） */
const userEdit = (settled = false): RecordedStep => step({ id: SET_RANGE_VALUES, params: { unitId: UNIT, subUnitId: 'sheet-1' }, options: undefined }, true, settled)
const start = (): RecordedStep => step({ id: START, params: {}, options: { onlyLocal: true } }, null, false)
/** 计算中的进度通知：只有 stageInfo，没有完成状态 */
const progress = (): RecordedStep => step({ id: NOTIFICATION, params: { stageInfo: {} }, options: FROM_WORKER }, null, false)
const result = (sheets: string[]): RecordedStep => step({ id: RESULT, params: { unitData: { [UNIT]: Object.fromEntries(sheets.map(sheet => [sheet, { 0: { 0: { v: 1 } } }])) } }, options: FROM_WORKER }, null, false)
const writeBack = (sheet: string, settled: boolean): RecordedStep => step({ id: SET_RANGE_VALUES, params: { unitId: UNIT, subUnitId: sheet }, options: { onlyLocal: true, fromFormula: true, applyFormulaCalculationResult: true, fromSync: true } }, null, settled)
/** 完成通知：SUCCESS = 3、NOT_EXECUTED = 2（FormulaExecutedStateType） */
const completed = (state: number, settled: boolean): RecordedStep => step({ id: NOTIFICATION, params: { functionsExecutedState: state }, options: FROM_WORKER }, null, settled)

/** 改了工作表1!A1：工作表1!B1 = A1*2、表二!A1 = 工作表1!A1+1。结果含两张表，逐表写回之后才收齐 */
export const SINGLE_EDIT_CROSS_SHEET: readonly RecordedStep[] = [
  userEdit(),
  start(),
  progress(),
  progress(),
  progress(),
  progress(),
  progress(),
  result(['sheet-1', 'sheet-2']),
  writeBack('sheet-1', false),
  writeBack('sheet-2', true),
  completed(3, true),
]

/** 改了一个没有被公式引用的单元格：SDK 仍开始一轮，但只发完成通知（NOT_EXECUTED），不发结果 */
export const EDIT_WITHOUT_FORMULA: readonly RecordedStep[] = [
  userEdit(),
  start(),
  progress(),
  progress(),
  progress(),
  progress(),
  completed(2, true),
]

/**
 * 计算进行中又改了一处（600 个 SUMPRODUCT 引用 D1:D1000；先改 D1，40 ms 后改 D2）：
 * 两处的脏区不相交，SDK 不 stop，而是等这一轮完成之后再开始下一轮。第一轮写回、完成之后仍在排队，第二轮写回之后才收齐
 */
export const EDIT_DURING_CALCULATION: readonly RecordedStep[] = [
  userEdit(),
  start(),
  progress(),
  progress(),
  progress(),
  userEdit(),
  progress(),
  progress(),
  progress(),
  result(['sheet-1']),
  writeBack('sheet-1', false),
  completed(3, false),
  start(),
  progress(),
  progress(),
  progress(),
  progress(),
  progress(),
  progress(),
  result(['sheet-1']),
  writeBack('sheet-1', true),
  completed(3, true),
]

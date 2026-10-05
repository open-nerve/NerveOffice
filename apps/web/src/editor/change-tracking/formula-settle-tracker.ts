// 公式收齐（计划书 §7.3，M0-P3 报告 §3.4，P4 设计 §3.6.6）：显式保存前等公式结果写回，三个条件同时满足才算收齐——
// 1. 没有排队的一轮：最近一轮开始之后，没有再执行会触发计算的命令（口径与 SDK 的触发服务相同，见 calculation-trigger.ts）。
//    SDK 不把新的修改并进正在进行的一轮：刚修改完、10 ms 的防抖还没过时，这一条能认出"下一轮还没开始"；
// 2. 这一轮没有被 stop：被 stop 的一轮没算完的部分会并进下一轮重新开始；
// 3. 逐表收齐：最近一条结果里带结果的每张表都收到了带 applyFormulaCalculationResult 的写回；
//    修改没有牵动任何公式时，SDK 仍会开始一轮，但只发完成通知、不发结果，这时以完成通知为准。
// 主线程上的顺序是"结果 → 各表写回 → 完成通知"（engine-formula 的 calculate.controller.ts:232-257，sheets 的
// calculate-result-apply.controller.ts:47-99；Worker 按执行顺序同步回主线程，rpc 的 data-sync-replica.controller.ts:59-70）。
// 删除工作表会触发新的一轮（它的脏区转换清掉依赖缓存，sheets-formula 的 active-dirty.controller.ts:260-273），
// 所以"等一张已删除的表写回"只会停留到下一轮开始，不必在捕获前调用 Facade 查询工作表是否还在。
// 不用 onCalculationResultApplied：Worker 模式下它在第一张表写回后就返回，也不等排队的下一轮（M0-P3 报告 §3.3）
// M3-P4：
// - 进入编辑时强制全量重算（带"公式待更新"的文档，设计 §3.5 第 3 条，forcedRound）：看到强制重算的触发命令之前一律不算收齐。
//   SDK 在工作簿加入与渲染完成时执行它（initialFormulaComputing 为 FORCED，sheets-formula 的 update-formula.controller.ts:265-287、
//   trigger-calculation.controller.ts:291-297，1.0.1 的 lib/es/index.js 同样），都在 createSheetEditor 返回之前；这里不靠这个先后——
//   万一更晚，收齐也不会先为真（否则自动保存的补捕获存下重算之前的旧值、清掉服务端的标记）。看到之后它就是排队的一轮（候选），照三个条件；
// - observe 交回收齐与否可能因这条命令而变（开始、停止、结果、完成通知、本文档的写回，或者会触发计算的命令）：变更检测据此发出
//   公式进度的信号，自动保存随即再看（autosave.ts）。计算中的进度通知（只有 stageInfo）不算；
// - roundRunning：有一轮开始了、还没有结束的通知——主线程模式下销毁编辑器之前先停下它（formula-round-stop.ts，设计 §3.14）
import type { CommandRecord } from './command-record.ts'
import { FORMULA_PROTOCOL } from '../internal-api/index.ts'
import { stringParam } from './command-record.ts'

/**
 * 这条命令会不会让 SDK 开始（或排队）新的一轮：不会时返回 null；会的话返回一个延后求值的判断——
 * 脏区是否非空要调用 SDK 的 getDirtyData，大的 mutation 上并不便宜，只在询问是否收齐时才算
 */
export type CalculationTriggerCheck = (record: CommandRecord) => (() => boolean) | null

export interface FormulaProgress {
  /** 见过的轮数（开始一轮加一） */
  readonly round: number
  readonly started: boolean
  readonly stopped: boolean
  readonly completed: boolean
  /** 最近一条结果里带结果的表；这一轮还没有结果时为 null */
  readonly resultSheets: readonly string[] | null
  readonly appliedSheets: readonly string[]
  /** 最近一轮开始之后，有会触发计算的命令 */
  readonly queued: boolean
  /** 要求了强制全量重算（forcedRound），还没看到它的触发命令 */
  readonly awaitingForcedRound: boolean
}

export interface FormulaSettleTracker {
  /** 记下一条命令；交回收齐与否可能因它而变（见文件头） */
  observe: (record: CommandRecord) => boolean
  isSettled: () => boolean
  progress: () => FormulaProgress
  /**
   * 有一轮正在算：最近一轮开始了、还没有收到它结束的通知（停止、完成或没有执行，completedStates）。被请求停下的一轮在收到停止的
   * 通知之前也算在算（引擎只在让出点检查停止标记）。不看排队：还没开始的一轮随编辑器销毁（触发服务的计时器随之清掉）。
   * 主线程模式下销毁编辑器之前据此决定要不要先停下这一轮（formula-round-stop.ts，M3-P4 设计 §3.14）
   */
  roundRunning: () => boolean
}

export interface FormulaSettleTrackerOptions {
  readonly unitId: string
  readonly triggerCheck: CalculationTriggerCheck
  /** 以强制全量重算创建（带"公式待更新"的文档进入编辑）：看到带 forceCalculation 的触发命令之前一律不算收齐（见文件头） */
  readonly forcedRound?: boolean
}

/** 结果里带结果的本文档的表：与写回控制器的遍历一致，cellData 为 null 的跳过 */
function resultSheetsOf(record: CommandRecord, unitId: string): string[] {
  const params = record.params as { unitData?: Record<string, Record<string, unknown> | null | undefined> } | null | undefined
  const sheets = params?.unitData?.[unitId]
  if (sheets == null)
    return []
  return Object.entries(sheets).filter(([, cellData]) => cellData != null).map(([sheetId]) => sheetId)
}

/** 强制全量重算的触发命令：SetTriggerFormulaCalculationStartMutation，参数（脏区）里 forceCalculation 为真 */
function isForcedTrigger(record: CommandRecord): boolean {
  if (record.id !== FORMULA_PROTOCOL.forceTriggerMutationId)
    return false
  const params = record.params as Record<string, unknown> | null | undefined
  return params?.[FORMULA_PROTOCOL.forceCalculationParam] === true
}

function memoize(evaluate: () => boolean): () => boolean {
  let value: boolean | undefined
  return () => (value ??= evaluate())
}

export function createFormulaSettleTracker(options: FormulaSettleTrackerOptions): FormulaSettleTracker {
  const { unitId, triggerCheck } = options
  let round = 0
  let started = false
  let stopped = false
  let completed = false
  let resultSheets: string[] | null = null
  let appliedSheets = new Set<string>()
  // 最近一轮开始之后执行的、会触发计算的命令；开始新的一轮时清空（之前的命令都并进了这一轮）
  let candidates: (() => boolean)[] = []
  let awaitingForced = options.forcedRound === true

  const queued = (): boolean => candidates.some(isDirty => isDirty())

  /** 一轮的进展；交回收齐与否可能因此而变 */
  function trackProgress(record: CommandRecord): boolean {
    switch (record.id) {
      case FORMULA_PROTOCOL.startMutationId:
        round += 1
        started = true
        stopped = false
        completed = false
        resultSheets = null
        appliedSheets = new Set()
        candidates = []
        return true
      case FORMULA_PROTOCOL.stopMutationId:
        stopped = true
        return true
      case FORMULA_PROTOCOL.resultMutationId:
        resultSheets = resultSheetsOf(record, unitId)
        return true
      case FORMULA_PROTOCOL.notificationMutationId: {
        const state = (record.params as Record<string, unknown> | null | undefined)?.[FORMULA_PROTOCOL.executedStateParam]
        if (typeof state !== 'number' || !FORMULA_PROTOCOL.completedStates.includes(state))
          return false
        completed = true
        return true
      }
      case FORMULA_PROTOCOL.setRangeValuesMutationId: {
        const sheetId = stringParam(record, 'subUnitId')
        if (record.options?.[FORMULA_PROTOCOL.applyResultOption] !== true || stringParam(record, 'unitId') !== unitId || sheetId === undefined)
          return false
        appliedSheets.add(sheetId)
        return true
      }
      default:
        return false
    }
  }

  return {
    observe(record) {
      let progressed = trackProgress(record)
      if (awaitingForced && isForcedTrigger(record)) {
        awaitingForced = false
        progressed = true
      }
      const candidate = triggerCheck(record)
      if (candidate !== null)
        candidates.push(memoize(candidate))
      return progressed || candidate !== null
    },
    isSettled() {
      if (awaitingForced || queued())
        return false
      if (!started)
        return true
      if (stopped)
        return false
      if (resultSheets === null)
        return completed
      return resultSheets.every(sheetId => appliedSheets.has(sheetId))
    },
    roundRunning: () => started && !completed,
    progress: () => ({
      round,
      started,
      stopped,
      completed,
      resultSheets: resultSheets === null ? null : [...resultSheets],
      appliedSheets: [...appliedSheets],
      queued: queued(),
      awaitingForcedRound: awaitingForced,
    }),
  }
}

// 公式计算的进度在命令流里的约定（M0-P3 报告 §3.4、§7；P4 设计 §3.6.6）。
// mutation 的 id 与完成状态取自 SDK 导出的定义，不手抄；执行选项与参数的键在 SDK 里只是字面量
// （sheets 的 calculate-result-apply.controller.ts:90-97，engine-formula 的 ISetFormulaCalculationNotificationMutation），在这里集中写一次
import { FormulaExecutedStateType, SetFormulaCalculationNotificationMutation, SetFormulaCalculationResultMutation, SetFormulaCalculationStartMutation, SetFormulaCalculationStopMutation, SetTriggerFormulaCalculationStartMutation } from '@univerjs/engine-formula'
import { SetRangeValuesMutation } from '@univerjs/sheets'

export const FORMULA_PROTOCOL = Object.freeze({
  /** 一轮计算开始（触发服务在命令进入队列、10 ms 防抖之后执行） */
  startMutationId: SetFormulaCalculationStartMutation.id,
  /** 请求停止正在进行的一轮：被 stop 的一轮没算完的部分并进下一轮 */
  stopMutationId: SetFormulaCalculationStopMutation.id,
  /** 计算结果：params.unitData[unitId][sheetId] 为 null 的表没有结果 */
  resultMutationId: SetFormulaCalculationResultMutation.id,
  /** 进度与完成通知 */
  notificationMutationId: SetFormulaCalculationNotificationMutation.id,
  /** 强制重算的触发命令：执行它就一定会开始新的一轮 */
  forceTriggerMutationId: SetTriggerFormulaCalculationStartMutation.id,
  /** 结果写回：每张表一条，执行选项带 applyFormulaCalculationResult */
  setRangeValuesMutationId: SetRangeValuesMutation.id,
  applyResultOption: 'applyFormulaCalculationResult',
  /** 通知里的完成状态；与触发服务同一口径，只有这几种算这一轮结束（formula-calculation-trigger.service.ts:166-176） */
  executedStateParam: 'functionsExecutedState',
  completedStates: Object.freeze([FormulaExecutedStateType.STOP_EXECUTION, FormulaExecutedStateType.SUCCESS, FormulaExecutedStateType.NOT_EXECUTED]),
})

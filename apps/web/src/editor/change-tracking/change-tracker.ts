// 变更检测与公式收齐的订阅（P4 设计 §3.6.5、§3.6.6）：监听 Facade 的 CommandExecuted（公开 API），
// 检测到本文档的修改时本地修改序号加一，同时把每条命令交给公式收齐的跟踪器。
// 必须在创建工作簿之前挂上，才能看到加载过程中执行的命令（M0 的 create-editor.ts:135-139）。
// 这里的回调在 SDK 的命令执行过程中同步调用，抛出的异常会打断命令，所以一律接住、交给浏览器的错误报告。
// M3-P4（设计 §3.2、§3.10）：公式的进度（收齐与否可能变了）另有信号（onFormulaProgress），自动保存据此再看；同样在命令执行中同步发出，
// 监听者只能记下、排到之后再做（autosave.ts 不在信号里捕获）。强制全量重算（forcedRound）交给收齐的跟踪器
import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { ChangeClassifierConfig } from './change-classifier.ts'
import type { FormulaProgress } from './formula-settle-tracker.ts'
import { createCalculationTriggerCheck } from './calculation-trigger.ts'
import { isDocumentChange } from './change-classifier.ts'
import { toCommandRecord } from './command-event.ts'
import { createFormulaSettleTracker } from './formula-settle-tracker.ts'

export interface ChangeTracker {
  /** 本地修改序号：检测到本文档的修改时加一，单调递增 */
  readonly changeSeq: () => number
  readonly onChange: (listener: () => void) => () => void
  /** 公式是否收齐（formula-settle-tracker.ts 的三个条件） */
  readonly formulasSettled: () => boolean
  /**
   * 公式计算的进度（轮数、这一轮开始、被停、完成、带结果与已写回的表、有没有排队）：测试构建的探针读它（M3-P4 设计 §3.15）；
   * 自动保存读的是收齐与否（formulasSettled）与进度变了的信号（onFormulaProgress，设计 §3.10）
   */
  readonly formulaProgress: () => FormulaProgress
  /** 公式的进度变了（开始一轮、停止、结果、写回、完成，或者会触发计算的命令）：收齐与否可能变了 */
  readonly onFormulaProgress: (listener: () => void) => () => void
  readonly dispose: () => void
}

export interface ChangeTrackerOptions {
  /** 以强制全量重算创建（带"公式待更新"的文档进入编辑，M3-P4 设计 §3.5）：看到它的触发命令之前不算收齐（formula-settle-tracker.ts） */
  readonly forcedRound?: boolean
}

function notifyAll(listeners: ReadonlySet<() => void>): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    }
    catch (error) {
      reportError(error)
    }
  }
}

export function createChangeTracker(univer: Univer, univerAPI: FUniver, config: ChangeClassifierConfig, options: ChangeTrackerOptions = {}): ChangeTracker {
  const formulas = createFormulaSettleTracker({ unitId: config.unitId, triggerCheck: createCalculationTriggerCheck(univer), forcedRound: options.forcedRound })
  const listeners = new Set<() => void>()
  const progressListeners = new Set<() => void>()
  let seq = 0

  const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
    let changed = false
    let progressed = false
    try {
      const record = toCommandRecord(event)
      progressed = formulas.observe(record)
      changed = isDocumentChange(record, config)
      if (changed)
        seq += 1
    }
    catch (error) {
      reportError(error)
      return
    }
    if (changed)
      notifyAll(listeners)
    if (progressed)
      notifyAll(progressListeners)
  })

  return {
    changeSeq: () => seq,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    formulasSettled: () => formulas.isSettled(),
    formulaProgress: () => formulas.progress(),
    onFormulaProgress(listener) {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      progressListeners.clear()
      subscription.dispose()
    },
  }
}

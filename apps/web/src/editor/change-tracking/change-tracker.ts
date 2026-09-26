// 变更检测与公式收齐的订阅（P4 设计 §3.6.5、§3.6.6）：监听 Facade 的 CommandExecuted（公开 API），
// 检测到本文档的修改时本地修改序号加一，同时把每条命令交给公式收齐的跟踪器。
// 必须在创建工作簿之前挂上，才能看到加载过程中执行的命令（M0 的 create-editor.ts:135-139）。
// 这里的回调在 SDK 的命令执行过程中同步调用，抛出的异常会打断命令，所以一律接住、交给浏览器的错误报告
import type { Univer } from '@univerjs/core'
import type { FUniver, IEventParamConfig } from '@univerjs/core/facade'
import type { ChangeClassifierConfig } from './change-classifier.ts'
import type { CommandKind, CommandRecord } from './command-record.ts'
import { CommandType } from '@univerjs/core'
import { createCalculationTriggerCheck } from './calculation-trigger.ts'
import { isDocumentChange } from './change-classifier.ts'
import { createFormulaSettleTracker } from './formula-settle-tracker.ts'

type CommandEvent = IEventParamConfig['CommandExecuted']

const COMMAND_KIND: Readonly<Record<number, CommandKind>> = {
  [CommandType.COMMAND]: 'command',
  [CommandType.OPERATION]: 'operation',
  [CommandType.MUTATION]: 'mutation',
}

function toCommandRecord(event: CommandEvent): CommandRecord {
  return { id: event.id, kind: COMMAND_KIND[event.type] ?? 'command', params: event.params, options: event.options }
}

export interface ChangeTracker {
  /** 本地修改序号：检测到本文档的修改时加一，单调递增 */
  readonly changeSeq: () => number
  readonly onChange: (listener: () => void) => () => void
  /** 公式是否收齐（formula-settle-tracker.ts 的三个条件） */
  readonly formulasSettled: () => boolean
  readonly dispose: () => void
}

function notify(listener: () => void): void {
  try {
    listener()
  }
  catch (error) {
    reportError(error)
  }
}

export function createChangeTracker(univer: Univer, univerAPI: FUniver, config: ChangeClassifierConfig): ChangeTracker {
  const formulas = createFormulaSettleTracker({ unitId: config.unitId, triggerCheck: createCalculationTriggerCheck(univer) })
  const listeners = new Set<() => void>()
  let seq = 0

  const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
    try {
      const record = toCommandRecord(event)
      formulas.observe(record)
      if (!isDocumentChange(record, config))
        return
      seq += 1
    }
    catch (error) {
      reportError(error)
      return
    }
    for (const listener of [...listeners])
      notify(listener)
  })

  return {
    changeSeq: () => seq,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    formulasSettled: () => formulas.isSettled(),
    dispose() {
      listeners.clear()
      subscription.dispose()
    },
  }
}

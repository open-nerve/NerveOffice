// Facade 的命令事件转成命令流里的一条记录（command-record.ts）：CommandExecuted 与 BeforeCommandExecute 送出同一种事件
// { id, type, params, options }（core 的 f-univer.ts:202-213、255-268），类型换成字面量。
// 变更检测、公式收齐与只读的防火墙都经这里转换，之后的判断（change-classifier.ts）是同一份纯逻辑
import type { IEventParamConfig } from '@univerjs/core/facade'
import type { CommandKind, CommandRecord } from './command-record.ts'
import { CommandType } from '@univerjs/core'

export type CommandEvent = IEventParamConfig['CommandExecuted' | 'BeforeCommandExecute']

const COMMAND_KIND: Readonly<Record<number, CommandKind>> = {
  [CommandType.COMMAND]: 'command',
  [CommandType.OPERATION]: 'operation',
  [CommandType.MUTATION]: 'mutation',
}

export function toCommandRecord(event: CommandEvent): CommandRecord {
  return { id: event.id, kind: COMMAND_KIND[event.type] ?? 'command', params: event.params, options: event.options }
}

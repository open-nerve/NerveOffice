// 命令流里的一条记录：Facade 的 CommandExecuted 送出的 { id, type, params, options }（core 的 f-univer.ts:202-213），
// 类型换成字面量，变更检测与公式收齐的判断因此是纯逻辑，不依赖 SDK
export type CommandKind = 'command' | 'operation' | 'mutation'

export interface CommandRecord {
  readonly id: string
  readonly kind: CommandKind
  readonly params: unknown
  /** 执行选项（onlyLocal、fromFormula 等），没有时为 undefined */
  readonly options: Readonly<Record<string, unknown>> | undefined
}

/** 参数里的某个字符串字段（unitId、subUnitId）；没有或不是字符串时为 undefined */
export function stringParam(record: CommandRecord, key: string): string | undefined {
  if (typeof record.params !== 'object' || record.params === null)
    return undefined
  const value: unknown = (record.params as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

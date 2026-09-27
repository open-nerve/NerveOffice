// "这条命令会不会触发新的一轮计算"：与 SDK 触发服务同一口径（engine-formula 的 formula-calculation-trigger.service.ts:85-130）。
// 命令在 IActiveDirtyManagerService 里登记了脏区转换、shouldTrigger 没有排除它，并且脏区非空或者它是强制重算的触发命令，
// SDK 就会开始（或排队）新的一轮。这些都是内部约定，经 internal-api 引用并登记
import type { IExecutionOptions, Univer } from '@univerjs/core'
import type { CommandKind } from './command-record.ts'
import type { CalculationTriggerCheck } from './formula-settle-tracker.ts'
import { CommandType } from '@univerjs/core'
import { FORMULA_PROTOCOL, IActiveDirtyManagerService, injectorOf } from '../internal-api/index.ts'

// SDK 的 Nullable 含 void，NonNullable 去不掉它；IDirtyConversionManagerParams 没有从包里导出，从服务的类型推出
type DirtyConversion = Exclude<ReturnType<IActiveDirtyManagerService['get']>, null | undefined | void>
type DirtyData = ReturnType<DirtyConversion['getDirtyData']>

const COMMAND_TYPE: Record<CommandKind, CommandType> = {
  command: CommandType.COMMAND,
  operation: CommandType.OPERATION,
  mutation: CommandType.MUTATION,
}

function hasNestedValue(value: unknown): boolean {
  if (value == null)
    return false
  if (typeof value !== 'object')
    return true
  return Object.values(value).some(hasNestedValue)
}

/** 与触发服务的 hasDirtyData 同一口径（formula-calculation-trigger.service.ts:265-274） */
export function hasDirtyData(dirty: DirtyData): boolean {
  return dirty.forceCalculation === true
    || (dirty.dirtyRanges?.length ?? 0) > 0
    || [dirty.dirtyNameMap, dirty.dirtyDefinedNameMap, dirty.dirtySuperTableMap, dirty.dirtyUnitFeatureMap, dirty.dirtyUnitOtherFormulaMap, dirty.clearDependencyTreeCache].some(hasNestedValue)
}

export function createCalculationTriggerCheck(univer: Univer): CalculationTriggerCheck {
  // 公式引擎的服务在插件启动时才注册：还没有时这条命令也不会被触发服务看到，下次再取
  let manager: IActiveDirtyManagerService | undefined
  const activeDirtyManager = (): IActiveDirtyManagerService | undefined => {
    if (manager === undefined) {
      const injector = injectorOf(univer)
      if (injector.has(IActiveDirtyManagerService))
        manager = injector.get(IActiveDirtyManagerService)
    }
    return manager
  }

  return (record) => {
    const conversion = activeDirtyManager()?.get(record.id)
    if (conversion == null)
      return null
    const command = { id: record.id, type: COMMAND_TYPE[record.kind], params: record.params as object | undefined }
    // 记录里的执行选项原本就是 SDK 送出的 IExecutionOptions（change-tracker.ts 的 toCommandRecord）
    if (conversion.shouldTrigger?.(command, record.options as IExecutionOptions | undefined) === false)
      return null
    return () => record.id === FORMULA_PROTOCOL.forceTriggerMutationId || hasDirtyData(conversion.getDirtyData(command))
  }
}

import type { FormulaMode, FormulaWorkerFailure } from '../../editor/index.ts'
import type { CreateModeEditor } from './editor-slot.ts'
import { FormulaWorkerError } from '../../editor/index.ts'

export interface FormulaFallback {
  readonly createEditor: CreateModeEditor
  readonly mode: () => FormulaMode | undefined
  readonly failure: () => FormulaWorkerFailure | undefined
  readonly failed: (failure: FormulaWorkerFailure) => void
}

export function createFormulaFallback(options: { readonly createEditor: CreateModeEditor, readonly onChange: () => void }): FormulaFallback {
  let failure: FormulaWorkerFailure | undefined
  function failed(reason: FormulaWorkerFailure): void {
    if (failure !== undefined)
      return
    failure = reason
    options.onChange()
  }
  return {
    createEditor: async (input) => {
      const selected = failure === undefined ? input : { ...input, formulaMode: 'main-thread' as const, recalculate: true }
      try {
        return await options.createEditor(selected)
      }
      catch (error) {
        if (!(error instanceof FormulaWorkerError) || selected.formulaMode === 'main-thread')
          throw error
        // 适配层先完成失败清理再拒绝；这里不持有实例、不绕过槽位的销毁顺序。
        failed(error.failure)
        return options.createEditor({ ...input, formulaMode: 'main-thread', recalculate: true })
      }
    },
    mode: () => failure === undefined ? undefined : 'main-thread',
    failure: () => failure,
    failed,
  }
}

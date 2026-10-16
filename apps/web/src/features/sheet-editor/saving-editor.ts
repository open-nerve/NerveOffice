import type { AutosaveEditor } from './autosave.ts'
import type { SaveEditor } from './save-coordinator.ts'

export type SavingEditorSource = AutosaveEditor & SaveEditor

export interface FrozenSavingEditor {
  readonly snapshot: string
  readonly editorSeq: number
}

export interface SavingEditorBinding {
  readonly editor: SavingEditorSource
  readonly freeze: () => FrozenSavingEditor
  readonly bind: (source: SavingEditorSource) => void
  readonly dispose: () => void
}

export class SavingEditorInputError extends Error {
  constructor() {
    super('仍有未完成的输入，不能冻结保存入口')
    this.name = 'SavingEditorInputError'
  }
}

const SIGNALS = ['onChange', 'onUncommittedInputChange', 'onFormulaProgress', 'onCompositionChange'] as const
type Signal = typeof SIGNALS[number]

/** 只拥有保存层的订阅；具体编辑器仍由 editor-slot 创建和销毁。 */
export function createSavingEditor(initial: SavingEditorSource, reportError: (error: unknown) => void): SavingEditorBinding {
  let source: SavingEditorSource | undefined
  let frozen: FrozenSavingEditor | undefined
  let offset = 0
  let generation = 0
  let disposed = false
  const subscriptions: (() => void)[] = []
  const listeners: Record<Signal, Set<() => void>> = {
    onChange: new Set(),
    onUncommittedInputChange: new Set(),
    onFormulaProgress: new Set(),
    onCompositionChange: new Set(),
  }
  function emit(signal: Signal): void {
    for (const listener of [...listeners[signal]]) {
      if (!listeners[signal].has(listener))
        continue
      try {
        listener()
      }
      catch (error) {
        reportError(error)
      }
    }
  }
  function listen(signal: Signal): (listener: () => void) => () => void {
    return (listener) => {
      if (!disposed)
        listeners[signal].add(listener)
      return () => {
        listeners[signal].delete(listener)
      }
    }
  }
  function detach(): void {
    generation += 1
    source = undefined
    for (const stop of subscriptions.splice(0))
      stop()
  }
  function attach(next: SavingEditorSource): void {
    source = next
    const mine = ++generation
    for (const signal of SIGNALS) {
      subscriptions.push(next[signal](() => {
        if (!disposed && generation === mine)
          emit(signal)
      }))
    }
  }
  const editor: SavingEditorSource = {
    changeSeq: () => source ? source.changeSeq() + offset : frozen?.editorSeq ?? 0,
    capture: () => {
      if (source)
        return source.capture()
      if (frozen)
        return frozen.snapshot
      throw new Error('保存入口已释放')
    },
    uncommittedInput: () => source?.uncommittedInput() ?? 'none',
    isCellEditing: () => source?.isCellEditing() ?? false,
    composing: () => source?.composing() ?? false,
    // 调用时定源，不在 await 之后重新提交后来开始的输入。
    commitCellEditing: async () => source?.commitCellEditing() ?? Promise.resolve(true),
    settlePanels: async () => source?.settlePanels() ?? Promise.resolve(),
    formulasSettled: () => source?.formulasSettled() ?? false,
    settleFormulas: async (timeoutMs) => {
      const mine = generation
      const result = await source?.settleFormulas(timeoutMs)
      if (generation !== mine)
        return editor.formulasSettled() ? 'settled' : 'timeout'
      return result === 'settled' && editor.formulasSettled() ? 'settled' : 'timeout'
    },
    onChange: listen('onChange'),
    onUncommittedInputChange: listen('onUncommittedInputChange'),
    onFormulaProgress: listen('onFormulaProgress'),
    onCompositionChange: listen('onCompositionChange'),
  }
  attach(initial)
  return {
    editor,
    freeze: () => {
      if (disposed)
        throw new Error('保存入口已释放')
      if (frozen)
        return frozen
      if (editor.composing() || editor.isCellEditing() || editor.uncommittedInput() !== 'none')
        throw new SavingEditorInputError()
      const editorSeq = editor.changeSeq()
      const snapshot = editor.capture()
      frozen = { snapshot, editorSeq }
      detach()
      emit('onFormulaProgress')
      return frozen
    },
    bind: (next) => {
      if (disposed || !frozen)
        throw new Error('只有尚未释放的冻结入口可以替换编辑器')
      offset = frozen.editorSeq - next.changeSeq()
      frozen = undefined
      attach(next)
      // 接上时序号相同，不制造模型修改；其他状态需要消费者重新读取。
      emit('onUncommittedInputChange')
      emit('onCompositionChange')
      emit('onFormulaProgress')
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      detach()
      frozen = undefined
      for (const signal of SIGNALS)
        listeners[signal].clear()
    },
  }
}

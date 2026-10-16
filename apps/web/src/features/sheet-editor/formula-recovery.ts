import type { EditorAccess, FormulaWorkerFailure, SheetEditor } from '../../editor/index.ts'
import type { LeaseClock } from '../../shared/outbox/clock.ts'
import type { EditingSession } from './editing-session.ts'
import type { EditorSlot } from './editor-slot.ts'
import type { FormulaFallback } from './formula-fallback.ts'

export type FormulaRecoveryPhase = 'waiting-input' | 'preparing' | 'rebuilding' | 'paused' | 'failed' | 'ready'
export type FormulaRecoveryProblem = 'input' | 'capture' | 'create' | 'open-check'

export interface FormulaRecoveryView {
  readonly failure: FormulaWorkerFailure
  readonly phase: FormulaRecoveryPhase
  readonly blocksInput: boolean
  readonly blocksActions: boolean
  readonly problem: FormulaRecoveryProblem | undefined
}

export interface FormulaRecoveryContext {
  readonly generation: number
  readonly access: EditorAccess | undefined
  readonly active: boolean
  readonly allowed: boolean
  readonly revision: number
}

export interface FormulaRecoveryOptions {
  readonly fallback: FormulaFallback
  readonly slot: EditorSlot
  readonly editing: EditingSession
  readonly clock: LeaseClock
  readonly context: () => FormulaRecoveryContext
  readonly check: (created: SheetEditor, access: EditorAccess, revision: number) => boolean
  readonly onChange: () => void
  readonly reportError: (error: unknown) => void
}

export interface FormulaRecovery {
  readonly view: () => FormulaRecoveryView | undefined
  readonly sync: () => void
  readonly retry: () => void
  readonly cancel: () => void
  readonly dispose: () => void
}

interface RecoveryTarget {
  readonly generation: number
  readonly access: EditorAccess
  readonly revision: number
  readonly editor: SheetEditor
  readonly lease: EditingSession['lease']
  readonly coordinator: EditingSession['coordinator']
  readonly scheduler: EditingSession['autosave']
}

interface RecoveryOperation {
  readonly target: RecoveryTarget
  cancelled: boolean
  running: boolean
}

export function createFormulaRecovery(options: FormulaRecoveryOptions): FormulaRecovery {
  const { slot, editing, fallback } = options
  let disposed = false
  let syncing = false
  let view: FormulaRecoveryView | undefined
  let watched: SheetEditor | undefined
  let unwatch: (() => void) | undefined
  let stopComposition: (() => void) | undefined
  let stopTimer: (() => void) | undefined
  let operation: RecoveryOperation | undefined
  let retained: { readonly target: RecoveryTarget, readonly snapshot: string } | undefined
  let failedTarget: RecoveryTarget | undefined

  function show(phase: FormulaRecoveryPhase, blocksInput: boolean, problem?: FormulaRecoveryProblem): void {
    const failure = fallback.failure()
    if (disposed || failure === undefined)
      return
    if (view?.phase === phase && view.blocksInput === blocksInput && view.problem === problem)
      return
    view = { failure, phase, blocksInput, blocksActions: phase !== 'ready', problem }
    options.onChange()
  }

  /** 暂停本人会话只作废续行；同一保存来源的冻结正文仍可供下一轮使用。 */
  function belongs(target: RecoveryTarget): boolean {
    const context = options.context()
    return context.generation === target.generation && context.access === target.access
      && (target.access === 'read' || (target.lease !== undefined && editing.lease === target.lease
        && target.coordinator !== undefined && editing.coordinator === target.coordinator
        && target.scheduler !== undefined && editing.autosave === target.scheduler && editing.holdsLock()))
  }

  function eligible(target: RecoveryTarget): boolean {
    const context = options.context()
    return !disposed && context.active && context.allowed && belongs(target)
  }

  function current(mine: RecoveryOperation): boolean {
    return operation === mine && !mine.cancelled && eligible(mine.target)
  }

  function stopWaiting(): void {
    stopTimer?.()
    stopTimer = undefined
    stopComposition?.()
    stopComposition = undefined
  }

  function cancel(): void {
    stopWaiting()
    if (operation !== undefined) {
      operation.cancelled = true
      // 已进入异步创建的任务要等自己丢弃迟到结果，之后才允许下一轮开始。
      if (!operation.running)
        operation = undefined
    }
    show('paused', retained !== undefined)
  }

  function fail(mine: RecoveryOperation, problem: FormulaRecoveryProblem, error?: unknown): void {
    if (!current(mine))
      return
    failedTarget = mine.target
    show('failed', retained !== undefined, problem)
    if (error !== undefined)
      options.reportError(error)
    if (retained === undefined && current(mine))
      mine.target.scheduler?.resume()
  }

  async function run(mine: RecoveryOperation): Promise<void> {
    stopTimer = undefined
    mine.running = true
    const target = mine.target
    try {
      if (!current(mine))
        return
      if (retained === undefined) {
        // 结束事件到排队任务之间可能开始下一轮组字；finally 的 sync 会重新订阅并等待。
        if (target.editor.composing())
          return
        show('preparing', true)
        if (target.access === 'edit') {
          const scheduler = target.scheduler
          if (scheduler === undefined)
            return
          try {
            await scheduler.settleInputPreparations()
            if (!current(mine))
              return
            // 保持 settleInputs 的提交→面板顺序；这里每个 await 都可能被页面失权作废，
            // 不能把两个等待合成一个不可取消的续行。
            const committed = target.editor.isCellEditing() ? await target.editor.commitCellEditing() : true
            if (!current(mine))
              return
            await target.editor.settlePanels()
            if (!current(mine))
              return
            if (!committed) {
              fail(mine, 'input')
              return
            }
          }
          catch (error) {
            fail(mine, 'input', error)
            return
          }
        }
        try {
          if (target.access === 'edit' && editing.freezeEditor() === undefined) {
            fail(mine, 'capture')
            return
          }
          const source = target.access === 'edit' ? editing.captureEditor() : target.editor
          if (source === undefined) {
            fail(mine, 'capture')
            return
          }
          retained = { target, snapshot: source.capture() }
        }
        catch (error) {
          fail(mine, 'capture', error)
          return
        }
      }
      if (!current(mine))
        return
      show('rebuilding', true)
      const created = await slot.replace(target.access, retained.snapshot, { formulaMode: 'main-thread', recalculate: true })
      if (!current(mine)) {
        if (created !== undefined)
          slot.discard(created)
        return
      }
      if (created === undefined) {
        // 槽位已经报告创建错误；不重复上报，也不从已销毁的旧模型再取正文。
        fail(mine, 'create')
        return
      }
      let checked: boolean
      try {
        checked = options.check(created, target.access, target.revision)
      }
      catch (error) {
        slot.discard(created)
        fail(mine, 'open-check', error)
        return
      }
      if (!current(mine) || !checked) {
        slot.discard(created)
        if (!checked)
          fail(mine, 'open-check')
        return
      }
      if (target.access === 'edit' && !editing.replaceEditor(created)) {
        slot.discard(created)
        cancel()
        return
      }
      // 自检、资格、绑定和接纳在同一同步段完成，不在其间交还事件循环。
      slot.attach(created)
      retained = undefined
      failedTarget = undefined
      show('ready', false)
      if (current(mine))
        target.scheduler?.resume()
    }
    finally {
      if (operation === mine)
        operation = undefined
      sync()
    }
  }

  function schedule(mine: RecoveryOperation): void {
    if (stopTimer !== undefined || !current(mine))
      return
    stopTimer = options.clock.schedule(() => {
      void run(mine)
    }, 0)
  }

  function start(target: RecoveryTarget): void {
    const mine: RecoveryOperation = { target, cancelled: false, running: false }
    operation = mine
    target.scheduler?.suspend()
    if (retained === undefined && target.editor.composing()) {
      show('waiting-input', false)
      stopComposition = target.editor.onCompositionChange(() => {
        if (!current(mine) || target.editor.composing())
          return
        stopComposition?.()
        stopComposition = undefined
        schedule(mine)
      })
      return
    }
    show('preparing', true)
    schedule(mine)
  }

  function watch(): void {
    const editor = slot.editor()
    if (watched === editor)
      return
    unwatch?.()
    watched = editor
    unwatch = editor?.onWorkerFailure((failure) => {
      if (disposed || watched !== editor)
        return
      fallback.failed(failure)
      sync()
    })
  }

  function sync(): void {
    if (disposed || syncing)
      return
    syncing = true
    try {
      watch()
      // 先订阅再读，覆盖创建完成、接线之前发生的首错。
      const failure = watched?.workerFailure()
      if (failure !== undefined)
        fallback.failed(failure)
      if (operation !== undefined) {
        if (!current(operation))
          cancel()
        if (operation !== undefined)
          return
      }
      if (retained !== undefined && !belongs(retained.target))
        retained = undefined
      if (failedTarget !== undefined && !belongs(failedTarget))
        failedTarget = undefined
      if (watched?.formulaMode === 'main-thread') {
        retained = undefined
        failedTarget = undefined
        show('ready', false)
        return
      }
      if (failedTarget !== undefined)
        return
      const context = options.context()
      const target = retained?.target ?? (watched !== undefined && failure !== undefined && context.access !== undefined
        ? {
            generation: context.generation,
            access: context.access,
            revision: context.revision,
            editor: watched,
            lease: context.access === 'edit' ? editing.lease : undefined,
            coordinator: context.access === 'edit' ? editing.coordinator : undefined,
            scheduler: context.access === 'edit' ? editing.autosave : undefined,
          }
        : undefined)
      if (target === undefined || !eligible(target)) {
        show('paused', retained !== undefined)
        return
      }
      start(target)
    }
    finally {
      syncing = false
    }
  }

  return {
    view: () => view,
    sync,
    retry: () => {
      if (disposed || operation !== undefined)
        return
      failedTarget = undefined
      sync()
    },
    cancel,
    dispose: () => {
      disposed = true
      cancel()
      unwatch?.()
      unwatch = undefined
      watched = undefined
      retained = undefined
    },
  }
}

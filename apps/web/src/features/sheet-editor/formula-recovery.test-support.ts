import type { EditorAccess, FormulaMode, FormulaWorkerFailure, SheetEditor } from '../../editor/index.ts'
import type { CreateModeEditor } from './editor-slot.ts'
import type { FormulaRecovery, FormulaRecoveryContext } from './formula-recovery.ts'
import { vi } from 'vitest'
import { deferred, INITIAL, leaseFixture, prepare, fixture as sessionFixture } from './editing-session.test-support.ts'
import { createEditorSlot } from './editor-slot.ts'
import { createFormulaFallback } from './formula-fallback.ts'
import { createFormulaRecovery } from './formula-recovery.ts'

function signal<T extends unknown[] = []>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    listen: vi.fn((listener: (...args: T) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit: (...args: T) => [...listeners].forEach(listener => listener(...args)),
    size: () => listeners.size,
  }
}

export function formulaEditor(snapshot: string, mode: FormulaMode) {
  let content = snapshot
  let seq = 0
  let failure: FormulaWorkerFailure | undefined
  let composing = false
  let editing = false
  let disposed = false
  let settled = mode === 'worker'
  const changes = signal()
  const inputs = signal()
  const composition = signal()
  const formulas = signal()
  const failures = signal<[FormulaWorkerFailure]>()
  const control = { failCapture: false, commitResult: true, checkOk: true }
  const editor: SheetEditor = {
    unitId: 'unit-1',
    formulaMode: mode,
    workerFailure: () => failure,
    onWorkerFailure: failures.listen,
    changeSeq: () => {
      if (disposed)
        throw new Error('旧实例序号已销毁')
      return seq
    },
    onChange: changes.listen,
    lifecycle: () => 'rendered',
    onLifecycle: () => () => {},
    isCellEditing: () => editing,
    uncommittedInput: () => editing ? 'pending' : 'none',
    onUncommittedInputChange: inputs.listen,
    commitCellEditing: vi.fn(async () => {
      if (!control.commitResult)
        return false
      if (editing) {
        editing = false
        content = '{"v":"已提交的输入"}'
        seq += 1
        changes.emit()
        inputs.emit()
      }
      return true
    }),
    settleFormulas: vi.fn(async () => settled && failure === undefined ? 'settled' : 'timeout'),
    formulasSettled: () => settled && failure === undefined,
    onFormulaProgress: formulas.listen,
    composing: () => composing,
    onCompositionChange: composition.listen,
    settlePanels: vi.fn(async () => {}),
    capture: vi.fn(() => {
      if (disposed || control.failCapture)
        throw new Error(disposed ? '旧模型已销毁' : '模型捕获失败')
      return content
    }),
    viewState: () => ({ sheetId: 'sheet-1', topLeft: { row: 7, column: 3 }, selection: undefined }),
    get openCheck(): SheetEditor['openCheck'] {
      return control.checkOk ? { ok: true as const } : { ok: false as const, failures: [{ kind: 'resource-missing' as const, resource: 'SHEET_TEST_PLUGIN' }] }
    },
    dispose: vi.fn(async () => { disposed = true }),
  }
  return {
    editor,
    control,
    disposed: () => disposed,
    fail: (reason: FormulaWorkerFailure = 'error-after-ready') => {
      failure ??= reason
      formulas.emit()
      failures.emit(failure)
    },
    compose: (next: boolean) => {
      composing = next
      composition.emit()
    },
    beginInput: () => {
      editing = true
      inputs.emit()
    },
    edit: (snapshot: string) => {
      content = snapshot
      seq += 1
      changes.emit()
    },
    finishFormula: (snapshot: string) => {
      content = snapshot
      settled = true
      formulas.emit()
    },
    failureListeners: failures.size,
    compositionListeners: composition.size,
  }
}

export async function recoveryFixture(access: EditorAccess, failedBeforeAttach = false) {
  const base = sessionFixture()
  const held = leaseFixture()
  let state: FormulaRecoveryContext = { generation: 1, access, active: true, allowed: true, revision: 3 }
  let recovering: FormulaRecovery | undefined
  let nextGate: ReturnType<typeof deferred<void>> | undefined
  let nextFailure: Error | undefined
  let nextCheck = true
  const created: ReturnType<typeof formulaEditor>[] = []
  const createEditor = vi.fn<CreateModeEditor>(async (input) => {
    const gate = nextGate
    const failure = nextFailure
    const check = nextCheck
    nextGate = undefined
    nextFailure = undefined
    nextCheck = true
    await gate?.promise
    if (failure !== undefined)
      throw failure
    const next = formulaEditor(input.snapshot, input.formulaMode ?? 'worker')
    next.control.checkOk = check
    if (created.length === 0 && failedBeforeAttach)
      next.fail()
    created.push(next)
    return next.editor
  })
  const fallback = createFormulaFallback({ createEditor, onChange: () => recovering?.sync() })
  const slot = createEditorSlot({ createEditor: fallback.createEditor, onChange: () => recovering?.sync(), reportError: base.options.reportError })
  const changed = vi.fn()
  recovering = createFormulaRecovery({
    fallback,
    slot,
    editing: base.session,
    clock: base.time.clock,
    context: () => state,
    check: editor => editor.openCheck.ok,
    onChange: changed,
    reportError: base.options.reportError,
  })
  const original = await slot.replace(access, '{"v":"原内容"}')
  if (original === undefined)
    throw new Error('测试初值未创建')
  if (access === 'edit') {
    await prepare(base.session, held)
    base.session.startSaving(original, INITIAL)
  }
  slot.attach(original)
  recovering.sync()
  const recovery = recovering
  const first = created[0]
  if (first === undefined)
    throw new Error('测试初值没有记录')
  return {
    ...base,
    held,
    recovery,
    fallback,
    slot,
    createEditor,
    created,
    changed,
    original: first,
    setContext: (patch: Partial<FormulaRecoveryContext>) => {
      state = { ...state, ...patch }
      recovery.sync()
    },
    holdNext: () => {
      nextGate = deferred<void>()
      return nextGate
    },
    failNext: (error: Error) => { nextFailure = error },
    badCheckNext: () => { nextCheck = false },
    dispose: () => {
      recovery.dispose()
      base.session.dispose()
      slot.clear()
    },
  }
}

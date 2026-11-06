import type { CsvOperationReason, CsvSheetSummary, SheetEditor } from '../../editor/index.ts'
import type { CsvErrorReason, CsvTable } from '../../shared/csv/index.ts'
import type { CsvFile, CsvPreview } from './csv-file.ts'
import { CsvOperationError } from '../../editor/index.ts'
import { CSV_LIMITS, CsvError, encodeCsv, parseCsv } from '../../shared/csv/index.ts'
import { csvFilename } from './csv-download.ts'
import { csvPreview } from './csv-file.ts'

export type { CsvFile, CsvPreview } from './csv-file.ts'

export type CsvEditor = Pick<SheetEditor, 'csv' | 'commitCellEditing' | 'settlePanels' | 'settleFormulas' | 'formulasSettled' | 'composing' | 'uncommittedInput'>

export interface CsvTarget {
  readonly editor: CsvEditor
  readonly current: () => boolean
  readonly writable: () => boolean
  readonly formulasPending: () => boolean
}

export type CsvProblem = Exclude<CsvErrorReason, 'cancelled'> | CsvOperationReason | 'file-read' | 'preparation-failed' | 'input-pending' | 'download-failed' | 'export-character' | 'export-capacity'

export type CsvDialog
  = { readonly kind: 'closed' }
    | { readonly kind: 'import', readonly stage: 'selecting' | 'reading' | 'preview' | 'applying', readonly fileName?: string, readonly preview?: CsvPreview }
    | { readonly kind: 'export', readonly stage: 'choosing' | 'preparing', readonly sheets: readonly CsvSheetSummary[], readonly selected: string }

export interface CsvView {
  readonly canImport: boolean
  readonly canExport: boolean
  readonly dialog: CsvDialog
  readonly problem: CsvProblem | undefined
  readonly notice: 'imported' | 'exported' | undefined
}

export interface CsvController {
  readonly view: () => CsvView
  readonly subscribe: (listener: () => void) => () => void
  readonly openImport: () => void
  readonly openExport: () => void
  readonly chooseFile: (file: CsvFile) => Promise<void>
  readonly selectSheet: (id: string) => void
  readonly confirmImport: () => Promise<void>
  /** 同页创建流程的预解析数据；目标另含新空白文档与创建身份见证。 */
  readonly importPrepared: (table: CsvTable, target: CsvTarget) => Promise<boolean>
  readonly exportSelected: () => Promise<void>
  readonly cancel: () => void
  readonly environmentChanged: () => void
  readonly dispose: () => void
}

export interface CsvControllerOptions {
  readonly current: () => CsvTarget | undefined
  readonly prepareImport: () => Promise<void>
  readonly title: () => string
  readonly download: (bytes: Uint8Array, filename: string) => void
}

interface CsvOperation {
  readonly target: CsvTarget
  readonly abort: AbortController
  table?: CsvTable
}

function problemOf(error: unknown, fallback: CsvProblem): CsvProblem {
  if (error instanceof CsvOperationError)
    return error.reason
  if (error instanceof CsvError && error.reason !== 'cancelled')
    return error.reason
  return fallback
}

/**
 * 导出方向的问题（M5R-M-13）：编码器的 syntax/encoding 来自表格里 CSV 写不出的字符（空字符、孤立代理字符，例如 =CHAR(65536)），
 * capacity 来自读取时的范围；沿用导入的文案会让人去检查“文件的引号与分隔符”。其余（行列、字段、字节等）两个方向说法相同
 */
function exportProblemOf(error: unknown, fallback: CsvProblem): CsvProblem {
  const problem = problemOf(error, fallback)
  if (problem === 'syntax' || problem === 'encoding')
    return 'export-character'
  return problem === 'capacity' ? 'export-capacity' : problem
}

/** 一轮意图只绑定一个原实例；所有续体在跨过异步边界后重新检查，不能重取实例接着写。 */
export function createCsvController(options: CsvControllerOptions): CsvController {
  const listeners = new Set<() => void>()
  let disposed = false
  let operation: CsvOperation | undefined
  let view: CsvView = { canImport: false, canExport: false, dialog: { kind: 'closed' }, problem: undefined, notice: undefined }

  function publish(dialog: CsvDialog, problem: CsvProblem | undefined, notice: CsvView['notice']): void {
    const target = disposed ? undefined : options.current()
    const canExport = target?.current() === true
    const canImport = canExport && target?.writable() === true
    if (view.dialog === dialog && view.problem === problem && view.notice === notice && view.canImport === canImport && view.canExport === canExport)
      return
    view = { canImport, canExport, dialog, problem, notice }
    for (const listener of [...listeners]) {
      try {
        listener()
      }
      catch (error) {
        reportError(error)
      }
    }
  }

  function release(): void {
    operation?.abort.abort()
    if (operation)
      operation.table = undefined
    operation = undefined
  }

  function current(mine: CsvOperation): boolean {
    if (disposed || operation !== mine || mine.abort.signal.aborted)
      return false
    if (!mine.target.current()) {
      release()
      publish({ kind: 'closed' }, 'unavailable', undefined)
      return false
    }
    return true
  }

  function begin(target: CsvTarget): CsvOperation {
    release()
    operation = { target, abort: new AbortController() }
    return operation
  }

  function targetForOpen(importing: boolean): CsvTarget | undefined {
    if (disposed || operation)
      return undefined
    const target = options.current()
    if (!target?.current()) {
      publish({ kind: 'closed' }, 'unavailable', undefined)
      return undefined
    }
    if (importing && !target.writable()) {
      publish({ kind: 'closed' }, 'read-only', undefined)
      return undefined
    }
    return target
  }

  function assertWritable(mine: CsvOperation): void {
    if (!mine.target.writable())
      throw new CsvOperationError('read-only')
  }

  function finalProblem(target: CsvTarget): CsvProblem | undefined {
    const { editor } = target
    if (editor.composing() || editor.uncommittedInput() !== 'none')
      return 'input-pending'
    if (!editor.formulasSettled() || target.formulasPending())
      return 'formula-pending'
    return undefined
  }

  // 只有确认后才提交已有输入；取消不负责撤销此前正常完成的用户输入提交。
  async function prepareInput(mine: CsvOperation, importing: boolean): Promise<CsvProblem | undefined> {
    const { editor } = mine.target
    if (editor.composing())
      return 'input-pending'
    if (importing)
      assertWritable(mine)
    const committed = await editor.commitCellEditing()
    if (!current(mine))
      return undefined
    if (!committed || editor.composing())
      return 'input-pending'
    if (importing)
      assertWritable(mine)
    await editor.settlePanels()
    if (!current(mine))
      return undefined
    if (importing)
      assertWritable(mine)
    if (editor.composing() || editor.uncommittedInput() !== 'none')
      return 'input-pending'
    const settled = await editor.settleFormulas(10_000)
    if (!current(mine))
      return undefined
    if (editor.composing() || editor.uncommittedInput() !== 'none')
      return 'input-pending'
    if (settled !== 'settled' || !editor.formulasSettled() || mine.target.formulasPending())
      return 'formula-pending'
    return undefined
  }

  async function applyImport(mine: CsvOperation, dialog: Extract<CsvDialog, { kind: 'import' }>): Promise<boolean> {
    if (!mine.table || !current(mine))
      return false
    publish({ ...dialog, stage: 'applying' }, undefined, undefined)
    try {
      await options.prepareImport()
      if (!current(mine))
        return false
      const preparation = await prepareInput(mine, true)
      if (!current(mine))
        return false
      const problem = preparation ?? finalProblem(mine.target)
      if (problem) {
        publish(dialog, problem, undefined)
        return false
      }
      assertWritable(mine)
      // 等待期间只由 operation 持有矩阵，取消会立即清掉它；不在迟到的会话 Promise 中另留一份引用。
      mine.target.editor.csv.insert(mine.table)
      release()
      publish({ kind: 'closed' }, undefined, 'imported')
      return true
    }
    catch (error) {
      if (current(mine))
        publish(dialog, problemOf(error, 'preparation-failed'), undefined)
      return false
    }
  }

  publish(view.dialog, view.problem, view.notice)
  return {
    view: () => view,
    subscribe(listener) {
      if (!disposed)
        listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    openImport() {
      const target = targetForOpen(true)
      if (!target)
        return
      begin(target)
      publish({ kind: 'import', stage: 'selecting' }, undefined, undefined)
    },
    openExport() {
      const target = targetForOpen(false)
      if (!target)
        return
      try {
        const sheets = target.editor.csv.sheets()
        const selected = sheets.find(sheet => sheet.active)?.id ?? sheets[0]?.id
        if (selected === undefined)
          throw new CsvOperationError('sheet-missing')
        if (!target.current())
          throw new CsvOperationError('unavailable')
        begin(target)
        publish({ kind: 'export', stage: 'choosing', sheets, selected }, undefined, undefined)
      }
      catch (error) {
        publish({ kind: 'closed' }, problemOf(error, 'unavailable'), undefined)
      }
    },
    async chooseFile(file) {
      const previous = operation
      if (!previous || view.dialog.kind !== 'import' || view.dialog.stage === 'applying' || !current(previous))
        return
      if (!previous.target.writable()) {
        publish(view.dialog, 'read-only', undefined)
        return
      }
      const mine = begin(previous.target)
      const fileName = file.name.slice(0, 256)
      publish({ kind: 'import', stage: 'reading', fileName }, undefined, undefined)
      let fallback: CsvProblem = 'file-read'
      try {
        if (!Number.isFinite(file.size) || file.size < 0 || file.size > CSV_LIMITS.bytes)
          throw new CsvError('bytes')
        const bytes = await file.arrayBuffer()
        if (!current(mine))
          return
        fallback = 'syntax'
        const table = await parseCsv(new Uint8Array(bytes), { signal: mine.abort.signal })
        if (!current(mine))
          return
        mine.table = table
        publish({ kind: 'import', stage: 'preview', fileName, preview: csvPreview(table) }, undefined, undefined)
      }
      catch (error) {
        if (current(mine))
          publish({ kind: 'import', stage: 'selecting', fileName }, problemOf(error, fallback), undefined)
      }
    },
    selectSheet(id) {
      if (!operation || !current(operation) || view.dialog.kind !== 'export' || view.dialog.stage !== 'choosing')
        return
      const known = view.dialog.sheets.some(sheet => sheet.id === id)
      publish({ ...view.dialog, selected: id }, known ? undefined : 'sheet-missing', undefined)
    },
    async confirmImport() {
      const mine = operation
      const dialog = view.dialog
      if (!mine || !current(mine) || dialog.kind !== 'import' || dialog.stage !== 'preview' || !mine.table)
        return
      await applyImport(mine, dialog)
    },
    async importPrepared(table, target) {
      if (disposed || operation || !target.current() || !target.writable())
        return false
      const mine = begin(target)
      mine.table = table
      try {
        return await applyImport(mine, { kind: 'import', stage: 'preview', preview: csvPreview(table) })
      }
      finally {
        // 失败时由创建控制器继续拥有数据；不让隐藏的 CSV 操作挡住普通导入或持有第二份意图。
        if (operation === mine) {
          release()
          publish({ kind: 'closed' }, view.problem, undefined)
        }
      }
    },
    async exportSelected() {
      const mine = operation
      const dialog = view.dialog
      if (!mine || !current(mine) || dialog.kind !== 'export' || dialog.stage !== 'choosing')
        return
      const sheet = dialog.sheets.find(sheet => sheet.id === dialog.selected)
      if (!sheet) {
        publish(dialog, 'sheet-missing', undefined)
        return
      }
      publish({ ...dialog, stage: 'preparing' }, undefined, undefined)
      let fallback: CsvProblem = 'preparation-failed'
      try {
        const preparation = await prepareInput(mine, false)
        if (!current(mine))
          return
        const problem = preparation ?? finalProblem(mine.target)
        if (problem) {
          publish(dialog, problem, undefined)
          return
        }
        const bytes = encodeCsv(mine.target.editor.csv.read(sheet.id))
        if (!current(mine))
          return
        fallback = 'download-failed'
        options.download(bytes, csvFilename(options.title(), sheet.name))
        release()
        publish({ kind: 'closed' }, undefined, 'exported')
      }
      catch (error) {
        if (current(mine))
          publish(dialog, exportProblemOf(error, fallback), undefined)
      }
    },
    cancel() {
      release()
      publish({ kind: 'closed' }, undefined, undefined)
    },
    environmentChanged() {
      if (operation)
        current(operation)
      publish(view.dialog, view.problem, view.notice)
    },
    dispose() {
      disposed = true
      release()
      listeners.clear()
      publish({ kind: 'closed' }, undefined, undefined)
    },
  }
}

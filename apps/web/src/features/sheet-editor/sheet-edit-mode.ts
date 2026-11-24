// 表格的编辑模式（M6-P1 S8a，S8 spec §1.5）：共用编辑会话层的通用核心（document-editor 的 edit-mode.ts）加上表格的扩展。表格专有的部分都在这里，
// 经核心的扩展点挂在原来调用表格代码的位置，先后不变（S8 spec §1.4、§1.6）：
// - 公式的回退（formula-fallback.ts）包住表格的工厂，在核心之前建（D11）：Worker 出错之后改用主线程、强制重算；
// - 公式恢复（formula-recovery.ts）在扩展的工厂里建——核心在原来建它的位置调用工厂（建好交接频道的回应之后、算出第一个视图之前）。通知的开头先
//   同步它（其间经它的 onChange 嵌套的通知直接返回，D2），再按稳定状态上报 Worker 的故障（本页首错至多一次，formula-worker-report.ts，D1）；
//   每次创建之后按这一次的输入上报（D8）；恢复挡住动作时核心的各个入口照旧不做事、交接请求回"正在恢复"；会话变了、页面隐藏时撤销，卸载时销毁；
//   恢复就绪时先通知、再让请求编辑重试进入（D9）。视图里的 formulaRecovery 没有变化时交出同一个对象（核心按引用比较）；
// - 进入编辑（含本机恢复）时带"公式待更新"就强制全量重算；保存的状态机的"公式待更新"初值另算 Worker 故障（之后以主线程重算的结果要补存）；
// - CSV 的目标（csvTarget）：核心的动作目标加上表格的条件——打开自检通过、没有 Worker 故障、不在恢复、新文档时是表格的空白模板而且没改过；
// - 工作表名（sheetName）：只问当前接上的实例。
// 选项与原来的 EditModeOptions 相同（工厂是表格的 CreateModeEditor），页面与测试只改了引用
import type { SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { EditMode, EditModeExtension, EditModeHost, EditModeOptions, OpenCheckContext } from '../document-editor/index.ts'
import type { CsvTarget } from './csv-controller.ts'
import type { FormulaRecovery, FormulaRecoveryView } from './formula-recovery.ts'
import type { ReplaceOptions } from './sheet-editor-slot.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { createEditMode } from '../document-editor/index.ts'
import { createFormulaFallback } from './formula-fallback.ts'
import { createFormulaRecovery } from './formula-recovery.ts'
import { formulaWorkerReportOf } from './formula-worker-report.ts'

/** 表格的编辑模式的选项：与原来的 EditModeOptions 相同，编辑器的工厂是表格的 CreateModeEditor */
export type SheetEditModeOptions = EditModeOptions<SheetEditor, SheetViewState | undefined, ReplaceOptions>

/** 表格的扩展并进视图的：公式恢复的状态（没有 Worker 故障时为 undefined） */
export interface SheetEditModeExtra {
  readonly formulaRecovery: FormulaRecoveryView | undefined
}

/** 核心交给表格的扩展的一面 */
type SheetEditModeHost = EditModeHost<SheetEditor, SheetEditorLifecycle, ReplaceOptions>

export interface SheetEditMode extends EditMode<SheetEditorLifecycle, SheetEditModeExtra> {
  /** CSV 导入导出的目标（见文件头）：newDocument 是新建表格之后的导入 */
  readonly csvTarget: (newDocument?: boolean) => CsvTarget | undefined
  readonly sheetName: SheetEditor['sheetName']
  /** 公式恢复没成之后再试 */
  readonly retryFormulaRecovery: () => void
}

export function createSheetEditMode(options: SheetEditModeOptions): SheetEditMode {
  /** 核心交给扩展的一面：核心在构造时（交回之前）调用扩展的工厂时给出，之后一直在 */
  let host: SheetEditModeHost | undefined
  /** 公式恢复：同上，在扩展的工厂里建 */
  let formulaRecovery: FormulaRecovery | undefined
  // 回退包住表格的工厂，在核心之前建（D11）；记下首个故障时经核心通知
  const formulaFallback = createFormulaFallback({ createEditor: options.createEditor, onChange: () => host?.notify() })

  /** 恢复挡住动作（核心的 busy 的后半，CSV 的"不在恢复"） */
  function recovering(): boolean {
    return formulaRecovery?.view()?.blocksActions === true
  }

  /** 表格的扩展：在核心原来建公式恢复的位置建（S8 spec §1.4 的表） */
  function sheetExtension(given: SheetEditModeHost): EditModeExtension<ReplaceOptions, SheetEditModeExtra> {
    host = given
    let formulaReported = false
    let extra: SheetEditModeExtra = { formulaRecovery: undefined }

    /** 本页首错最多一次；后台诊断失败不影响恢复，不携带异常对象，也不重试。 */
    function reportFormulaFault(context: OpenCheckContext): void {
      const failure = formulaFallback.failure()
      if (formulaReported || failure === undefined || given.session() !== 'active' || given.disposed() || given.hidden())
        return
      const report = formulaWorkerReportOf(failure, context, options.format)
      if (report === undefined)
        return
      formulaReported = true
      options.api.reportOpenCheck(options.documentId, report).catch(() => undefined)
    }

    const recovery: FormulaRecovery = createFormulaRecovery({
      fallback: formulaFallback,
      slot: given.slot,
      editing: given.editing,
      clock: given.clock,
      context: given.context,
      check: (created, access, revision) => given.openCheck(created, { access, revision, trigger: 'formula-recovery' }) === undefined,
      onChange: () => {
        given.notify()
        if (recovery.view()?.phase === 'ready')
          given.retryRequests()
      },
      reportError: given.reportError,
    })
    formulaRecovery = recovery
    return {
      onNotify: (stable) => {
        recovery.sync()
        // 过渡流程仍由实际创建入口报告；稳定模式下的运行期故障才能用本页当前修订。
        const place = stable()
        if (place !== undefined)
          reportFormulaFault({ ...place, trigger: 'formula-recovery' })
      },
      afterCreate: reportFormulaFault,
      blocksActions: recovering,
      view: () => {
        const next = recovery.view()
        if (extra.formulaRecovery !== next)
          extra = { formulaRecovery: next }
        return extra
      },
      cancel: () => recovery.cancel(),
      dispose: () => recovery.dispose(),
      // 带"公式待更新"进入编辑：强制全量重算（重算只能是 true，不重算就不带这一项，sheet-editor-slot.ts）
      enterOptions: pending => pending ? { recalculate: true } : {},
      // Worker 出错之后以主线程重算：它的结果同样要补存
      savingPending: flag => flag || formulaFallback.failure() !== undefined,
    }
  }

  const mode = createEditMode<SheetEditor, SheetViewState | undefined, SheetEditorLifecycle, ReplaceOptions, SheetEditModeExtra>({
    ...options,
    createEditor: formulaFallback.createEditor,
    defaultOptions: {},
    extension: sheetExtension,
  })

  function csvTarget(newDocument = false): CsvTarget | undefined {
    const target = host?.actionTarget()
    if (target === undefined)
      return undefined
    const { editor } = target
    const pristine = (): boolean => !newDocument || (target.mode === 'editing' && target.revision() === 1
      && editor.changeSeq() === 0 && target.unsaved() === false
      && !editor.composing() && editor.uncommittedInput() === 'none')
    if (newDocument) {
      try {
        // 文档 id 与正文 unitId 独立；同时证明服务器原件是该 unit 的空白模板、当前实例未改它。
        if (!pristine() || target.snapshot !== sheetSnapshotFor(editor.unitId) || editor.capture() !== target.snapshot)
          return undefined
      }
      catch {
        return undefined
      }
    }
    // 核心的动作目标先判断（接上的还是这个实例），表格的条件之后才读这个实例
    const current = (): boolean => target.current() && editor.openCheck.ok && editor.workerFailure() === undefined && !recovering() && pristine()
    if (!current())
      return undefined
    return {
      editor,
      current,
      writable: () => target.mode === 'editing' && current() && target.writable(),
      // 阅读不重算，必须尊重服务器的旧缓存标记。编辑态已按该标记强制重算，完成与否由 SDK 的实时 tracker 判断；
      // 保存协调器的标记还可能只是“算完但尚未上传”，不能让导出依赖一次新的正文保存。
      formulasPending: target.formulasPending,
    }
  }

  return {
    ...mode,
    csvTarget,
    sheetName: sheetId => host === undefined || host.disposed() ? undefined : host.slot.editor()?.sheetName(sheetId),
    retryFormulaRecovery: () => formulaRecovery?.retry(),
  }
}

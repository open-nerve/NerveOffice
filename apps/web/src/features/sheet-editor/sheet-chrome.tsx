// 表格的页头插槽（M6-P1 S8c，S8 spec §3.2）：页头的通用骨架（共用编辑会话层的 editor-chrome.tsx）里表格专有的 7 处，原样从原来的页头搬来：
// - 挡住动作：公式恢复期间（编辑模式视图里 formulaRecovery 的 blocksActions）；确认框里挡住时的说明；
// - 读屏播报区的第三件事实：公式恢复的说明（formula-recovery-ui.ts）；
// - 页头行之后的一行：CSV 的入口；
// - 图片操作的提示文字（适配层的图片输入状态，image-input-notice.ts）；
// - 图片状态之后的一块：公式恢复的说明，失败时带"重试公式恢复"；
// - 保存被拒与副本被拒的说明：按违反的规则与位置说，工作表名取当前实例（snapshot-problem.ts）。
// 插槽不收页面（S10，独立审查 B 的问题 1）：每页建一次——表格的装配建好页面扩展之后，把扩展对象交给 sheetChromeOf（sheet-editor-page.ts），
// 经扩展的成员 chrome 交给使用方。插槽在用到的那一刻读这个对象上的 CSV 控制器、工作表名与公式恢复的重试（不在建插槽时取值，读的正是页面扩展
// 交出的那一份）；公式恢复的重试另按页面视图的当前值判断（骨架交给 notice 的 current，同原来的 page.view()）。插槽对象建一次、不在渲染时现建，
// 交回的元素是模块级组件（CsvEntry、Button；组件身份不变，CSV 对话框的状态不丢）。这里不调 hook（CsvEntry 自己里面有）
import type { SheetChromeSlots, SheetEditorPageMembers } from './sheet-editor-page.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { Button } from '../../shared/ui/index.ts'
import { CsvEntry } from './csv-entry.tsx'
import { formulaRecoveryNotice } from './formula-recovery-ui.ts'
import { imageInputNotice } from './image-input-notice.ts'
import { snapshotProblem } from './snapshot-problem.ts'

/** 插槽用到的表格成员：页面扩展交给使用方的那一份，插槽在用到的那一刻读 */
export type SheetChromeSources = Pick<SheetEditorPageMembers, 'csv' | 'sheetName' | 'retryFormulaRecovery'>

/** 表格的页头插槽：装配建好页面扩展之后按扩展对象建一次（sheet-editor-page.ts） */
export function sheetChromeOf(sources: SheetChromeSources): SheetChromeSlots {
  return {
    blocksActions: view => view.formulaRecovery?.blocksActions === true,
    actionBlocked: editorMessages.formulaRecovery.actionBlocked,
    announcement: view => formulaRecoveryNotice(view)?.text,
    toolbar: fallbackFocus => <CsvEntry controller={sources.csv} fallbackFocus={fallbackFocus} />,
    imageOperation: imageInputNotice,
    notice: (view, current) => {
      const formula = formulaRecoveryNotice(view)
      if (formula === undefined)
        return undefined
      return (
        <div data-slot="formula-recovery" className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm text-muted-foreground">
          <p>{formula.text}</p>
          {view.formulaRecovery?.phase === 'failed' && (
            <Button size="sm" variant="outline" aria-disabled={!formula.canRetry} onClick={() => formulaRecoveryNotice(current())?.canRetry && sources.retryFormulaRecovery()}>
              {editorMessages.formulaRecovery.retry}
            </Button>
          )}
        </div>
      )
    },
    snapshotProblem: details => snapshotProblem(details, 'sheet', sheetId => sources.sheetName(sheetId)),
  }
}

// 表格的页头插槽（M6-P1 S8c，S8 spec §3.2）：页头的通用骨架（共用编辑会话层的 editor-chrome.tsx）里表格专有的 7 处，原样从原来的页头搬来：
// - 挡住动作：公式恢复期间（编辑模式视图里 formulaRecovery 的 blocksActions）；确认框里挡住时的说明；
// - 读屏播报区的第三件事实：公式恢复的说明（formula-recovery-ui.ts）；
// - 页头行之后的一行：CSV 的入口（有 CSV 控制器时）；
// - 图片操作的提示文字（适配层的图片输入状态，image-input-notice.ts）；
// - 图片状态之后的一块：公式恢复的说明，失败时带"重试公式恢复"；
// - 保存被拒与副本被拒的说明：按违反的规则与位置说，工作表名取当前实例（snapshot-problem.ts）。
// 模块级常量（组件身份不变：CSV 对话框的状态不丢），经表格页面扩展交给使用方的成员 chrome 给出（sheet-editor-page.ts）。
// 都在渲染、点击的那一刻读 page.extension()（CSV 控制器、工作表名、公式恢复的重试），不把扩展的成员抓进闭包；这里不调 hook（CsvEntry 自己里面有）
import type { SheetChromeSlots } from './sheet-editor-page.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { Button } from '../../shared/ui/index.ts'
import { CsvEntry } from './csv-entry.tsx'
import { formulaRecoveryNotice } from './formula-recovery-ui.ts'
import { imageInputNotice } from './image-input-notice.ts'
import { snapshotProblem } from './snapshot-problem.ts'

export const sheetChrome: SheetChromeSlots = {
  blocksActions: view => view.formulaRecovery?.blocksActions === true,
  actionBlocked: editorMessages.formulaRecovery.actionBlocked,
  announcement: view => formulaRecoveryNotice(view)?.text,
  toolbar: (page, fallbackFocus) => {
    const csv = page.extension()?.csv
    return csv === undefined ? undefined : <CsvEntry controller={csv} fallbackFocus={fallbackFocus} />
  },
  imageOperation: imageInputNotice,
  notice: (view, page) => {
    const formula = formulaRecoveryNotice(view)
    if (formula === undefined)
      return undefined
    return (
      <div data-slot="formula-recovery" className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm text-muted-foreground">
        <p>{formula.text}</p>
        {view.formulaRecovery?.phase === 'failed' && (
          <Button size="sm" variant="outline" aria-disabled={!formula.canRetry} onClick={() => formulaRecoveryNotice(page.view())?.canRetry && page.extension()?.retryFormulaRecovery()}>
            {editorMessages.formulaRecovery.retry}
          </Button>
        )}
      </div>
    )
  },
  snapshotProblem: (details, page) => snapshotProblem(details, 'sheet', sheetId => page.extension()?.sheetName(sheetId)),
}

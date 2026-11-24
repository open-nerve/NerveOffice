import type { DraftCaptureRef, WorkingDraft } from '../../shared/local-drafts/working-draft.ts'
// 失去编辑权后的 SDK 捕获；副本请求与结果协调位于 shared/local-drafts/copy-flow.ts。
import type { CaptureEditor } from './snapshot-capture.ts'
import { takeSnapshot } from './snapshot-capture.ts'

export interface LostContent {
  readonly ref: DraftCaptureRef | undefined
  readonly formulasPending: boolean
  /** 单元格提交不了：快照只有已经落进模型的内容，不含仍在输入的部分。 */
  readonly inputLeft: boolean
}

/** 失效时先保留面板改动与当前输入，再立即捕获；不等待公式，查不出时保守地带待更新标记。 */
export async function captureLostContent(editor: CaptureEditor | undefined, draft: WorkingDraft | undefined, reportError: (error: unknown) => void): Promise<LostContent> {
  let ref: DraftCaptureRef | undefined
  let inputLeft = false
  let formulasPending = true
  try {
    await editor?.settlePanels()
    if (editor?.isCellEditing() === true)
      inputLeft = !(await editor.commitCellEditing())
    formulasPending = editor === undefined || (await editor.settleFormulas(0)) !== 'settled'
    if (editor !== undefined && draft !== undefined)
      ref = takeSnapshot(editor, draft, { formulasPending, dedupe: false })
  }
  catch (error) {
    reportError(error)
  }
  return { ref, formulasPending, inputLeft }
}

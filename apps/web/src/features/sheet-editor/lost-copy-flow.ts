// 失去编辑权后的捕获和副本结果；页面仍持有作废标识，并决定何时按最新内容重建。
import type { CreatedDocument, DocumentDetail } from '@nerve-office/contracts'
import type { LostCopyOptions } from './lost-copy.ts'
import type { CaptureEditor } from './snapshot-capture.ts'
import type { DraftCaptureRef, WorkingDraft } from './working-draft.ts'
import { ApiError, isAuthenticationError, isCsrfTokenError } from '../../shared/api/index.ts'
import { incompatibilityOf } from './client-format.ts'
import { createLostCopy } from './lost-copy.ts'
import { takeSnapshot } from './snapshot-capture.ts'

/**
 * 服务端不收本页的这份内容、再试也一样（M3-P3 审查 B3）：
 * - outdated：本页的版本过旧（CLIENT_OUTDATED）——服务端对副本同样拦旧页面，要重新加载页面，本页的内容先复制出来；
 * - content：内容本身不合规则（SNAPSHOT_INVALID，规则在错误的详情里）或者超过容量上限（PAYLOAD_TOO_LARGE）。
 */
export type CopyRefusal = 'outdated' | 'content'

/** 另存为副本的进展；成功事实与页面重建的进展分开，重建失败不能抹掉副本链接。 */
export type CopyState
  = | { readonly kind: 'idle' }
    | { readonly kind: 'saving' }
  /** 没有成功、可以再试（网络、服务端出错、登录的问题、读不到、请求标识被占用等）：内容一律留着 */
    | { readonly kind: 'failed', readonly error: unknown }
  /** 被拒、再试也一样：不再给“另存为副本”，内容照样留着，离开照样提示 */
    | { readonly kind: 'refused', readonly refusal: CopyRefusal, readonly error: ApiError }
    | { readonly kind: 'done', readonly document: DocumentDetail }

export type CopyResult
  = | Extract<CopyState, { readonly kind: 'failed' | 'refused' }>
    | { readonly kind: 'done', readonly document: CreatedDocument }

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

/** 内容与版本的确定拒绝；其他失败仍可重试。 */
export function copyRefusalOf(error: unknown): { readonly refusal: CopyRefusal, readonly error: ApiError } | undefined {
  if (!(error instanceof ApiError))
    return undefined
  if (incompatibilityOf(error) === 'client-outdated')
    return { refusal: 'outdated', error }
  return error.code === 'SNAPSHOT_INVALID' || error.code === 'PAYLOAD_TOO_LARGE' ? { refusal: 'content', error } : undefined
}

export interface LostCopyFlowOptions extends LostCopyOptions {
  readonly onSessionProblem: (error: ApiError) => void
}

export interface LostCopyFlow {
  readonly save: () => Promise<CopyResult>
  readonly dispose: () => void
}

/** 请求标识和标题仍由 lost-copy 持有；本模块只归类结果，不决定页面的生命周期。 */
export function createLostCopyFlow(options: LostCopyFlowOptions): LostCopyFlow {
  const copy = createLostCopy(options)
  return {
    dispose: copy.dispose,
    save: async () => {
      try {
        return { kind: 'done', document: await copy.save() }
      }
      catch (error) {
        if (isAuthenticationError(error) || isCsrfTokenError(error))
          options.onSessionProblem(error)
        const refused = copyRefusalOf(error)
        return refused === undefined ? { kind: 'failed', error } : { kind: 'refused', ...refused }
      }
    },
  }
}

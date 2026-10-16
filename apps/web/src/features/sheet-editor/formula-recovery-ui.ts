import type { EditorPageView } from './editor-page.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'

export interface FormulaRecoveryNotice {
  readonly text: string
  readonly canRetry: boolean
}

/** 公式恢复与云端/本机保存是独立事实；失权等出口继续由原页面说明负责。 */
export function formulaRecoveryNotice(view: EditorPageView): FormulaRecoveryNotice | undefined {
  const recovery = view.formulaRecovery
  const mode = view.mode
  if (view.load.kind !== 'ready' || recovery === undefined || (mode?.kind !== 'reading' && mode?.kind !== 'editing') || (mode.kind === 'reading' && mode.gone))
    return undefined
  const messages = editorMessages.formulaRecovery
  let text: string
  switch (recovery.phase) {
    case 'waiting-input':
      text = messages.waiting
      break
    case 'preparing':
    case 'rebuilding':
      text = messages.working
      break
    case 'paused':
      text = view.session === 'active' ? messages.paused : messages.session
      break
    case 'ready':
      text = messages.ready
      break
    case 'failed':
      switch (recovery.problem) {
        case 'input':
          text = messages.input
          break
        case 'capture':
          text = messages.capture
          break
        case 'open-check':
          text = messages.openCheck
          break
        case 'create':
        case undefined:
          text = messages.create
          break
      }
      break
  }
  const terminal = view.save?.status === 'conflict' || view.save?.status === 'outdated' || view.save?.status === 'too-new'
  const available = mode.kind === 'editing' ? view.save !== undefined && !terminal : mode.update !== 'loading' && mode.takeover === undefined
  return { text, canRetry: recovery.phase === 'failed' && available && view.session === 'active' && !view.confirmingSession && view.sessionProblem === undefined }
}

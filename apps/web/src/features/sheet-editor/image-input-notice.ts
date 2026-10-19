import type { ImageInputOperation, ImageInputReason, ImageInputState } from '../../editor/index.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'

const operations: Readonly<Record<ImageInputOperation, string>> = editorMessages.images.operations
const reasons: Readonly<Record<ImageInputReason, string>> = editorMessages.images.reasons

/** 只接收结构化状态，来源、文件名与原始异常不进入用户提示。 */
export function imageInputNotice(state: ImageInputState): string {
  const messages = editorMessages.images
  const operation = operations[state.operation]
  const progress = state.completed > 0 && (state.operation === 'insert' || state.operation === 'paste')
    ? messages.progress(state.completed, state.total)
    : ''
  if (state.kind === 'failed')
    return messages.incomplete(operation) + reasons[state.reason] + progress
  return messages[state.kind](operation) + progress
}

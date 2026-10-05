// 测试用：显式保存的捕获来源（保存的状态机的单元测试直接驱动上传，不经自动保存）。生产里立即上传的捕获由自动保存的 flush 给出
// （autosave.ts：先等面板、提交单元格、等公式至多捕获的上限，从按下算）
import type { CaptureSource } from './save-coordinator.ts'
import type { CaptureEditor } from './snapshot-capture.ts'
import { AUTOSAVE_CAPTURE_MAX_MS } from '@nerve-office/contracts'
import { prepareCapture, takeSnapshot } from './snapshot-capture.ts'

/** 显式保存等公式收齐的上限：与捕获的上限同一个数，从按下算（P4 设计 §3.4，M1-P4 设计 §3.6.6） */
export const EXPLICIT_SETTLE_TIMEOUT_MS = AUTOSAVE_CAPTURE_MAX_MS

/** 显式保存的捕获来源：先等面板、提交单元格、等公式至多 settleTimeoutMs、捕获；不算摘要（这一次不去重，确认之后也不留键） */
export function explicitCaptureSource(editor: CaptureEditor, settleTimeoutMs: number = EXPLICIT_SETTLE_TIMEOUT_MS): CaptureSource {
  return async () => prepareCapture(editor, { settleTimeoutMs: () => settleTimeoutMs, take: formulasPending => takeSnapshot(editor, formulasPending) })
}

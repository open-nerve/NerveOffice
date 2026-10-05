// 捕获（00 号计划书 §7.2 的①、§7.3，M3-P4 设计 §3.2 第 3 条、§3.4）：从编辑器取一份快照，交给保存的状态机（save-coordinator.ts）上传。
// - takeSnapshot：同步捕获——修改序号与 JSON.stringify(save()) 在同一个同步段里读出（计划书 §7.2：localSeq 在捕获这一步分配）；
//   捕获前不调 Facade 的读取方法由编辑器的 capture 保证；
// - prepareCapture：立即上传要的"先提交单元格、再等公式"：先提交正在编辑的单元格（等同回车，提交不了就中止，只是提示），
//   再等公式收齐（至多到时限，没收齐就带上"公式待更新"），然后捕获，按需算出去重用的摘要；
// - explicitCaptureSource：显式保存的捕获来源（编辑模式在自动保存接上之前用它，P4 设计 §6 的 S4 换成自动保存的立即上传）。
// 何时捕获由捕获的规则（capture-policy.ts）与调度（autosave.ts）决定，这里只管怎么捕获。
import type { CaptureSource, PreparedCapture, SnapshotCapture } from './save-coordinator.ts'
import { AUTOSAVE_CAPTURE_MAX_MS } from '@nerve-office/contracts'

/** 捕获用到的编辑器能力（SheetEditor 的子集） */
export interface CaptureEditor {
  readonly changeSeq: () => number
  readonly isCellEditing: () => boolean
  /** 提交正在编辑的单元格（等同回车）；提交之后仍在编辑时为 false */
  readonly commitCellEditing: () => Promise<boolean>
  /** 等公式收齐，至多 timeoutMs（0 是按此刻的状态，不等） */
  readonly settleFormulas: (timeoutMs: number) => Promise<'settled' | 'timeout'>
  /** JSON.stringify(save()) */
  readonly capture: () => string
}

/** 显式保存（保存按钮、退出编辑）等公式收齐的上限：与捕获的上限同一个数，从按下算（P4 设计 §3.4，M1-P4 设计 §3.6.6） */
export const EXPLICIT_SETTLE_TIMEOUT_MS = AUTOSAVE_CAPTURE_MAX_MS

const UTF8 = new TextEncoder()

/** UTF-8 字节数：与服务端解压后的字节同一个口径（快照的上限与 80% 的提示都按它） */
export function utf8Length(text: string): number {
  return UTF8.encode(text).byteLength
}

/** 同步捕获：序号与快照在同一个同步段里读出，其间不会有别的修改。去重用的摘要另算（异步），这里为 undefined */
export function takeSnapshot(editor: Pick<CaptureEditor, 'changeSeq' | 'capture'>, formulasPending: boolean): SnapshotCapture {
  const seq = editor.changeSeq()
  const snapshot = editor.capture()
  return { seq, snapshot, bytes: utf8Length(snapshot), formulasPending, digest: undefined }
}

export interface PrepareCaptureOptions {
  /** 等公式收齐的时限（毫秒）；0 是按此刻的状态，不等 */
  readonly settleTimeoutMs: number
  /** 捕获：给出这次捕获算不算"公式待更新"（自动保存换成记进"最近一次捕获"的那个） */
  readonly take: (formulasPending: boolean) => SnapshotCapture
  /** 快照的摘要（会话内去重的键，P4 设计 §3.7）：算不出时为 undefined；不给时不算 */
  readonly digest?: (snapshot: string) => Promise<string | undefined>
}

/**
 * 先提交正在编辑的单元格（提交不了就中止：'cell-editing'），再等公式收齐（至多 settleTimeoutMs），然后捕获、按需算摘要。
 * 出错（SDK 的缺陷等）原样抛出，保存的状态机按意外的错误处理
 */
export async function prepareCapture(editor: CaptureEditor, options: PrepareCaptureOptions): Promise<PreparedCapture> {
  if (editor.isCellEditing() && !(await editor.commitCellEditing()))
    return 'cell-editing'
  const settled = (await editor.settleFormulas(options.settleTimeoutMs)) === 'settled'
  const capture = options.take(!settled)
  if (options.digest === undefined)
    return capture
  return { ...capture, digest: await options.digest(capture.snapshot) }
}

/** 显式保存的捕获来源：提交单元格、等公式至多 settleTimeoutMs（从开始准备算）、捕获；不算摘要（这一次不去重，确认之后也不留键） */
export function explicitCaptureSource(editor: CaptureEditor, settleTimeoutMs: number = EXPLICIT_SETTLE_TIMEOUT_MS): CaptureSource {
  return async () => prepareCapture(editor, { settleTimeoutMs, take: formulasPending => takeSnapshot(editor, formulasPending) })
}

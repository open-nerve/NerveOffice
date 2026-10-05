// 捕获（00 号计划书 §7.2 的①、§7.3，M3-P4 设计 §3.2 第 3 条、§3.4）：从编辑器取一份快照，交给保存的状态机（save-coordinator.ts）上传。
// - takeSnapshot：同步捕获——修改序号与 JSON.stringify(save()) 在同一个同步段里读出（计划书 §7.2：localSeq 在捕获这一步分配）；
//   捕获前不调 Facade 的读取方法由编辑器的 capture 保证；
// - prepareCapture：立即上传（保存按钮、退出编辑、交出与空闲释放）要的"先让输入落进模型、再等公式"：先等面板里防抖中的改动写进模型
//   （批注浮层、数据验证面板，适配层的 settlePanels，S4），再提交正在编辑的单元格（等同回车，提交不了就中止，只是提示），
//   再等公式收齐（至多到时限，没收齐就带上"公式待更新"），然后捕获（去重用的摘要由调用方另算）。
// 何时捕获由捕获的规则（capture-policy.ts）与调度（autosave.ts）决定，这里只管怎么捕获。
import type { SnapshotCapture } from './save-coordinator.ts'

/** 捕获用到的编辑器能力（SheetEditor 的子集） */
export interface CaptureEditor {
  readonly changeSeq: () => number
  readonly isCellEditing: () => boolean
  /** 提交正在编辑的单元格（等同回车）；提交之后仍在编辑时为 false */
  readonly commitCellEditing: () => Promise<boolean>
  /** 等公式收齐，至多 timeoutMs（0 是按此刻的状态，不等） */
  readonly settleFormulas: (timeoutMs: number) => Promise<'settled' | 'timeout'>
  /** 等面板里防抖中的改动写进模型（适配层的 settlePanels）；没有在等的时立即兑现 */
  readonly settlePanels: () => Promise<void>
  /** JSON.stringify(save()) */
  readonly capture: () => string
}

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

export interface PrepareCaptureOptions<T extends SnapshotCapture> {
  /**
   * 等公式收齐的时限（毫秒；0 是按此刻的状态，不等）：等完面板、提交了单元格之后才取——时限从按下算（P4 设计 §3.4），
   * 前面几步用掉的不再给公式
   */
  readonly settleTimeoutMs: () => number
  /** 捕获：给出这次捕获算不算"公式待更新"（自动保存换成记进"最近一次捕获"的那个） */
  readonly take: (formulasPending: boolean) => T
}

/**
 * 先等面板里防抖中的改动写进模型，再提交正在编辑的单元格（提交不了就中止：'cell-editing'），再等公式收齐（至多 settleTimeoutMs），
 * 然后捕获。出错（SDK 的缺陷等）原样抛出，保存的状态机按意外的错误处理
 */
export async function prepareCapture<T extends SnapshotCapture>(editor: CaptureEditor, options: PrepareCaptureOptions<T>): Promise<T | 'cell-editing'> {
  await editor.settlePanels()
  if (editor.isCellEditing() && !(await editor.commitCellEditing()))
    return 'cell-editing'
  const settled = (await editor.settleFormulas(Math.max(0, options.settleTimeoutMs()))) === 'settled'
  return options.take(!settled)
}

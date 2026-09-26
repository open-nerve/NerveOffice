// 载入前核对快照的基本结构（与服务端保存时的基本校验同一口径，P4 设计 §3.5.1 第 2 步）：
// 顶层是对象，id 是非空字符串（它就是 Univer 的 unitId），sheetOrder 是数组、sheets 是对象。
// 缺了这些，SDK 会悄悄补一张新的工作表或随机的 id，打开的就不是这份文档了。完整的快照校验在 M3
import type { IWorkbookData } from '@univerjs/core'
import { SheetEditorLoadError } from './sheet-editor-error.ts'

export interface WorkbookSnapshot {
  readonly unitId: string
  /** 交给 createWorkbook 的对象：每次都从文本重新解析，SDK 会改动传入的对象 */
  readonly data: Partial<IWorkbookData>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseWorkbookSnapshot(text: string): WorkbookSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    throw new SheetEditorLoadError('snapshot-invalid', '快照不是合法的 JSON', { cause: error })
  }
  if (!isPlainObject(parsed))
    throw new SheetEditorLoadError('snapshot-invalid', '快照的顶层不是对象')
  const { id, sheetOrder, sheets } = parsed
  if (typeof id !== 'string' || id === '')
    throw new SheetEditorLoadError('snapshot-invalid', '快照没有 id（unitId）')
  if (!Array.isArray(sheetOrder) || !isPlainObject(sheets))
    throw new SheetEditorLoadError('snapshot-invalid', '快照不是工作簿：sheetOrder 应是数组、sheets 应是对象')
  return { unitId: id, data: parsed }
}

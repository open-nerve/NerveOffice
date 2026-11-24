// 表格编辑器对会话层槽位（document-editor 的 editor-slot.ts）的实例（M6-P1 S7，S6 spec §5.3）：编辑器是 SheetEditor，创建的选项是
// 进入编辑时的强制全量重算与公式的模式。原来由槽位做的规整（重算只在为真时交给工厂）改由类型保证：recalculate 只能是 true，
// 不重算就不带这一项——表格的扩展（sheet-edit-mode.ts 的 enterOptions）为真时才带上。Worker 失败之后的回退（formula-fallback.ts）包住表格的工厂，
// 由表格的装配（S8a 起是 sheet-edit-mode.ts）交给会话层的编辑模式，编辑模式以这些类型参数建槽位、空对象作默认选项。这里只有类型。
import type { FormulaMode, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { CreateSlotEditor, EditorSlot, EditorSurface } from '../document-editor/index.ts'

/** 这一次新建的选项 */
export interface ReplaceOptions {
  /** 打开时强制全量重算（M3-P4 设计 §3.5：带"公式待更新"的文档进入编辑；Worker 失败之后以主线程重建）；不重算时不带这一项 */
  readonly recalculate?: true
  /** 公式的模式：Worker 失败之后改用主线程（formula-fallback.ts、formula-recovery.ts） */
  readonly formulaMode?: FormulaMode
}

/** 新建表格编辑器的工厂：容器由页面绑定（适配层 createSheetEditor 的同名参数） */
export type CreateModeEditor = CreateSlotEditor<SheetEditor, SheetViewState | undefined, ReplaceOptions>

export type SheetEditorSlot = EditorSlot<SheetEditor, SheetEditorLifecycle, ReplaceOptions>

/** 表格编辑器的进展：none、creating，之后随 SheetEditor 的生命周期 */
export type SheetEditorSurface = EditorSurface<SheetEditorLifecycle>

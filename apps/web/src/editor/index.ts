// 编辑器适配层的公开入口（P4 设计 §3.6.1，ADR-003）：Univer 的一切都在 src/editor/ 里，对外只有这一个小接口。
// 只有编辑器页的入口与 sheet-editor 功能能引用这里（eslint.config.ts 的模块边界）；平台页面的包里没有编辑器
export type { EditorAccess } from './editor-access.ts'
export type { SheetEditorLifecycle } from './lifecycle-watch.ts'
export type { OpenCheck } from './profile/open-check.ts'
export { SHEET_PROFILE_ID } from './profile/sheet-profile.ts'
export { SheetEditorLoadError } from './sheet-editor-error.ts'
export type { SheetEditorFailure } from './sheet-editor-error.ts'
export { createSheetEditor } from './sheet-editor.ts'
export type { CreateSheetEditorOptions, SheetEditor } from './sheet-editor.ts'
export type { SheetViewState } from './view-state.ts'

// 共用编辑会话层的公开入口（M6-P1 设计 §3.1、§3.5）：与文档类型无关的编辑会话——编辑权、交接与请求编辑、本机锁、草稿与发件箱、恢复、
// 页面的小件；S7 起另有保存与自动保存、捕获、同一浏览器的交接、页头的保存状态与编辑器槽位；S8a 起另有编辑模式的通用核心与打开自检的上报
// （表格的扩展与门面在 sheet-editor/sheet-edit-mode.ts）；S8b 起另有按类型装配的编辑器页（表格的装配在 sheet-editor/sheet-editor-page.ts）；
// S8c 起另有页头的骨架（插槽的类型 EditorChromeSlots，表格的插槽在 sheet-editor/sheet-chrome.tsx）与编辑器页的启动（kit 等类型，表格的 kit 在
// sheet-editor/start.tsx）。依赖方向是 sheet-editor → document-editor：只由编辑器页引用（编辑器页的入口与表格编辑器，eslint.config.ts 的模块边界）。
// 这里只放表格编辑器（P2 起还有文字文档编辑器）的生产代码实际引用的名字，逐个列出（S6 spec §2）：入口转出什么，它们的生产代码就能直接用什么，
// 多转出的内部部件（例如本机锁、编辑会话的工厂）会让它们绕开编辑模式与页面的协调，lint 也拦不住。S10 按引用方重新核对过：没有引用方的删去，
// 只有测试用到的移进 index.test-support.ts（测试另经它取）。请求层 editor-api 不再以命名空间 editorApi 转出：组装处 S8c 起在会话层的 start.tsx 里，
// 直接引用 editor-api.ts，命名空间的理由（两个 acquireEditLease 并到一个入口里同名）随之不在了。
// 启动是组合处专用的窄入口：这里只转出它的类型，值 startEditorPage 由编辑器页的入口直接引用 start.tsx（从这里转出的话，表格编辑器的生产代码与
// 测试的模块图里都会多出 React DOM、分享对话框、弹窗等页面外壳）；页头的骨架给表格编辑器的测试经 index.test-support.ts
export { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
export type { LeaseLoss } from './edit-lease.ts'
export { createEditMode } from './edit-mode.ts'
export type { EditMode, EditModeExtension, EditModeHost, EditModeOptions, EditModeState } from './edit-mode.ts'
export type { EditingSession } from './editing-session.ts'
export type { EditorChromeSlots } from './editor-chrome.tsx'
export type { EditorPage, EditorPageAssembly, EditorPageBindings, EditorPageExtension, EditorPageLoad, EditorPageView } from './editor-page.ts'
export type { CreateSlotEditor, EditorSlot, EditorSurface } from './editor-slot.ts'
export type { OpenCheckContext } from './open-check-report.ts'
export type { EditorPageElements, EditorPageKit, EditorPageMount } from './start.tsx'

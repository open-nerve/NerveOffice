// 编辑器页的公开入口（P4 设计 §3.7）：只由编辑器页的入口（entries/editor）引用，平台页面的包里没有它（eslint.config.ts 的模块边界）。
export { startSheetEditorPage } from './start.tsx'
export type { SheetEditorPageElements } from './start.tsx'

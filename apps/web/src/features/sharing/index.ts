// 分享对话框（M2-P5 设计 §3.5）：带着 Radix Dialog、同事选择与确认的弹窗。只有入口所在的两个文件引用这里（lint 的模块边界）：
// 平台页面文档的行操作（features/documents/share-entry.tsx）按需加载，不进平台页面的首屏；编辑器页的页头
// （features/sheet-editor/share-entry.tsx）静态引用（理由见那个文件的开头）。
export { ShareDialog } from './share-dialog.tsx'
export type { ShareDialogProps } from './share-dialog.tsx'

// 编辑器页的公开入口（P4 设计 §3.7）：只由编辑器页的入口（entries/editor）引用，平台页面的包里没有它（eslint.config.ts 的模块边界）。
// M6-P1 S8c（S8 spec §3.3）：编辑器页的启动在共用编辑会话层（document-editor 的 start.tsx，编辑器页的入口直接引用它）；这里转出表格的启动装配（kit）
// 与新建表格的页面（它收启动函数，不再引用表格的 start）
export { startCsvCreatePage } from './csv-create-start.tsx'
export { sheetEditorPageKit } from './start.tsx'

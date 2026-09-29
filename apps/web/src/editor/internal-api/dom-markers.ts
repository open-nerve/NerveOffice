// SDK 界面里的 DOM 标记（M2-P3 S3 之后的只读修复）：Univer 的 React 组件给元素加的 data-u-comp，不是公开 API，版本之间可能改名。
// 只读守卫按它们找到元素（read-only/）；每一项在 registry.ts 登记来源与回归用例，SDK 升级时由 read-only.spec.ts 回归

/**
 * 批注浮层里的文本框（sheets-note-ui 的 views/Note.tsx:156-158 给 Textarea 传 data-u-comp="note-textarea"，
 * design 的 Textarea 把它放在 <textarea> 元素上、覆盖自己的 "textarea"）
 */
export const NOTE_TEXTAREA_SELECTOR = 'textarea[data-u-comp="note-textarea"]'

/**
 * 编辑栏里接收输入的部分：编辑框（formula-editor）与它左边的取消、确认、插入函数按钮（formula-bar-actions）。
 * sheets-ui 的 views/formula-bar/FormulaBar.tsx:298-363（根元素 formula-bar，按钮 formula-bar-actions）、:366-402（编辑框）。
 * 单元格编辑器里也有一个 formula-editor，按编辑栏的根元素限定。名称框（defined-name）与展开的箭头不在里面
 */
export const FORMULA_BAR_INPUT_SELECTOR = '[data-u-comp="formula-bar"] [data-u-comp="formula-editor"], [data-u-comp="formula-bar"] [data-u-comp="formula-bar-actions"]'

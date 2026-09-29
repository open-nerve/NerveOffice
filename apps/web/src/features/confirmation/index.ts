// 危险操作的确认弹窗（带 Radix Dialog）：只由按需加载的页面（管理界面、成员页）引用，不进首屏（ADR-008）。
export { ConfirmDialog } from './confirm-dialog.tsx'
export type { PendingConfirmation } from './confirm-dialog.tsx'

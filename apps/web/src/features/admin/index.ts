// 管理界面（M2-P1 设计 §3.8）：按需加载，不进平台页面的首屏包：app/routes.ts 只用动态 import 引用这里，
// 任何地方都不得静态引用（静态引用会让整个管理界面回到首屏包）。页面地址在 shared/lib/admin-paths.ts。
export { AdminIndex } from './admin-index.tsx'
export { AdminLayout } from './admin-layout.tsx'
export { AdminAuditPage } from './audit-page.tsx'
export { AdminInvitationsPage } from './invitations-page.tsx'
export { AdminUsersPage } from './users-page.tsx'

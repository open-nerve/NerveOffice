import type { RouteObject } from 'react-router'
import { ONE_TIME_LINK_PAGE_PATHS } from '@nerve-office/contracts'
import { CHANGE_PASSWORD_PATH, ChangePasswordPage, InvitationPage, PasswordResetPage } from '../features/account/index.ts'
import { LoginPage, RequireSession } from '../features/auth/index.ts'
import { DocumentListPage } from '../features/documents/index.ts'
import { ADMIN_PATH, ADMIN_PATHS } from '../shared/lib/admin-paths.ts'
import { LOGIN_PATH } from '../shared/lib/login-path.ts'
import { AppShell } from './layout/app-shell.tsx'
import { ErrorPage } from './pages/error-page.tsx'
import { NotFoundPage } from './pages/not-found-page.tsx'

/** 管理界面按需加载（M2-P1 设计 §3.8）：它只给系统管理员，不进平台页面的首屏包。这里是它唯一的引用处，而且只能是动态 import */
async function adminPages() {
  return import('../features/admin/index.ts')
}

/** 平台页面的路由（P3 设计 §3.7）。编辑器页在 P4 另起入口，整页加载。 */
export const appRoutes: RouteObject[] = [
  { path: LOGIN_PATH, Component: LoginPage, ErrorBoundary: ErrorPage },
  // 一次性链接的公开页面（M2-P1）：不需要登录；令牌在链接的 # 之后
  { path: ONE_TIME_LINK_PAGE_PATHS.invitation, Component: InvitationPage, ErrorBoundary: ErrorPage },
  { path: ONE_TIME_LINK_PAGE_PATHS.password_reset, Component: PasswordResetPage, ErrorBoundary: ErrorPage },
  {
    // 除登录页以外都要先登录（默认拒绝，US-M1-08）：包括不存在的地址，未登录的人看不出哪些地址存在（审查 B23）。P4 的文档路由也放在这一层
    Component: RequireSession,
    ErrorBoundary: ErrorPage,
    children: [
      {
        Component: AppShell,
        children: [
          { index: true, Component: DocumentListPage },
          { path: CHANGE_PASSWORD_PATH, Component: ChangePasswordPage },
          {
            path: ADMIN_PATH,
            lazy: async () => ({ Component: (await adminPages()).AdminLayout }),
            children: [
              { index: true, lazy: async () => ({ Component: (await adminPages()).AdminIndex }) },
              { path: ADMIN_PATHS.users, lazy: async () => ({ Component: (await adminPages()).AdminUsersPage }) },
              { path: ADMIN_PATHS.invitations, lazy: async () => ({ Component: (await adminPages()).AdminInvitationsPage }) },
              { path: ADMIN_PATHS.audit, lazy: async () => ({ Component: (await adminPages()).AdminAuditPage }) },
            ],
          },
          { path: '*', Component: NotFoundPage },
        ],
      },
    ],
  },
]

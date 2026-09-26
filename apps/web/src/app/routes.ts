import type { RouteObject } from 'react-router'
import { LOGIN_PATH, LoginPage, RequireSession } from '../features/auth/index.ts'
import { DocumentListPage } from '../features/documents/index.ts'
import { AppShell } from './layout/app-shell.tsx'
import { ErrorPage } from './pages/error-page.tsx'
import { NotFoundPage } from './pages/not-found-page.tsx'

/** 平台页面的路由（P3 设计 §3.7）。编辑器页在 P4 另起入口，整页加载。 */
export const appRoutes: RouteObject[] = [
  { path: LOGIN_PATH, Component: LoginPage, ErrorBoundary: ErrorPage },
  {
    // 除登录页以外都要先登录（默认拒绝，US-M1-08）：包括不存在的地址，未登录的人看不出哪些地址存在（审查 B23）。P4 的文档路由也放在这一层
    Component: RequireSession,
    ErrorBoundary: ErrorPage,
    children: [
      {
        Component: AppShell,
        children: [
          { index: true, Component: DocumentListPage },
          { path: '*', Component: NotFoundPage },
        ],
      },
    ],
  },
]

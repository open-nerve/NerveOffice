import type { RouteObject } from 'react-router'
import { LoginPage, RequireSession } from '../features/auth/index.ts'
import { DocumentListPage } from '../features/documents/index.ts'
import { AppShell } from './layout/app-shell.tsx'
import { ErrorPage } from './pages/error-page.tsx'
import { NotFoundPage } from './pages/not-found-page.tsx'

/** 平台页面的路由（P3 设计 §3.7）。编辑器页在 P4 另起入口，整页加载。 */
export const appRoutes: RouteObject[] = [
  { path: '/login', Component: LoginPage, ErrorBoundary: ErrorPage },
  {
    Component: RequireSession,
    ErrorBoundary: ErrorPage,
    children: [
      {
        Component: AppShell,
        children: [{ index: true, Component: DocumentListPage }],
      },
    ],
  },
  { path: '*', Component: NotFoundPage },
]

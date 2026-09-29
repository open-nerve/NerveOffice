import type { RouteObject } from 'react-router'
import { ONE_TIME_LINK_PAGE_PATHS } from '@nerve-office/contracts'
import { CHANGE_PASSWORD_PATH, ChangePasswordPage, InvitationPage, PasswordResetPage } from '../features/account/index.ts'
import { LoginPage, RequireSession, SessionCheck } from '../features/auth/index.ts'
import { HomePage, SpacePage } from '../features/spaces/index.ts'
import { ADMIN_PATH, ADMIN_PATHS, ADMIN_USER_DOCUMENTS_ROUTE } from '../shared/lib/admin-paths.ts'
import { LOGIN_PATH } from '../shared/lib/login-path.ts'
import { SEARCH_PATH, SPACE_FOLDER_ROUTE, SPACE_MEMBERS_ROUTE, SPACE_ROUTE, SPACE_TRASH_ROUTE } from '../shared/lib/space-paths.ts'
import { AppShell } from './layout/app-shell.tsx'
import { ErrorPage } from './pages/error-page.tsx'
import { NotFoundPage } from './pages/not-found-page.tsx'

/** 管理界面按需加载（M2-P1 设计 §3.8）：它只给系统管理员，不进平台页面的首屏包。这里是它唯一的引用处，而且只能是动态 import（lint 的模块边界保证） */
async function adminPages() {
  return import('../features/admin/index.ts')
}

/** 成员页按需加载（M2-P2 设计 §3.10）：只有管理与查看成员时才用，带着弹窗，不进首屏包。同样只能在这里动态 import */
async function membersPages() {
  return import('../features/members/index.ts')
}

/** 回收站页按需加载（M2-P4 设计 §3.7）：只有要找回删掉的东西时才用，带着确认的弹窗，不进首屏包 */
async function trashPages() {
  return import('../features/trash/index.ts')
}

/** 搜索结果页按需加载（M2-P4 设计 §3.7）：页头的搜索框只带着关键词跳过来，结果的渲染不进首屏包 */
async function searchPages() {
  return import('../features/search/index.ts')
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
    // 直接打开按需加载的页面（例如 /admin/users）时，路由要先下载它的代码才开始渲染：这期间显示确认登录的骨架屏，不是整页空白（M2-P1 审查 B5）
    HydrateFallback: SessionCheck,
    children: [
      {
        Component: AppShell,
        children: [
          { index: true, Component: HomePage },
          { path: SPACE_ROUTE, Component: SpacePage },
          // 空间里的某个文件夹：地址带着从空间根目录到它的整条 id 路径（shared/lib/space-paths.ts 里写了为什么）
          { path: SPACE_FOLDER_ROUTE, Component: SpacePage },
          { path: SPACE_MEMBERS_ROUTE, lazy: async () => ({ Component: (await membersPages()).MembersPage }) },
          { path: SPACE_TRASH_ROUTE, lazy: async () => ({ Component: (await trashPages()).TrashPage }) },
          { path: SEARCH_PATH, lazy: async () => ({ Component: (await searchPages()).SearchPage }) },
          { path: CHANGE_PASSWORD_PATH, Component: ChangePasswordPage },
          {
            path: ADMIN_PATH,
            lazy: async () => ({ Component: (await adminPages()).AdminLayout }),
            children: [
              { index: true, lazy: async () => ({ Component: (await adminPages()).AdminIndex }) },
              { path: ADMIN_PATHS.users, lazy: async () => ({ Component: (await adminPages()).AdminUsersPage }) },
              { path: ADMIN_PATHS.invitations, lazy: async () => ({ Component: (await adminPages()).AdminInvitationsPage }) },
              { path: ADMIN_PATHS.spaces, lazy: async () => ({ Component: (await adminPages()).AdminSpacesPage }) },
              { path: ADMIN_USER_DOCUMENTS_ROUTE, lazy: async () => ({ Component: (await adminPages()).AdminTransferPage }) },
              { path: ADMIN_PATHS.audit, lazy: async () => ({ Component: (await adminPages()).AdminAuditPage }) },
            ],
          },
          { path: '*', Component: NotFoundPage },
        ],
      },
    ],
  },
]

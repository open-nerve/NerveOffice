import { useQuery } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { cn } from '../../shared/lib/cn.ts'
import { Alert, AlertDescription, buttonVariants } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'

const TABS = [
  { to: ADMIN_PATHS.users, label: messages.admin.nav.users },
  { to: ADMIN_PATHS.invitations, label: messages.admin.nav.invitations },
  { to: ADMIN_PATHS.audit, label: messages.admin.nav.audit },
] as const

/**
 * 管理界面的外框（M2-P1 设计 §3.8）：只给系统管理员。其他人打开时说明没有权限（A14 的无权限状态），不显示任何管理数据；
 * 服务端对每个管理接口另外检查。会话由外层的 RequireSession 加载好了。
 */
export function AdminLayout() {
  const session = useQuery(sessionQueryOptions())
  if (session.data?.user.systemRole !== 'admin') {
    return (
      <Alert variant="destructive">
        <AlertDescription>{messages.admin.noPermission}</AlertDescription>
      </Alert>
    )
  }
  return (
    <section className="flex flex-col gap-4" aria-labelledby="admin-title">
      <h1 id="admin-title" className="text-xl font-semibold">{messages.admin.title}</h1>
      <nav aria-label={messages.admin.navLabel} className="flex gap-1 border-b pb-2">
        {TABS.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => cn(buttonVariants({ variant: isActive ? 'secondary' : 'ghost', size: 'sm' }))}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </section>
  )
}

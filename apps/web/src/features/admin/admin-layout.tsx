import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { NavLink, Outlet } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'
import { cn } from '../../shared/lib/cn.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Alert, AlertDescription, buttonVariants } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'

const TABS = [
  { to: ADMIN_PATHS.users, label: messages.admin.nav.users },
  { to: ADMIN_PATHS.invitations, label: messages.admin.nav.invitations },
  { to: ADMIN_PATHS.spaces, label: messages.admin.nav.spaces },
  { to: ADMIN_PATHS.audit, label: messages.admin.nav.audit },
] as const

/**
 * 没有权限的说明。取消了自己的系统管理员（或者被别人取消）之后，管理页连同确认的弹窗一起卸载，焦点落到 body：
 * 交给这条说明（A14，复验 N5）。焦点在别处（例如页头）时不抢。
 * 这样的页面同样有自己的标题（h1，M2-P6 复核 G5）与浏览器标签页的标题（S4）
 */
function NoPermission() {
  const ref = useRef<HTMLDivElement>(null)
  useDocumentTitle(messages.admin.title)
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body)
      ref.current?.focus()
  }, [])
  return (
    <section className="flex flex-col gap-4" aria-labelledby="admin-title">
      <h1 id="admin-title" className="text-xl font-semibold">{messages.admin.title}</h1>
      <Alert ref={ref} tabIndex={-1} variant="destructive">
        <AlertDescription>{messages.admin.noPermission}</AlertDescription>
      </Alert>
    </section>
  )
}

/**
 * 管理界面的外框（M2-P1 设计 §3.8）：只给系统管理员。其他人打开时说明没有权限（A14 的无权限状态），不显示任何管理数据；
 * 服务端对每个管理接口另外检查。会话由外层的 RequireSession 加载好了。
 */
export function AdminLayout() {
  const session = useQuery(sessionQueryOptions())
  if (session.data?.user.systemRole !== 'admin')
    return <NoPermission />
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

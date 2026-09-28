import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from 'react-router'
import { CHANGE_PASSWORD_PATH } from '../../features/account/index.ts'
import { sessionQueryOptions, UserMenu } from '../../features/auth/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATH } from '../../shared/lib/admin-paths.ts'
import { buttonVariants } from '../../shared/ui/index.ts'

/** 登录后的页面框架：页头（产品名称、系统管理员的"管理"入口、当前用户、修改密码与退出）与内容区。 */
export function AppShell() {
  const session = useQuery(sessionQueryOptions())
  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="font-semibold">{messages.app.name}</Link>
            {/* 只是入口的显示；管理接口由服务端逐请求检查系统角色 */}
            {session.data?.user.systemRole === 'admin' && (
              <Link to={ADMIN_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.admin.title}</Link>
            )}
          </div>
          <UserMenu>
            <Link to={CHANGE_PASSWORD_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.account.changePassword}</Link>
          </UserMenu>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}

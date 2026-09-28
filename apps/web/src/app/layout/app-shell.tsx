import { Link, Outlet } from 'react-router'
import { CHANGE_PASSWORD_PATH } from '../../features/account/index.ts'
import { UserMenu } from '../../features/auth/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { buttonVariants } from '../../shared/ui/index.ts'

/** 登录后的页面框架：页头（产品名称、当前用户、修改密码与退出）与内容区。 */
export function AppShell() {
  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link to="/" className="font-semibold">{messages.app.name}</Link>
          <UserMenu>
            <Link to={CHANGE_PASSWORD_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.account.changePassword}</Link>
          </UserMenu>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}

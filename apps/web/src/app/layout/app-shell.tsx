import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigation } from 'react-router'
import { CHANGE_PASSWORD_PATH } from '../../features/account/index.ts'
import { sessionQueryOptions, UserMenu } from '../../features/auth/index.ts'
import { SpaceNav } from '../../features/spaces/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATH } from '../../shared/lib/admin-paths.ts'
import { buttonVariants } from '../../shared/ui/index.ts'
import { SearchBox } from './search-box.tsx'

/**
 * 登录后的页面框架：页头（产品名称、系统管理员的"管理"入口、搜索框、当前用户、修改密码与退出）、左侧导航（空间，M2-P2）与内容区。
 * 窄屏时只有当前用户的名字收窄（省略号），页头不换行、不溢出（M2-P1 审查 B11）；导航收到内容上方，由按钮展开。
 */
export function AppShell() {
  const session = useQuery(sessionQueryOptions())
  // 单页里切到按需加载的页面（例如第一次点"管理"）时，先要下载它的代码：页头显示进行中（M2-P1 审查 B5）
  const navigating = useNavigation().state !== 'idle'
  return (
    <div className="min-h-svh">
      <header className="relative border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <div className="flex shrink-0 items-center gap-3">
            <Link to="/" className="font-semibold">{messages.app.name}</Link>
            {/* 只是入口的显示；管理接口由服务端逐请求检查系统角色 */}
            {session.data?.user.systemRole === 'admin' && (
              <Link to={ADMIN_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.admin.title}</Link>
            )}
          </div>
          {/* 搜索框（M2-P4）：只带着关键词跳到按需加载的结果页，首屏里只有这个框 */}
          <SearchBox />
          <UserMenu>
            <Link to={CHANGE_PASSWORD_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.account.changePassword}</Link>
          </UserMenu>
        </div>
        {navigating && <div role="progressbar" aria-label={messages.app.navigating} className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary" />}
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 md:flex-row md:gap-6">
        <SpaceNav />
        <main className="min-w-0 flex-1" aria-busy={navigating}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

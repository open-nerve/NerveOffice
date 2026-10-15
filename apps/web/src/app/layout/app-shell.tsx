import type { PageStartRef } from '../../features/auth/index.ts'
import { useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { Link, Outlet, useNavigation, useOutletContext } from 'react-router'
import { CHANGE_PASSWORD_PATH } from '../../features/account/index.ts'
import { sessionQueryOptions, UserMenu } from '../../features/auth/index.ts'
import { SpaceNav } from '../../features/spaces/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATH } from '../../shared/lib/admin-paths.ts'
import { buttonVariants } from '../../shared/ui/index.ts'
import { SearchBox } from './search-box.tsx'

/**
 * 登录后的页面框架：页头（品牌、管理、搜索、当前用户、修改密码、本机草稿与退出）、空间导航与内容区。
 * 页头不溢出（M2-P1 审查 B11、M4-P4）：md 以下账户组独占一行；sm 以下两个账户入口只留图标，搜索另占最后一行。
 * md 起所有项同排，名字按剩余空间收窄；不能以把登录名挤成“@…”为代价放下新增入口。导航在窄屏收到内容上方，由按钮展开。
 */
export function AppShell() {
  const session = useQuery(sessionQueryOptions())
  // 页面开头（产品名称）：需要登录的外层路由经 Outlet 交来，会话确认失败、按"重试"确认之后焦点交给它（features/auth 的 RequireSession）
  const pageStartRef = useOutletContext<PageStartRef | undefined>()
  // 单页里切到按需加载的页面（例如第一次点"管理"）时，先要下载它的代码：页头显示进行中（M2-P1 审查 B5）
  const navigating = useNavigation().state !== 'idle'
  return (
    <div className="min-h-svh">
      <header className="relative border-b">
        {/*
          justify-between：搜索框落在页头中间的空当里，当前用户那一组贴着右边（M2-P4 审查 B3）。
          md 以下账户组独占一行；sm 以下搜索排到最后一行（search-box.tsx）
        */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5 md:h-14 md:flex-nowrap md:py-0">
          <div className="flex shrink-0 items-center gap-3">
            <Link ref={pageStartRef} to="/" className="font-semibold">{messages.app.name}</Link>
            {/* 只是入口的显示；管理接口由服务端逐请求检查系统角色 */}
            {session.data?.user.systemRole === 'admin' && (
              <Link to={ADMIN_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.app.admin}</Link>
            )}
          </div>
          {/* 搜索框（M2-P4）：只带着关键词跳到按需加载的结果页，首屏里只有这个框 */}
          <SearchBox />
          {/* 窄屏时账户入口单独一行，名字可收窄，所有入口与退出按钮均可到达。 */}
          <UserMenu className="max-md:flex-1 max-md:basis-full max-md:justify-end">
            <Link to={CHANGE_PASSWORD_PATH} title={messages.account.changePassword} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              <KeyRound aria-hidden="true" className="sm:hidden" />
              <span className="max-sm:sr-only">{messages.account.changePassword}</span>
            </Link>
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

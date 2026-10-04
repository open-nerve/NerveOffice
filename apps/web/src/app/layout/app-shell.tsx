import { useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { Link, Outlet, useNavigation } from 'react-router'
import { CHANGE_PASSWORD_PATH } from '../../features/account/index.ts'
import { sessionQueryOptions, usePageStartRef, UserMenu } from '../../features/auth/index.ts'
import { SpaceNav } from '../../features/spaces/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { ADMIN_PATH } from '../../shared/lib/admin-paths.ts'
import { buttonVariants } from '../../shared/ui/index.ts'
import { SearchBox } from './search-box.tsx'

/**
 * 登录后的页面框架：页头（产品名称、系统管理员的"管理"入口、搜索框、当前用户、修改密码与退出）、左侧导航（空间，M2-P2）与内容区。
 * 页头不溢出（M2-P1 审查 B11）：宽度不够时当前用户的名字收窄（省略号）；窄屏（sm 以下）时一行放不下，搜索框折到第二行、占满整行，
 * "修改密码"只留图标（可读名称不变），320px 宽时系统管理员的页头也放得下（M2-P6 复核第三批 G-e）；余下的宽度连登录名的头几个字
 * 都放不下时，名字只给读屏（features/auth 的 UserMenu，第五批 G7）。导航收到内容上方，由按钮展开。
 */
export function AppShell() {
  const session = useQuery(sessionQueryOptions())
  // 页面开头（产品名称）：会话确认失败、按"重试"确认之后焦点交给它（features/auth 的 RequireSession）
  const pageStartRef = usePageStartRef()
  // 单页里切到按需加载的页面（例如第一次点"管理"）时，先要下载它的代码：页头显示进行中（M2-P1 审查 B5）
  const navigating = useNavigation().state !== 'idle'
  return (
    <div className="min-h-svh">
      <header className="relative border-b">
        {/*
          justify-between：搜索框落在页头中间的空当里，当前用户那一组贴着右边（M2-P4 审查 B3）。
          窄屏时可以折行：搜索框排到第二行（search-box.tsx），第一行是产品名称一组与当前用户那一组
        */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5 sm:h-14 sm:flex-nowrap sm:py-0">
          <div className="flex shrink-0 items-center gap-3">
            <Link ref={pageStartRef} to="/" className="font-semibold">{messages.app.name}</Link>
            {/* 只是入口的显示；管理接口由服务端逐请求检查系统角色 */}
            {session.data?.user.systemRole === 'admin' && (
              <Link to={ADMIN_PATH} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{messages.app.admin}</Link>
            )}
          </div>
          {/* 搜索框（M2-P4）：只带着关键词跳到按需加载的结果页，首屏里只有这个框 */}
          <SearchBox />
          {/* 窄屏时占满第一行余下的宽度（基准为 0，不会被挤到下一行），名字在里面收窄，各项贴着右边 */}
          <UserMenu className="max-sm:flex-1 max-sm:justify-end">
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

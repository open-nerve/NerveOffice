import type { RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, matchPath, NavLink, useLocation } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { cn } from '../../shared/lib/cn.ts'
import { HOME_PATH, SHARED_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { Badge, Button, buttonVariants, RetryButton, Skeleton } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { sessionQueryOptions } from '../auth/index.ts'
import { spacesQueryOptions } from './spaces-api.ts'

const text = messages.spaces

function linkClass({ isActive }: { readonly isActive: boolean }): string {
  return cn(buttonVariants({ variant: isActive ? 'secondary' : 'ghost', size: 'sm' }), 'w-full justify-start gap-2')
}

/**
 * 团队空间的条目：加载中、失败（可以重试）、还没有团队空间、有团队空间。onNavigate：点了链接（窄屏时收起导航）。
 * 列表以"团队空间"这个标题为名：加载完之后才有它（或者"还没有加入团队空间"），E2E 据此确认导航已经加载完（审查 B6）。
 * 写操作之后（改名、加入、归档……）会重新请求它：留着之前的列表、刷新却失败了时明说、给出重试（Codex 对抗评审 CX5）；
 * 重试成功、说明连同"重试"一起消失时焦点交给一直在的"团队空间"标题（heading），不落到 body（规范 §2.4）。
 * 第一次就没取到时按"重试"同样如此：重试期间说明与按钮留着（不可用、说正在重试），取到之后焦点交给标题（use-first-load-retry.ts）
 */
function TeamSpaces({ headingId, heading, onNavigate }: { readonly headingId: string, readonly heading: RefObject<HTMLHeadingElement | null>, readonly onNavigate: () => void }) {
  const spaces = useQuery(spacesQueryOptions())
  const firstLoad = useFirstLoadRetry(spaces, heading)
  if (firstLoad.failed) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-2 text-sm text-destructive" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
        <span>{text.loadFailed}</span>
        <RetryButton retrying={firstLoad.retrying} onRetry={() => void spaces.refetch()} />
      </div>
    )
  }
  if (spaces.data === undefined) {
    // 名称与空间页的骨架屏不同：读屏软件与测试都能分清是哪一处在加载（审查 B10）
    return (
      <div role="status" aria-label={text.navLoading} className="flex flex-col gap-2 px-2">
        {['first', 'second'].map(row => <Skeleton key={row} className="h-6 w-full" />)}
      </div>
    )
  }
  const teams = spaces.data.items.filter(space => space.type === 'team')
  return (
    <>
      <RefreshProblem query={spaces} list={text.listName} fallbackFocus={heading} />
      {teams.length === 0
        ? <p className="px-2 text-sm text-muted-foreground">{text.noTeamSpaces}</p>
        : (
            <ul aria-labelledby={headingId} className="flex flex-col gap-1">
              {teams.map(space => (
                <li key={space.id}>
                  {/* 已归档的给出明确的可读名称：名称与标记之间要不要空格，各浏览器算法不同 */}
                  <NavLink to={spacePath(space.id)} className={linkClass} onClick={onNavigate} aria-label={space.status === 'archived' ? text.archivedName(space.name) : undefined}>
                    <span className="truncate">{space.name}</span>
                    {space.status === 'archived' && <Badge variant="outline">{text.archived}</Badge>}
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
    </>
  )
}

/**
 * "我的空间"是不是当前项（M2-P6 复核 G6）：首页，以及用 /spaces/{本人的个人空间} 打开的任何一页（文件夹、回收站）。
 * 它的链接指向首页，NavLink 自己只认得首页这一个地址
 */
function usePersonalSpaceCurrent(): boolean {
  const { pathname } = useLocation()
  const session = useQuery(sessionQueryOptions())
  const personalId = session.data?.personalSpace.id
  if (matchPath({ path: HOME_PATH, end: true }, pathname) !== null)
    return true
  return personalId !== undefined && matchPath({ path: spacePath(personalId), end: false }, pathname) !== null
}

/**
 * 左侧导航（M2-P2 设计 §3.10）：我的空间、与我共享（M2-P5：别人单独分享给我的文档，页面按需加载）、
 * 团队空间（我是成员的与全员可见的，已归档的带标记）。
 * 窄屏时收起，由上方的按钮展开（不用弹窗，不进首屏的 Radix Dialog）；点了导航里的链接就收起。
 */
export function SpaceNav() {
  const [open, setOpen] = useState(false)
  const navId = useId()
  const teamHeadingId = useId()
  /** "团队空间"这个标题一直在（tabIndex -1，只能由程序聚焦）：团队空间的列表"没能刷新"、重试成功之后焦点交给它 */
  const teamHeadingRef = useRef<HTMLHeadingElement>(null)
  const personalCurrent = usePersonalSpaceCurrent()
  const close = (): void => setOpen(false)

  return (
    <div className="md:w-56 md:shrink-0">
      <Button variant="outline" size="sm" className="md:hidden" aria-expanded={open} aria-controls={navId} onClick={() => setOpen(!open)}>
        {text.toggleNav}
      </Button>
      <nav id={navId} aria-label={text.navLabel} className={cn(open ? 'flex' : 'hidden', 'mt-2 flex-col gap-1 md:mt-0 md:flex')}>
        <Link to={HOME_PATH} aria-current={personalCurrent ? 'page' : undefined} className={linkClass({ isActive: personalCurrent })} onClick={close}>{text.personal}</Link>
        <NavLink to={SHARED_PATH} className={linkClass} onClick={close}>{text.sharedWithMe}</NavLink>
        <h2 ref={teamHeadingRef} id={teamHeadingId} tabIndex={-1} className="px-2 pt-3 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.teamHeading}</h2>
        <TeamSpaces headingId={teamHeadingId} heading={teamHeadingRef} onNavigate={close} />
      </nav>
    </div>
  )
}

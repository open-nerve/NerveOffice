import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { NavLink } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { cn } from '../../shared/lib/cn.ts'
import { HOME_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { Badge, Button, buttonVariants, Skeleton } from '../../shared/ui/index.ts'
import { spacesQueryOptions } from './spaces-api.ts'

const text = messages.spaces

function linkClass({ isActive }: { readonly isActive: boolean }): string {
  return cn(buttonVariants({ variant: isActive ? 'secondary' : 'ghost', size: 'sm' }), 'w-full justify-start gap-2')
}

/**
 * 团队空间的条目：加载中、失败（可以重试）、还没有团队空间、有团队空间。onNavigate：点了链接（窄屏时收起导航）。
 * 列表以"团队空间"这个标题为名：加载完之后才有它（或者"还没有加入团队空间"），E2E 据此确认导航已经加载完（审查 B6）
 */
function TeamSpaces({ headingId, onNavigate }: { readonly headingId: string, readonly onNavigate: () => void }) {
  const spaces = useQuery(spacesQueryOptions())
  if (spaces.isPending) {
    // 名称与空间页的骨架屏不同：读屏软件与测试都能分清是哪一处在加载（审查 B10）
    return (
      <div role="status" aria-label={text.navLoading} className="flex flex-col gap-2 px-2">
        {['first', 'second'].map(row => <Skeleton key={row} className="h-6 w-full" />)}
      </div>
    )
  }
  if (spaces.data === undefined) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-2 text-sm text-destructive">
        <span>{text.loadFailed}</span>
        <Button variant="outline" size="sm" onClick={() => void spaces.refetch()}>{messages.common.retry}</Button>
      </div>
    )
  }
  const teams = spaces.data.items.filter(space => space.type === 'team')
  if (teams.length === 0)
    return <p className="px-2 text-sm text-muted-foreground">{text.noTeamSpaces}</p>
  return (
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
  )
}

/**
 * 左侧导航（M2-P2 设计 §3.10）：我的空间、团队空间（我是成员的与全员可见的，已归档的带标记）。P5 加"与我共享"。
 * 窄屏时收起，由上方的按钮展开（不用弹窗，不进首屏的 Radix Dialog）；点了导航里的链接就收起。
 */
export function SpaceNav() {
  const [open, setOpen] = useState(false)
  const navId = useId()
  const teamHeadingId = useId()
  const close = (): void => setOpen(false)

  return (
    <div className="md:w-56 md:shrink-0">
      <Button variant="outline" size="sm" className="md:hidden" aria-expanded={open} aria-controls={navId} onClick={() => setOpen(!open)}>
        {text.toggleNav}
      </Button>
      <nav id={navId} aria-label={text.navLabel} className={cn(open ? 'flex' : 'hidden', 'mt-2 flex-col gap-1 md:mt-0 md:flex')}>
        <NavLink to={HOME_PATH} end className={linkClass} onClick={close}>{text.personal}</NavLink>
        <h2 id={teamHeadingId} className="px-2 pt-3 text-xs font-medium text-muted-foreground">{text.teamHeading}</h2>
        <TeamSpaces headingId={teamHeadingId} onNavigate={close} />
      </nav>
    </div>
  )
}

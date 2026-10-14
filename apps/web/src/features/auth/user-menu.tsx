import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileClock } from 'lucide-react'
import { useState } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { cn } from '../../shared/lib/cn.ts'
import { LOCAL_DRAFTS_PATH } from '../../shared/lib/local-drafts-path.ts'
import { LOGOUT_PATH } from '../../shared/lib/logout-path.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { Button, buttonVariants, PersonName } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from './session.ts'

/** 页头退出只打开独立预览；明确确认之后才由固定来源协调器清理与退出。 */
export function UserMenu({ children, className }: { readonly children?: ReactNode, readonly className?: string }) {
  const session = useQuery(sessionQueryOptions())
  const page = usePageLocation()
  const [leaving, setLeaving] = useState(false)
  function signOut(): void {
    if (leaving)
      return
    setLeaving(true)
    page.assign(LOGOUT_PATH)
  }
  return (
    // 窄屏时只有名字收窄成省略号，完整的名字在 title 里（M2-P1 审查 B11）；按钮与入口不收窄
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      {/*
        显示名与登录名分开呈现（M2-P6 复核 M2），完整的名字在 title 里（显示名隔离）。
        窄屏时名字这一栏占满余下的宽度，作为容器查询的容器：余下的宽度连登录名的头几个字都放不下（不到 3rem，只剩"@…"：
        系统管理员的页头多一个"管理"，320px 宽时就是这样，第五批 G7），名字只给读屏（sr-only），可读的文字与 title 仍是全名。
        按余下的宽度而不是视口判断：成员的页头在 320px 宽时还放得下"@登录名的头几个字…"，不必藏起来
      */}
      {session.data !== undefined && (
        <span className="flex min-w-0 max-sm:flex-1 max-sm:justify-end max-sm:@container">
          <PersonName person={session.data.user} className="min-w-0 truncate text-sm text-muted-foreground @max-[3rem]:sr-only" title={messages.people.text(session.data.user)} />
        </span>
      )}
      {children}
      <a href={LOCAL_DRAFTS_PATH} title={messages.auth.localDrafts} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        <FileClock aria-hidden="true" className="sm:hidden" />
        <span className="max-sm:sr-only">{messages.auth.localDrafts}</span>
      </a>
      {/* 进行中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（审查 B13）；重复点击由 leaving 挡住 */}
      <Button variant="outline" size="sm" aria-disabled={leaving} onClick={signOut}>
        {messages.auth.logout}
      </Button>
    </div>
  )
}

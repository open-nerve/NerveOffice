import type { ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { describeError, isAuthenticationError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useAdoptRenewedSession } from '../../shared/lib/renewed-session.ts'
import { Button, PersonName } from '../../shared/ui/index.ts'
import { ENDS_SESSION, logout, sessionQueryOptions } from './session.ts'

/**
 * 页头右侧：当前用户、页头传进来的入口（children，例如修改密码）与退出（US-M1-02）。
 * 退出成功（或者会话本来就不在了）由请求缓存的全局处理通知其他标签页、整页回到登录页（app/runtime.ts）：
 * 上一个会话的数据随页面丢弃，按后退键回到之前的地址时要重新请求，得到 401 后又回到登录页，看不到内容。这里只显示进行中与失败。
 * 退出得到"登录已过期"时先确认一次、可能再退出一次（logout，M2-P6 复验 一般-4），这期间按钮一直是"正在退出"。
 */
export function UserMenu({ children }: { readonly children?: ReactNode }) {
  const session = useQuery(sessionQueryOptions())
  const adoptRenewedSession = useAdoptRenewedSession()
  const mutation = useMutation({ mutationFn: async () => logout(adoptRenewedSession), meta: ENDS_SESSION })
  // 成功之后页面正在离开，按钮保持"正在退出"
  const leaving = mutation.isPending || mutation.isSuccess || (mutation.isError && isAuthenticationError(mutation.error))
  // 失败的原因按错误码说明：网络失败可以重试；页面已失效（别的标签页换了人）要刷新（审查 B6）
  const failure = mutation.isError && !leaving ? describeError(mutation.error).message : undefined
  function signOut(): void {
    if (!leaving)
      mutation.mutate()
  }
  return (
    // 窄屏时只有名字收窄成省略号，完整的名字在 title 里（M2-P1 审查 B11）；按钮与入口不收窄
    <div className="flex min-w-0 items-center gap-3">
      {/* 显示名与登录名分开呈现（M2-P6 复核 M2），完整的名字在 title 里（显示名隔离） */}
      {session.data !== undefined && <PersonName person={session.data.user} className="min-w-0 truncate text-sm text-muted-foreground" title={messages.people.text(session.data.user)} />}
      {children}
      {/* 退出失败的说明同样可以收窄（读屏照常读出全文），窄屏时不把页头撑破 */}
      {failure !== undefined && <span role="alert" className="min-w-0 truncate text-sm text-destructive" title={messages.auth.logoutFailed(failure)}>{messages.auth.logoutFailed(failure)}</span>}
      {/* 进行中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（审查 B13）；重复点击由 leaving 挡住 */}
      <Button variant="outline" size="sm" aria-disabled={leaving} onClick={signOut}>
        {leaving ? messages.auth.loggingOut : messages.auth.logout}
      </Button>
    </div>
  )
}

import { useMutation, useQuery } from '@tanstack/react-query'
import { describeError, isAuthenticationError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Button } from '../../shared/ui/index.ts'
import { ENDS_SESSION, logout, sessionQueryOptions } from './session.ts'

/**
 * 页头右侧：当前用户与退出（US-M1-02）。
 * 退出成功（或者会话本来就不在了）由请求缓存的全局处理通知其他标签页、整页回到登录页（app/runtime.ts）：
 * 上一个会话的数据随页面丢弃，按后退键回到之前的地址时要重新请求，得到 401 后又回到登录页，看不到内容。这里只显示进行中与失败。
 */
export function UserMenu() {
  const session = useQuery(sessionQueryOptions())
  const mutation = useMutation({ mutationFn: logout, meta: ENDS_SESSION })
  // 成功之后页面正在离开，按钮保持"正在退出"
  const leaving = mutation.isPending || mutation.isSuccess || (mutation.isError && isAuthenticationError(mutation.error))
  // 失败的原因按错误码说明：网络失败可以重试；页面已失效（别的标签页换了人）要刷新（审查 B6）
  const failure = mutation.isError && !leaving ? describeError(mutation.error).message : undefined
  function signOut(): void {
    if (!leaving)
      mutation.mutate()
  }
  return (
    <div className="flex items-center gap-3">
      {session.data !== undefined && <span className="text-sm text-muted-foreground">{session.data.user.displayName}</span>}
      {failure !== undefined && <span role="alert" className="text-sm text-destructive">{messages.auth.logoutFailed(failure)}</span>}
      {/* 进行中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（审查 B13）；重复点击由 leaving 挡住 */}
      <Button variant="outline" size="sm" aria-disabled={leaving} onClick={signOut}>
        {leaving ? messages.auth.loggingOut : messages.auth.logout}
      </Button>
    </div>
  )
}

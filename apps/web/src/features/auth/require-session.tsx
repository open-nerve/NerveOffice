import type { PageStartRef } from './page-start.ts'
import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { describeError, isAuthenticationError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { Alert, AlertDescription, RetryButton } from '../../shared/ui/index.ts'
import { SessionCheck } from './session-check.tsx'
import { sessionQueryOptions } from './session.ts'

/** 没有登录、登录已过期：转到登录页，不是"没能确认"，重试也不会好 */
function notRetryable(error: unknown): boolean {
  return !isAuthenticationError(error)
}

/**
 * 需要登录的页面的外层路由（默认拒绝，US-M1-08）：会话还在加载时显示骨架屏；
 * 没有登录或登录已过期时转到登录页，登录后回到原来的地址；其他错误（网络、服务不可用）整页说明、可以重试。
 * 重试期间说明与"重试"留着（不可用、说正在重试，shared/lib/use-first-load-retry.ts）：骨架屏换掉它们的话，刚按过的按钮随之卸载、
 * 焦点落到 body；确认之后焦点交给页面开头（经 Outlet 交给页面框架，page-start.ts 的 usePageStartRef）。
 */
export function RequireSession() {
  const location = useLocation()
  const session = useQuery(sessionQueryOptions())
  const pageStartRef: PageStartRef = useRef<HTMLAnchorElement>(null)
  // 确认失败时整页说明、不显示页面：缓存里留着之前的会话也一样（hidesDataOnError）
  const firstLoad = useFirstLoadRetry(session, pageStartRef, { retryable: notRetryable, hidesDataOnError: true })
  if (session.isError && isAuthenticationError(session.error)) {
    const from = `${location.pathname}${location.search}`
    return <Navigate to={loginPath(from, session.error.code === 'SESSION_EXPIRED' ? 'expired' : 'required')} replace />
  }
  if (firstLoad.failed) {
    // 重试期间上一次的原因不再给（请求缓存已经清掉了它）
    return (
      <main className="mx-auto flex max-w-md flex-col gap-3 p-6" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
        <Alert variant="destructive">
          <AlertDescription>
            <p>{messages.auth.sessionCheckFailed}</p>
            {!firstLoad.retrying && <p>{describeError(session.error).message}</p>}
          </AlertDescription>
        </Alert>
        <RetryButton size="default" retrying={firstLoad.retrying} onRetry={() => void session.refetch()} />
      </main>
    )
  }
  if (session.isPending)
    return <SessionCheck />
  return <Outlet context={pageStartRef} />
}

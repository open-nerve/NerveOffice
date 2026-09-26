import { useQuery } from '@tanstack/react-query'
import { Navigate, Outlet, useLocation } from 'react-router'
import { describeError, isAuthenticationError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'
import { loginPath } from './login-path.ts'
import { SessionCheck } from './session-check.tsx'
import { sessionQueryOptions } from './session.ts'

/**
 * 需要登录的页面的外层路由（默认拒绝，US-M1-08）：会话还在加载时显示骨架屏；
 * 没有登录或登录已过期时转到登录页，登录后回到原来的地址；其他错误（网络、服务不可用）可以重试。
 */
export function RequireSession() {
  const location = useLocation()
  const session = useQuery(sessionQueryOptions())
  if (session.isPending)
    return <SessionCheck />
  if (session.isError) {
    if (isAuthenticationError(session.error)) {
      const from = `${location.pathname}${location.search}`
      return <Navigate to={loginPath(from, session.error.code === 'SESSION_EXPIRED' ? 'expired' : 'required')} replace />
    }
    const error = describeError(session.error)
    return (
      <main className="mx-auto flex max-w-md flex-col gap-3 p-6">
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => void session.refetch()}>{messages.common.retry}</Button>
      </main>
    )
  }
  return <Outlet />
}

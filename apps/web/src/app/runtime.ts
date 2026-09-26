import type { QueryClient } from '@tanstack/react-query'
import type { DataRouter, RouteObject } from 'react-router'
import { createBrowserRouter } from 'react-router'
import { loginPath } from '../features/auth/index.ts'
import { setCsrfToken } from '../shared/api/index.ts'
import { createQueryClient } from './query-client.ts'
import { appRoutes } from './routes.ts'

export interface AppRuntime {
  readonly router: DataRouter
  readonly queryClient: QueryClient
}

/**
 * 路由与请求缓存各一份。任何请求得到未登录或登录已过期时：清空缓存与 CSRF 令牌，回到登录页，登录后回到原来的地址。
 * 测试传入内存路由（createMemoryRouter）。
 */
export function createAppRuntime(createRouter: (routes: RouteObject[]) => DataRouter = createBrowserRouter): AppRuntime {
  const router = createRouter(appRoutes)
  const queryClient = createQueryClient((reason) => {
    const { pathname, search } = router.state.location
    if (pathname === '/login')
      return
    queryClient.clear()
    setCsrfToken(undefined)
    void router.navigate(loginPath(`${pathname}${search}`, reason), { replace: true })
  })
  return { router, queryClient }
}

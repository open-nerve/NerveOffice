import type { SessionResponse } from '@nerve-office/contracts'
import type { QueryClient } from '@tanstack/react-query'
import type { DataRouter, RouteObject } from 'react-router'
import type { PageLocation } from '../shared/lib/page-location.ts'
import type { SessionChannel } from '../shared/lib/session-channel.ts'
import { createBrowserRouter } from 'react-router'
import { fetchSession, isLoginPage, LOGIN_PATH, loginPath, sessionQueryOptions } from '../features/auth/index.ts'
import { isAuthenticationError, setCsrfToken } from '../shared/api/index.ts'
import { browserPageLocation } from '../shared/lib/page-location.ts'
import { openSessionChannel } from '../shared/lib/session-channel.ts'
import { createQueryClient } from './query-client.ts'
import { appRoutes } from './routes.ts'

export interface AppRuntime {
  readonly router: DataRouter
  readonly queryClient: QueryClient
  /** 不再接收其他标签页的消息。页面上随页面一起结束；测试里每个用例结束时调用 */
  readonly dispose: () => void
}

export interface AppRuntimeOptions {
  /** 测试传入内存路由（createMemoryRouter） */
  readonly createRouter?: (routes: RouteObject[]) => DataRouter
  /** 整页跳转；测试传入记录调用的假实现 */
  readonly page?: PageLocation
  /** 标签页之间的会话消息；测试传入假实现 */
  readonly sessionChannel?: SessionChannel
}

/**
 * 平台页面的运行时：路由与请求缓存各一份，加上会话的全局处理（ADR-008）：
 * - 请求得到未登录或登录已过期：整页回到登录页，登录后回到原来的地址；
 * - 退出成功（或者会话本来就不在了）：通知其他标签页，整页回到登录页；登录成功：通知其他标签页；
 * - 别的标签页登录或退出了，或者状态变更的请求得到 CSRF_TOKEN_INVALID：向服务端确认现在是谁（审查 B6）。
 *   还是同一个人，换上新的会话与 CSRF 令牌，页面不动；换了人或者已经退出，整页重新加载。
 *
 * 会话结束与换人都整页跳转，而不是在单页里清空缓存再切换路由（审查 B7）：上一个会话的数据与 CSRF 令牌随页面丢弃，
 * 也不会有还挂着的组件在缓存被清空后立即重新请求（重新请求的 401 还可能把"已过期"改成"未登录"）。
 * P4 的编辑器页是另一个入口，会话结束时同样只能整页转到登录页。
 */
export function createAppRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  const router = (options.createRouter ?? createBrowserRouter)(appRoutes)
  const page = options.page ?? browserPageLocation
  const channel = options.sessionChannel ?? openSessionChannel()
  /** 页面正在离开：之后的会话事件都不再处理 */
  let leaving = false
  /** 正在向服务端确认会话：同时来的几次只确认一次 */
  let checking = false

  const queryClient = createQueryClient({
    unauthenticated: (reason) => {
      const { pathname, search } = router.state.location
      if (!isLoginPage(pathname))
        leave(loginPath(`${pathname}${search}`, reason))
    },
    signedIn: () => channel.announce(),
    signedOut: () => {
      channel.announce()
      leave(LOGIN_PATH)
    },
    sessionStale: () => void recheckSession(),
  })
  const unsubscribe = channel.subscribe(() => void recheckSession())

  /** 整页离开：页面卸载之前，旧页面就不再能发出状态变更的请求 */
  function leave(url: string): void {
    if (leaving)
      return
    leaving = true
    setCsrfToken(undefined)
    page.replace(url)
  }

  /** 现在的会话；未登录时为 undefined。网络等其他失败原样抛出 */
  async function currentSession(): Promise<SessionResponse | undefined> {
    try {
      return await fetchSession()
    }
    catch (error) {
      if (isAuthenticationError(error))
        return undefined
      throw error
    }
  }

  async function recheckSession(): Promise<void> {
    if (leaving || checking)
      return
    checking = true
    try {
      const { queryKey } = sessionQueryOptions()
      const shown = queryClient.getQueryData(queryKey)
      const current = await currentSession()
      if (leaving)
        return
      if (current?.user.id !== shown?.user.id) {
        // 页面显示的是另一个人（或者未登录时）的内容
        leaving = true
        page.reload()
      }
      else if (current !== undefined) {
        queryClient.setQueryData(queryKey, current)
      }
    }
    catch {
      // 网络等失败：页面照常，下一个请求会显示错误
    }
    finally {
      checking = false
    }
  }

  return {
    router,
    queryClient,
    dispose: () => {
      unsubscribe()
      channel.close()
    },
  }
}

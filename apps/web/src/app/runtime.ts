import type { SessionResponse } from '@nerve-office/contracts'
import type { QueryClient } from '@tanstack/react-query'
import type { DataRouter, RouteObject } from 'react-router'
import type { PageLocation } from '../shared/lib/page-location.ts'
import type { SessionChannel } from '../shared/lib/session-channel.ts'
import { createBrowserRouter } from 'react-router'
import { isLoginPage, LOGIN_PATH, loginPath, requestSession, sessionQueryOptions } from '../features/auth/index.ts'
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
  /** 正在向服务端确认会话 */
  let checking = false
  /** 确认期间又来了消息：这次确认的结果可能早于那次变化，结束后再确认一次（几条消息合并成一次，复验 R10） */
  let checkAgain = false

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

  /**
   * 页面开始离开（转到登录页，或者换了人要重新加载）：之后的会话事件都不再处理，CSRF 令牌马上清掉。
   * 新页面加载完之前旧页面还显示着、还能点：没有令牌，它就发不出状态变更的请求（复验 S2）。
   */
  function depart(): boolean {
    if (leaving)
      return false
    leaving = true
    setCsrfToken(undefined)
    return true
  }

  function leave(url: string): void {
    if (depart())
      page.replace(url)
  }

  /** 现在的会话；未登录时为 undefined。网络等其他失败原样抛出。不改动请求层的令牌 */
  async function currentSession(): Promise<SessionResponse | undefined> {
    try {
      return await requestSession()
    }
    catch (error) {
      if (isAuthenticationError(error))
        return undefined
      throw error
    }
  }

  async function recheckSession(): Promise<void> {
    if (leaving)
      return
    if (checking) {
      checkAgain = true
      return
    }
    checking = true
    try {
      for (;;) {
        checkAgain = false
        await checkSessionOnce()
        // 确认期间又来了消息，而且页面还没开始离开：再确认一次
        if (!checkAgain || leaving)
          break
      }
    }
    finally {
      checking = false
    }
  }

  async function checkSessionOnce(): Promise<void> {
    try {
      const { queryKey } = sessionQueryOptions()
      const shown = queryClient.getQueryData(queryKey)
      const current = await currentSession()
      if (leaving)
        return
      if (current?.user.id !== shown?.user.id) {
        // 页面显示的是另一个人（或者未登录时）的内容：新会话的令牌不交给这个页面
        if (depart())
          page.reload()
      }
      else if (current !== undefined) {
        // 还是同一个人（例如在别的标签页重新登录）：换上新的会话与令牌，页面不动
        setCsrfToken(current.csrfToken)
        queryClient.setQueryData(queryKey, current)
      }
    }
    catch {
      // 网络等失败：页面照常，下一个请求会显示错误
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

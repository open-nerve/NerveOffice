import type { SessionResponse } from '@nerve-office/contracts'
import type { QueryClient } from '@tanstack/react-query'
import type { DataRouter, RouteObject } from 'react-router'
import type { LoginReason } from '../shared/lib/login-path.ts'
import type { PageLocation } from '../shared/lib/page-location.ts'
import type { SessionChannel } from '../shared/lib/session-channel.ts'
import type { SessionRecheck } from '../shared/lib/session-recheck.ts'
import type { ExpiredReason } from './query-client.ts'
import { createBrowserRouter } from 'react-router'
import { isOneTimeLinkPage } from '../features/account/index.ts'
import { sessionQueryOptions } from '../features/auth/index.ts'
import { isAuthenticationError, requestSession, setCsrfToken } from '../shared/api/index.ts'
import { isLoginPage, LOGIN_PATH, loginPath } from '../shared/lib/login-path.ts'
import { browserPageLocation } from '../shared/lib/page-location.ts'
import { openSessionChannel } from '../shared/lib/session-channel.ts'
import { createQueryClient, sessionChangesSettled } from './query-client.ts'
import { appRoutes } from './routes.ts'

export interface AppRuntime {
  readonly router: DataRouter
  readonly queryClient: QueryClient
  /** 整页跳转：组件经 PageLocationContext 取用 */
  readonly page: PageLocation
  /** 向服务端确认现在是谁：组件经 SessionRecheckContext 取用（例如管理员改了本人的账户之后，M2-P1 审查 B4） */
  readonly recheckSession: SessionRecheck
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
 * - 请求得到未登录：整页回到登录页，登录后回到原来的地址；
 * - 请求得到登录已过期：先向服务端确认现在是谁（复验 N3）。这个请求带的可能是换令牌之前的旧 Cookie（本页或别的标签页刚修改了密码、
 *   刚重新登录，服务端这时不清除 Cookie），浏览器里已经是新的：还是同一个人，换上新的会话与 CSRF 令牌，页面不动；换了人，整页重新加载；
 *   已经没有会话，才按原来的原因（已过期）整页回到登录页。发出请求的组件照常显示它的错误，不自动重试；
 * - 退出成功（或者会话本来就不在了）：通知其他标签页，整页回到登录页；登录成功：通知其他标签页；
 * - 别的标签页登录或退出了，状态变更的请求得到 CSRF_TOKEN_INVALID，只给系统管理员的请求得到 PERMISSION_DENIED，
 *   或者组件改了本人的账户：向服务端确认现在是谁（审查 B6，M2-P1 审查 B4）。
 *   还是同一个人，换上新的会话与 CSRF 令牌，页面不动；换了人或者已经退出，整页重新加载。
 *   一次性链接的公开页面除外：它不显示任何人的数据，重新加载反而会丢掉已经从地址里去掉的令牌（M2-P1 审查 B3）。
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
  /** 正在向服务端确认会话：确认期间再来的请求合并进这一次 */
  let checking: Promise<void> | undefined
  /** 确认期间又来了消息：这次确认的结果可能早于那次变化，结束后再确认一次（几条消息合并成一次，复验 R10） */
  let checkAgain = false
  /** 在一次性链接的公开页面上跳过的复核：离开这个页面时补上（M2-P1 复验 N6） */
  let deferredRecheck = false
  /** 已经开始的确认轮数（每向服务端确认一次加一） */
  let checksStarted = 0
  /**
   * 请求得到"登录已过期"、还没有结论（复验 N3）：reason 是确认之后没有会话时转到登录页的原因；
   * after 是那时已经开始的确认轮数，只有在它之后开始的一轮才能下结论——更早开始的那一轮带的可能还是换令牌之前的旧 Cookie
   */
  let expired: { readonly reason: ExpiredReason, readonly after: number } | undefined

  const queryClient = createQueryClient({
    unauthenticated: () => leaveToLogin('required'),
    sessionExpired: reason => void confirmExpiredSession(reason),
    signedIn: () => channel.announce(),
    signedOut: () => {
      channel.announce()
      leave(LOGIN_PATH)
    },
    sessionStale: () => void recheckSession(),
  })
  const unsubscribe = channel.subscribe(() => void recheckSession())
  // 公开页面接受或完成之后单页进入个人空间：跳过的复核这时补上。例如接受的响应写入了新账户的 Cookie，
  // 随后别的标签页又登录了另一个人，页面显示的与 Cookie 不是同一个人，要整页重新加载（复验 N6）
  const unsubscribeRouter = router.subscribe((state) => {
    if (deferredRecheck && !isOneTimeLinkPage(state.location.pathname)) {
      deferredRecheck = false
      void recheckSession()
    }
  })

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

  /** 整页回到登录页，登录后回到现在的地址；已经在登录页时不动 */
  function leaveToLogin(reason: LoginReason): void {
    const { pathname, search } = router.state.location
    if (!isLoginPage(pathname))
      leave(loginPath(`${pathname}${search}`, reason))
  }

  /**
   * 请求得到"登录已过期"（复验 N3）：记下原因，向服务端确认现在是谁，结论在 checkSessionOnce 里（页面已经在离开时 recheckSession 不做事）。
   * 本页还在进行的登录、修改密码先等它结束：它的响应带着新的 Cookie，结束之前确认，带的多半还是旧的。
   * 几个请求先后过期时保留更具体的 password_changed（修改密码的结果未知之后再提交，M2-P6 复核 G-1）
   */
  async function confirmExpiredSession(reason: ExpiredReason): Promise<void> {
    await sessionChangesSettled(queryClient)
    expired = { reason: expired?.reason === 'password_changed' ? 'password_changed' : reason, after: checksStarted }
    await recheckSession()
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

  /** 确认结束时兑现；确认期间再调用，合并进正在进行的这一次（它结束前会再确认一次） */
  async function recheckSession(): Promise<void> {
    if (leaving)
      return
    if (checking !== undefined) {
      checkAgain = true
      return checking
    }
    checking = confirmSession().finally(() => {
      checking = undefined
    })
    return checking
  }

  async function confirmSession(): Promise<void> {
    for (;;) {
      checkAgain = false
      await checkSessionOnce()
      // 确认期间又来了消息，而且页面还没开始离开：再确认一次
      if (!checkAgain || leaving)
        break
    }
  }

  async function checkSessionOnce(): Promise<void> {
    // 一次性链接的公开页面：没有显示任何人的数据，也不拿 CSRF 令牌，别的标签页换了人与它无关。
    // 令牌读出之后已经从地址里去掉，重新加载只能显示"链接无效"（M2-P1 审查 B3）。离开这个页面时再补上（复验 N6）
    if (isOneTimeLinkPage(router.state.location.pathname)) {
      deferredRecheck = true
      return
    }
    const round = ++checksStarted
    try {
      const { queryKey } = sessionQueryOptions()
      const shown = queryClient.getQueryData(queryKey)
      const current = await currentSession()
      if (leaving)
        return
      // 请求得到"登录已过期"之后开始的这一轮，才能对它下结论（复验 N3）
      const concluding = expired !== undefined && round > expired.after ? expired : undefined
      if (current === undefined && expired !== undefined && concluding === undefined) {
        // 更早开始的一轮：带的可能还是换令牌之前的旧 Cookie，"没有会话"不作数，等随后补上的那一轮
        return
      }
      if (concluding !== undefined)
        expired = undefined
      if (current === undefined && concluding !== undefined) {
        // 已经没有会话：按请求得到的原因回到登录页。不整页重新加载：Cookie 可能已被清除，重新加载时"已过期"就成了"请先登录"
        leaveToLogin(concluding.reason)
      }
      else if (current?.user.id !== shown?.user.id) {
        // 页面显示的是另一个人（或者未登录时）的内容：新会话的令牌不交给这个页面
        if (depart())
          page.reload()
      }
      else if (current !== undefined) {
        // 还是同一个人（例如在别的标签页重新登录；请求的"登录已过期"是换令牌之前发出的）：换上新的会话与令牌，页面不动
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
    page,
    recheckSession,
    dispose: () => {
      unsubscribe()
      unsubscribeRouter()
      channel.close()
    },
  }
}

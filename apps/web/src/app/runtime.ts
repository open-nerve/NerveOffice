import type { SessionResponse } from '@nerve-office/contracts'
import type { QueryClient } from '@tanstack/react-query'
import type { DataRouter, RouteObject } from 'react-router'
import type { RequestIdLedger } from '../shared/api/request-ids.ts'
import type { LoginReason } from '../shared/lib/login-path.ts'
import type { PageLocation } from '../shared/lib/page-location.ts'
import type { AdoptRenewedSession } from '../shared/lib/renewed-session.ts'
import type { SessionChannel } from '../shared/lib/session-channel.ts'
import type { SessionRecheck } from '../shared/lib/session-recheck.ts'
import type { ExpiredReason } from './query-client.ts'
import { createBrowserRouter } from 'react-router'
import { isOneTimeLinkPage } from '../features/account/index.ts'
import { sessionQueryOptions } from '../features/auth/index.ts'
import { isAuthenticationError, requestSession, setCsrfToken } from '../shared/api/index.ts'
import { createRequestIdLedger } from '../shared/api/request-ids.ts'
import { isLoginPage, LOGIN_PATH, loginPath } from '../shared/lib/login-path.ts'
import { browserPageLocation } from '../shared/lib/page-location.ts'
import { openSessionChannel } from '../shared/lib/session-channel.ts'
import { createQueryClient, sessionChangesPending, sessionChangesSettled } from './query-client.ts'
import { appRoutes } from './routes.ts'

export interface AppRuntime {
  readonly router: DataRouter
  readonly queryClient: QueryClient
  /** 整页跳转：组件经 PageLocationContext 取用 */
  readonly page: PageLocation
  /** 向服务端确认现在是谁：组件经 SessionRecheckContext 取用（例如管理员改了本人的账户之后，M2-P1 审查 B4） */
  readonly recheckSession: SessionRecheck
  /** 请求得到"登录已过期"之后，换上浏览器里同一个人的新会话：退出经 AdoptRenewedSessionContext 取用（M2-P6 复验 一般-4） */
  readonly adoptRenewedSession: AdoptRenewedSession
  /**
   * 带 requestId 的新建共用的记账（新建表格、新建文件夹、复制，M2-P6 复核 M1）：页面一份，组件经 RequestIdLedgerContext 取用。
   * 组件随导航卸载、再回来时，结果未知的那件事仍沿用原来的 requestId
   */
  readonly requestIds: RequestIdLedger
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
 * - 请求得到未登录：整页回到登录页，登录后回到原来的地址；还有请求得到"登录已过期"、正在确认时，登录页的说明仍是"已过期"
 *   （未登录说明浏览器里已经没有 Cookie，不必再确认，M2-P6 复验 建议-1）；
 * - 请求得到登录已过期：先向服务端确认现在是谁（复验 N3）。这个请求带的可能是换令牌之前的旧 Cookie（本页或别的标签页刚修改了密码、
 *   刚重新登录，服务端这时不清除 Cookie），浏览器里已经是新的：还是同一个人，换上新的会话与 CSRF 令牌，页面不动；换了人，整页重新加载；
 *   已经没有会话，才按原来的原因（已过期）整页回到登录页。发出请求的组件照常显示它的错误，不自动重试；
 * - 每一轮向服务端确认之前，本页还在进行的登录、修改密码先等它结束（有上限，见 sessionChangesSettled）：它的响应带着新的 Cookie，
 *   结束之前确认，带的多半还是旧的（M2-P6 复验 一般-1）；
 * - 退出成功（或者会话本来就不在了）：通知其他标签页，整页回到登录页；登录成功：通知其他标签页。
 *   退出得到"登录已过期"时由退出自己先确认一次（features/auth 的 logout 经 adoptRenewedSession，M2-P6 复验 一般-4）；
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
   * after 是那时已经开始的确认轮数，只有在它之后开始的一轮才能下结论——更早开始的那一轮带的可能还是换令牌之前的旧 Cookie。
   * 在它之后开始的一轮都先等本页的登录、修改密码结束才发出请求（checkSessionOnce），带的是它们换上的新 Cookie
   */
  let expired: { readonly reason: ExpiredReason, readonly after: number } | undefined

  const queryClient = createQueryClient({
    // 未登录：浏览器里已经没有 Cookie，直接下结论。还有请求得到"登录已过期"、正在确认时，按它的原因转到登录页：
    // 过期的那次响应清除了 Cookie，之后的请求才成了未登录，原因仍是"已过期"（审查 B7，M2-P6 复验 建议-1）
    unauthenticated: () => leaveToLogin(expired?.reason ?? 'required'),
    sessionExpired: reason => confirmExpiredSession(reason),
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
   * 请求得到"登录已过期"（复验 N3）：马上记下原因，向服务端确认现在是谁，结论在 checkSessionOnce 里（页面已经在离开时 recheckSession 不做事）。
   * 本页还在进行的登录、修改密码由那一轮先等它结束（M2-P6 复验 一般-1）；原因不等它就记下，确认期间别的请求得到未登录时用得上（建议-1）。
   * 几个请求先后过期时保留更具体的原因：password_changed（修改密码的结果未知之后再提交，M2-P6 复核 G-1）、
   * password_reset（为自己生成重置链接的结果未知之后再试，M2-P6 复核 S1），不被随后普通的"已过期"盖掉
   */
  function confirmExpiredSession(reason: ExpiredReason): void {
    const earlier = expired?.reason
    expired = { reason: earlier === undefined || earlier === 'expired' ? reason : earlier, after: checksStarted }
    void recheckSession()
  }

  /**
   * 请求得到"登录已过期"之后，浏览器里是不是已经换成了同一个人的新会话（M2-P6 复验 一般-4，features/auth 的退出经
   * AdoptRenewedSessionContext 调用）：先等本页的登录、修改密码结束，再向服务端要一次会话。还是页面上的这个人：换上新的会话与
   * CSRF 令牌，兑现为 true；没有会话、换了人、页面已经在离开：兑现为 false，不跳转、不重新加载，由调用方按原来的结果处理。
   * 网络等失败原样抛出。不经 recheckSession：确认的结果交给调用方，不合并进别的确认
   */
  async function adoptRenewedSession(): Promise<boolean> {
    await sessionChangesSettled(queryClient)
    if (leaving)
      return false
    const { queryKey } = sessionQueryOptions()
    const shown = queryClient.getQueryData(queryKey)
    const current = await currentSession()
    if (leaving || current === undefined || current.user.id !== shown?.user.id)
      return false
    adopt(current)
    return true
  }

  /** 还是同一个人：换上新的会话与 CSRF 令牌，页面不动 */
  function adopt(current: SessionResponse): void {
    setCsrfToken(current.csrfToken)
    queryClient.setQueryData(sessionQueryOptions().queryKey, current)
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
    // 本页还在进行的登录、修改密码先等它结束（M2-P6 复验 一般-1）：不管这一轮由什么开始（请求得到"登录已过期"、别的标签页的消息、
    // 组件的复核），结束之前发出的确认带的多半还是换令牌之前的旧 Cookie，得到"没有会话"就会整页重新加载，打断还在路上的响应。
    // 只在确有这样的变更时才等：没有时确认的请求同步发出，确认期间又来的消息据此排在它后面（复验 R10）
    if (sessionChangesPending(queryClient)) {
      await sessionChangesSettled(queryClient)
      if (leaving)
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
        adopt(current)
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
    adoptRenewedSession,
    requestIds: createRequestIdLedger(),
    dispose: () => {
      unsubscribe()
      unsubscribeRouter()
      channel.close()
    },
  }
}

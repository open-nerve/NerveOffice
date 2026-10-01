import type { ExpiredReason } from '../shared/lib/login-path.ts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isAuthenticationError, isCsrfTokenError, isPermissionDeniedError, isTransientError } from '../shared/api/index.ts'

/** 网络问题与服务端的临时错误重试一次；其他错误（4xx）重试也没用 */
const MAX_TRANSIENT_RETRIES = 1

/** 请求缓存从请求结果里看出的会话变化，由 app/runtime.ts 统一处理。 */
export interface SessionEvents {
  /** 请求得到"未登录"：没有带会话 Cookie（自己处理未登录的请求除外） */
  readonly unauthenticated: () => void
  /**
   * 请求得到"登录已过期"：带着的会话 Cookie 已经失效（自己处理未登录的请求除外）。可能只是换令牌之前发出的请求
   * （修改密码、重新登录之后浏览器里已是新的 Cookie），由运行时先向服务端确认（复验 N3）；reason 是确认之后仍要转到登录页时的说明
   */
  readonly sessionExpired: (reason: ExpiredReason) => void
  /** 登录成功，或者当前页面换成了新的会话（修改密码，M2-P6 复核 B1）：别的标签页拿着的 CSRF 令牌随之过时 */
  readonly signedIn: () => void
  /** 退出成功，或者退出时会话已经不在了 */
  readonly signedOut: () => void
  /**
   * 页面拿着的会话已经过时，要向服务端重新确认：状态变更的请求得到 CSRF_TOKEN_INVALID（别的标签页换了人），
   * 或者只给系统管理员的请求得到 PERMISSION_DENIED（系统角色被取消了，M2-P1 审查 B4）
   */
  readonly sessionStale: () => void
}

type Meta = Record<string, unknown> | undefined

/** 这个请求自己处理未登录（会话、登录），全局的"回到登录页"不管它 */
function handlesAuthentication(meta: Meta): boolean {
  return meta?.handlesAuthentication === true
}

/** 这个请求只给系统管理员（features/auth 的 SYSTEM_ADMIN_ONLY）：被拒绝说明页面显示的系统角色已经过时 */
function systemAdminOnly(meta: Meta): boolean {
  return meta?.systemAdminOnly === true
}

/**
 * 这个变更开始（登录）、换掉（修改密码）还是结束（退出）会话；元数据由 features/auth 的 STARTS_SESSION、RENEWS_SESSION、
 * ENDS_SESSION 给出
 */
function sessionTransition(meta: Meta): 'starts' | 'renews' | 'ends' | undefined {
  const transition = meta?.session
  return transition === 'starts' || transition === 'renews' || transition === 'ends' ? transition : undefined
}

/**
 * 得到"登录已过期"时带到登录页的原因：默认 expired；修改密码的结果未知之后再提交时是 password_changed
 * （features/auth 的 RENEWS_SESSION_AFTER_UNKNOWN，M2-P6 复核 G-1）；为自己生成重置链接的结果未知之后再试时是 password_reset
 * （features/auth 的 OWN_RESET_AFTER_UNKNOWN，M2-P6 复核 S1）
 */
function expiredReason(meta: Meta): ExpiredReason {
  const reason = meta?.expiredReason
  return reason === 'password_changed' || reason === 'password_reset' ? reason : 'expired'
}

/**
 * 本页的登录、修改密码从开始算起最多等多久（M2-P6 复验 一般-2）：略大于修改密码在服务端**通常**的最长耗时（默认配置）。
 * 超过了就当它不会结束了（例如响应在网络上丢了），照常向服务端确认会话，不一直等下去。修改密码在服务端可能等待的几处，各有上限：
 * - 验证旧密码、计算新密码的哈希，各在哈希的队列里排队不超过 5 秒（NERVE_PASSWORD_HASH_QUEUE_TIMEOUT_MS），超过即 503；
 * - 数据库的一条语句不超过 15 秒（NERVE_DATABASE_STATEMENT_TIMEOUT_MS，其中等锁不超过 5 秒：NERVE_DATABASE_LOCK_TIMEOUT_MS），
 *   数据库没有回应时客户端另外多等 5 秒（apps/api 的 QUERY_TIMEOUT_MARGIN_MS），超过即以错误结束；
 * - 从连接池取连接不超过 5 秒（NERVE_DATABASE_CONNECT_TIMEOUT_MS）。
 * 两次排队、一条语句到上限、一次取连接合计 35 秒，加上哈希的计算与网络的往返，取 40 秒。语句与等锁的时限是按每条语句计的，
 * 服务端也没有按整个请求计的处理时限，所以严格说最坏的耗时可以更长（几条语句各自等锁到上限，第三轮复验 一般-F）；这里按通常的最坏情形取。
 * 接收请求的时限（NERVE_HTTP_REQUEST_TIMEOUT_MS，默认 60 秒，即 Node 的 requestTimeout）只管收完请求，不限制处理的时间，这里不按它算。
 * 部署时调大了上面几项的，这里的等待可能短于修改密码的实际耗时：到了上限照常确认，最坏是这个页面按"已过期"回到登录页
 */
export const SESSION_CHANGE_TIME_LIMIT_MS = 40_000

/** 这个变更成功时写入新的会话 Cookie：开始（登录）或者换掉（修改密码）会话 */
function writesSessionCookie(meta: Meta): boolean {
  const transition = sessionTransition(meta)
  return transition === 'starts' || transition === 'renews'
}

/**
 * 本页还在进行、开始之后还没超过 SESSION_CHANGE_TIME_LIMIT_MS 的登录与修改密码里，最晚的那个时限（毫秒时间戳）；
 * 没有这样的变更时为 undefined
 */
function sessionChangeDeadline(queryClient: QueryClient): number | undefined {
  const now = Date.now()
  let deadline: number | undefined
  for (const mutation of queryClient.getMutationCache().getAll()) {
    if (mutation.state.status !== 'pending' || !writesSessionCookie(mutation.meta))
      continue
    const end = mutation.state.submittedAt + SESSION_CHANGE_TIME_LIMIT_MS
    if (end > now && (deadline === undefined || end > deadline))
      deadline = end
  }
  return deadline
}

/** 本页有还在进行的登录或修改密码（开始之后还没超过 SESSION_CHANGE_TIME_LIMIT_MS）：它的响应会带来新的会话 Cookie */
export function sessionChangesPending(queryClient: QueryClient): boolean {
  return sessionChangeDeadline(queryClient) !== undefined
}

/**
 * 本页还在进行的、成功时写入新的会话 Cookie 的变更（登录、修改密码）都结束之后兑现（复验 N3）：
 * 它们的响应带着新的 Cookie，结束之前向服务端确认会话，带的可能还是旧的。没有这样的变更时立即兑现。
 * 等待有上限（M2-P6 复验 一般-2）：每个变更从它开始算起最多等 SESSION_CHANGE_TIME_LIMIT_MS，按开始的时间算，
 * 同一个一直不结束的变更不会让之后的每一次确认都再等一整轮
 */
export async function sessionChangesSettled(queryClient: QueryClient): Promise<void> {
  if (!sessionChangesPending(queryClient))
    return
  const cache = queryClient.getMutationCache()
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    // 变更有变化时、或者到了最晚的时限时再看一次：等的期间又开始的登录、修改密码也一起等
    const check = (): void => {
      clearTimeout(timer)
      const deadline = sessionChangeDeadline(queryClient)
      if (deadline === undefined) {
        unsubscribe()
        resolve()
        return
      }
      timer = setTimeout(check, deadline - Date.now())
    }
    unsubscribe = cache.subscribe(check)
    check()
  })
}

/**
 * 请求缓存（TanStack Query）。请求的结果里与会话有关的，查询与变更都一样，统一交给 events：
 * 未登录、登录已过期、登录与退出、会话过时（CSRF 令牌不对、系统角色被取消）。自己处理未登录的请求（会话、登录）用 meta.handlesAuthentication 标明。
 */
export function createQueryClient(events: SessionEvents): QueryClient {
  function onRequestError(error: unknown, meta: Meta): void {
    if (isCsrfTokenError(error) || (isPermissionDeniedError(error) && systemAdminOnly(meta)))
      events.sessionStale()
    else if (isAuthenticationError(error) && !handlesAuthentication(meta) && error.code === 'SESSION_EXPIRED')
      events.sessionExpired(expiredReason(meta))
    else if (isAuthenticationError(error) && !handlesAuthentication(meta))
      events.unauthenticated()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onRequestError(error, query.meta) }),
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        const transition = sessionTransition(mutation.meta)
        if (transition === 'starts' || transition === 'renews')
          events.signedIn()
        else if (transition === 'ends')
          events.signedOut()
      },
      onError: (error, _variables, _context, mutation) => {
        // 退出时会话已经不在了（401）：退出的目的已经达到，按成功处理
        if (sessionTransition(mutation.meta) === 'ends' && isAuthenticationError(error))
          events.signedOut()
        else
          onRequestError(error, mutation.meta)
      },
    }),
    defaultOptions: {
      // networkMode 'always'：不看 navigator.onLine，断网时请求照常发出、照常失败，由请求层归为 NetworkError 显示出来（审查 B4）。
      // 默认的 'online' 在浏览器认为离线时把查询与变更挂起，界面一直停在"进行中"：退出时尤其危险，请求根本没发出去，会话仍然有效。
      // navigator.onLine 本身也不可靠：连着局域网、却到不了服务器时它仍是 true
      queries: {
        networkMode: 'always',
        retry: (failures, error) => isTransientError(error) && failures < MAX_TRANSIENT_RETRIES,
        refetchOnWindowFocus: false,
      },
      mutations: { networkMode: 'always', retry: false },
    },
  })
}

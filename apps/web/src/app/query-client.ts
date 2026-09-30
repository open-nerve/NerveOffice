import type { LoginReason } from '../shared/lib/login-path.ts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isAuthenticationError, isCsrfTokenError, isPermissionDeniedError, isTransientError } from '../shared/api/index.ts'

/** 网络问题与服务端的临时错误重试一次；其他错误（4xx）重试也没用 */
const MAX_TRANSIENT_RETRIES = 1

/** "登录已过期"时带到登录页的原因（见 expiredReason） */
export type ExpiredReason = Exclude<LoginReason, 'required'>

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
 * （features/auth 的 RENEWS_SESSION_AFTER_UNKNOWN，M2-P6 复核 G-1）
 */
function expiredReason(meta: Meta): ExpiredReason {
  return meta?.expiredReason === 'password_changed' ? 'password_changed' : 'expired'
}

/**
 * 本页还在进行的、成功时写入新的会话 Cookie 的变更（登录、修改密码）都结束之后兑现（复验 N3）：
 * 它们的响应带着新的 Cookie，结束之前向服务端确认会话，带的可能还是旧的。没有这样的变更时立即兑现
 */
export async function sessionChangesSettled(queryClient: QueryClient): Promise<void> {
  const cache = queryClient.getMutationCache()
  const pending = (): boolean => cache.getAll().some((mutation) => {
    const transition = sessionTransition(mutation.meta)
    return mutation.state.status === 'pending' && (transition === 'starts' || transition === 'renews')
  })
  if (!pending())
    return
  await new Promise<void>((resolve) => {
    const unsubscribe = cache.subscribe(() => {
      if (!pending()) {
        unsubscribe()
        resolve()
      }
    })
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

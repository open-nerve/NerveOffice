import type { LoginReason } from '../shared/lib/login-path.ts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isAuthenticationError, isCsrfTokenError, isPermissionDeniedError, isTransientError } from '../shared/api/index.ts'

/** 网络问题与服务端的临时错误重试一次；其他错误（4xx）重试也没用 */
const MAX_TRANSIENT_RETRIES = 1

/** 请求缓存从请求结果里看出的会话变化，由 app/runtime.ts 统一处理。 */
export interface SessionEvents {
  /** 请求得到未登录或登录已过期（自己处理未登录的请求除外） */
  readonly unauthenticated: (reason: LoginReason) => void
  /** 登录成功 */
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

/** 这个变更开始（登录）还是结束（退出）会话；元数据由 features/auth 的 STARTS_SESSION、ENDS_SESSION 给出 */
function sessionTransition(meta: Meta): 'starts' | 'ends' | undefined {
  const transition = meta?.session
  return transition === 'starts' || transition === 'ends' ? transition : undefined
}

/**
 * 请求缓存（TanStack Query）。请求的结果里与会话有关的，查询与变更都一样，统一交给 events：
 * 未登录或登录已过期、登录与退出、会话过时（CSRF 令牌不对、系统角色被取消）。自己处理未登录的请求（会话、登录）用 meta.handlesAuthentication 标明。
 */
export function createQueryClient(events: SessionEvents): QueryClient {
  function onRequestError(error: unknown, meta: Meta): void {
    if (isCsrfTokenError(error) || (isPermissionDeniedError(error) && systemAdminOnly(meta)))
      events.sessionStale()
    else if (isAuthenticationError(error) && !handlesAuthentication(meta))
      events.unauthenticated(error.code === 'SESSION_EXPIRED' ? 'expired' : 'required')
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onRequestError(error, query.meta) }),
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        const transition = sessionTransition(mutation.meta)
        if (transition === 'starts')
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

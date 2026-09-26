import type { LoginReason } from '../features/auth/index.ts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isAuthenticationError, isTransientError } from '../shared/api/index.ts'

/** 网络问题与服务端的临时错误重试一次；其他错误（4xx）重试也没用 */
const MAX_TRANSIENT_RETRIES = 1

function handlesAuthentication(meta: Record<string, unknown> | undefined): boolean {
  return meta?.handlesAuthentication === true
}

/**
 * 请求缓存（TanStack Query）。任何请求得到"未登录""登录已过期"时（查询与变更都算），统一交给 onUnauthenticated：
 * 清空缓存、回到登录页。自己处理未登录的请求（会话、登录、退出）用 meta.handlesAuthentication 标明，这里不管。
 */
export function createQueryClient(onUnauthenticated: (reason: LoginReason) => void): QueryClient {
  function handle(error: unknown, meta: Record<string, unknown> | undefined): void {
    if (isAuthenticationError(error) && !handlesAuthentication(meta))
      onUnauthenticated(error.code === 'SESSION_EXPIRED' ? 'expired' : 'required')
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => handle(error, query.meta) }),
    mutationCache: new MutationCache({ onError: (error, _variables, _context, mutation) => handle(error, mutation.meta) }),
    defaultOptions: {
      queries: {
        retry: (failures, error) => isTransientError(error) && failures < MAX_TRANSIENT_RETRIES,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
}

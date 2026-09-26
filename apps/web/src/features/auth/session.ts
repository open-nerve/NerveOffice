// 会话（P3 设计 §3.7）：当前会话的查询、登录与退出；CSRF 令牌随会话交给请求层。
import type { LoginRequest, SessionResponse } from '@nerve-office/contracts'
import { sessionResponseSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest, setCsrfToken } from '../../shared/api/index.ts'

export const SESSION_QUERY_KEY = ['auth', 'session'] as const

// 请求的元数据，交给请求缓存的全局处理（app/query-client.ts）：
// - handlesAuthentication：这个请求自己处理"未登录"（会话、登录），全局的"回到登录页"不管它；
// - session：这个变更开始（登录）或者结束（退出）会话。全局处理通知其他标签页；结束时整页回到登录页。

/** 查询会话：得到未登录是正常的结果，由需要登录的外层路由与登录页自己处理 */
export const HANDLES_AUTHENTICATION = { handlesAuthentication: true } as const
/** 登录 */
export const STARTS_SESSION = { handlesAuthentication: true, session: 'starts' } as const
/** 退出：成功，或者会话本来就不在了（401），都算退出了 */
export const ENDS_SESSION = { session: 'ends' } as const

export async function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  const session = await apiRequest('/api/auth/session', { schema: sessionResponseSchema, signal })
  setCsrfToken(session.csrfToken)
  return session
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async ({ signal }) => fetchSession(signal),
    // 会话在一个标签页里长期有效：过期时任何请求都会得到 401，由全局处理回到登录页；别的标签页换了人时由全局处理重新确认（app/runtime.ts）。
    // 失败的重试与其他查询相同：网络与 5xx 重试一次，未登录不重试（审查 B20）
    staleTime: Infinity,
    // 未登录的结果留在缓存里：需要登录的外层路由转到登录页之后，登录页直接用它，不再请求一次
    retryOnMount: false,
    meta: HANDLES_AUTHENTICATION,
  })
}

export async function login(request: LoginRequest): Promise<SessionResponse> {
  const session = await apiRequest('/api/auth/login', { method: 'POST', body: request, schema: sessionResponseSchema })
  setCsrfToken(session.csrfToken)
  return session
}

export async function logout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST', schema: z.undefined() })
  setCsrfToken(undefined)
}

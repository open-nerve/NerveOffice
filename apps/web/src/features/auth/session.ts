// 会话（P3 设计 §3.7）：当前会话的查询、登录与退出；CSRF 令牌随会话交给请求层。
import type { LoginRequest, SessionResponse } from '@nerve-office/contracts'
import { sessionResponseSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest, setCsrfToken } from '../../shared/api/index.ts'

export const SESSION_QUERY_KEY = ['auth', 'session'] as const

/** 查询的元数据：这个查询自己处理未登录（例如登录页），全局的"回到登录页"不管它 */
export const HANDLES_AUTHENTICATION = { handlesAuthentication: true } as const

export async function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  const session = await apiRequest('/api/auth/session', { schema: sessionResponseSchema, signal })
  setCsrfToken(session.csrfToken)
  return session
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async ({ signal }) => fetchSession(signal),
    // 会话在一个标签页里长期有效；过期时任何请求都会得到 401，由全局的处理回到登录页
    staleTime: Infinity,
    retry: false,
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

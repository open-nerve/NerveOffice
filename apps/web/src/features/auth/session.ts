// 会话（P3 设计 §3.7）：当前会话的查询、登录与退出；CSRF 令牌随会话交给请求层。
import type { LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AdoptRenewedSession } from '../../shared/lib/renewed-session.ts'
import { sessionResponseSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest, isAuthenticationError, requestSession, setCsrfToken } from '../../shared/api/index.ts'

export const SESSION_QUERY_KEY = ['auth', 'session'] as const

// 请求的元数据，交给请求缓存的全局处理（app/query-client.ts）：
// - handlesAuthentication：这个请求自己处理"未登录"（会话、登录），全局的"回到登录页"不管它；
// - session：这个变更开始（登录）、换掉（修改密码）或者结束（退出）会话。全局处理通知其他标签页；结束时整页回到登录页；
// - expiredReason：这个请求得到"登录已过期"时，登录页给出的说明换成这个原因（修改密码的结果未知之后，M2-P6 复核 G-1；
//   为自己生成重置链接的结果未知之后，M2-P6 复核 S1）；
// - systemAdminOnly：这个请求只给系统管理员（服务端的 @SystemAdminOnly()）。

/** 查询会话：得到未登录是正常的结果，由需要登录的外层路由与登录页自己处理 */
export const HANDLES_AUTHENTICATION = { handlesAuthentication: true } as const
/** 登录 */
export const STARTS_SESSION = { handlesAuthentication: true, session: 'starts' } as const
/** 退出：成功，或者会话本来就不在了（401），都算退出了 */
export const ENDS_SESSION = { session: 'ends' } as const
/**
 * 修改密码：成功时当前页面换成了新的会话（M2-P6 复核 B1），通知其他标签页——同一个浏览器共用 Cookie，
 * 它们拿着的 CSRF 令牌随旧会话一起过时了。得到"未登录"时照常回到登录页（不像 STARTS_SESSION 那样自己处理）
 */
export const RENEWS_SESSION = { session: 'renews' } as const
/**
 * 同上，用在上一次提交的结果未知之后（M2-P6 复核 G-1）：这时再提交得到"登录已过期"，多半是上一次已经改好、
 * 当前的会话随之撤销了，登录页据此提示"新密码可能已经生效"
 */
export const RENEWS_SESSION_AFTER_UNKNOWN = { session: 'renews', expiredReason: 'password_changed' } as const
/**
 * 管理接口：得到 PERMISSION_DENIED，说明页面显示的系统角色已经过时（例如被别的管理员取消了），
 * 全局处理向服务端重新确认会话，管理界面随之切到无权限（M2-P1 审查 B4）
 */
export const SYSTEM_ADMIN_ONLY = { systemAdminOnly: true } as const
/**
 * 同上，用在为自己生成重置链接的结果未知之后（M2-P6 复核 S1）：这时再试得到"登录已过期"，多半是上一次已经生成、
 * 密码随之失效、会话全部撤销了，登录页据此提示"你的密码可能已经失效"
 */
export const OWN_RESET_AFTER_UNKNOWN = { systemAdminOnly: true, expiredReason: 'password_reset' } as const

/** 会话查询用：拿到会话就把它的 CSRF 令牌交给请求层。 */
export async function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  const session = await requestSession(signal)
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

/**
 * 退出。得到"登录已过期"时先确认一次（M2-P6 复验 一般-4）：这次带的可能是换令牌之前的旧 Cookie——同一个浏览器里修改密码
 * 或重新登录与退出同时发生、退出晚于换令牌处理，服务端回 401 而不清除 Cookie，浏览器里的新会话仍然有效；照原样当作已经退出，
 * 登录页又会认出新会话、把人送回应用。浏览器里还是同一个人（adoptRenewedSession 换上了新的会话与 CSRF 令牌）：带着新的令牌再退出一次；
 * 没有会话、换了人：按原来的结果（这个会话已经不在了）处理，不替别人退出。
 * 只确认一次，不循环：再退出的结果照常处理——成功或 401 都算退出了，网络等其他失败显示出来、可以重试；确认本身失败同样显示出来
 */
export async function logout(adoptRenewedSession: AdoptRenewedSession): Promise<void> {
  try {
    await requestLogout()
  }
  catch (error) {
    if (!isAuthenticationError(error) || error.code !== 'SESSION_EXPIRED' || !await adoptRenewedSession())
      throw error
    await requestLogout()
  }
  setCsrfToken(undefined)
}

async function requestLogout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST', schema: z.undefined() })
}

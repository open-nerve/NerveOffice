// 登录后的请求（P3 设计 §3.5）：带上会话 Cookie、与公开地址相同的 Origin，状态变更请求再带 CSRF 令牌。
import type { SessionResponse } from '@nerve-office/contracts'
import { CSRF_TOKEN_HEADER, sessionResponseSchema } from '@nerve-office/contracts'
import { TEST_PUBLIC_ORIGIN } from './api-app.ts'
import { parseExact } from './contracts.ts'

/** 测试里的会话 Cookie 名称：公开地址是本机的 HTTP，没有 __Host- 前缀。 */
export const SESSION_COOKIE = 'nerve_session'

export interface LoggedIn {
  readonly cookie: string
  readonly session: SessionResponse
}

/** Set-Cookie 里会话 Cookie 的那一条（没有就返回 undefined）。 */
export function sessionSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))
}

export function cookieValue(setCookie: string): string {
  return setCookie.slice(`${SESSION_COOKIE}=`.length).split(';')[0] ?? ''
}

export async function postLogin(baseUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': TEST_PUBLIC_ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

export async function login(baseUrl: string, username: string, password: string): Promise<LoggedIn> {
  const response = await postLogin(baseUrl, { username, password })
  if (response.status !== 200)
    throw new Error(`登录失败：${response.status} ${await response.text()}`)
  const setCookie = sessionSetCookie(response)
  if (setCookie === undefined)
    throw new Error('登录成功却没有下发会话 Cookie')
  return { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}`, session: parseExact(sessionResponseSchema, await response.json()) }
}

export interface AuthenticatedRequest {
  readonly method?: string
  readonly body?: unknown
  /** 覆盖默认的请求头（Cookie、Origin、CSRF 令牌），用来构造反向用例 */
  readonly headers?: Record<string, string | undefined>
}

/** 以这个会话发请求：状态变更的请求自动带上 CSRF 令牌。 */
export async function asUser(baseUrl: string, user: LoggedIn, path: string, request: AuthenticatedRequest = {}): Promise<Response> {
  const method = request.method ?? 'GET'
  const defaults: Record<string, string> = { cookie: user.cookie, origin: TEST_PUBLIC_ORIGIN }
  if (method !== 'GET')
    defaults[CSRF_TOKEN_HEADER] = user.session.csrfToken
  if (request.body !== undefined)
    defaults['content-type'] = 'application/json'
  const headers = Object.fromEntries(Object.entries({ ...defaults, ...request.headers }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return fetch(`${baseUrl}${path}`, { method, headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) })
}

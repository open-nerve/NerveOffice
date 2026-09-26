// 当前请求的认证结果（P3 设计 §3.5）：由会话守卫挂到请求上，控制器用参数装饰器取得。
import type { ExecutionContext } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { User } from '../users/index.ts'
import type { SessionCookieSettings } from './session-cookie.ts'
import { createParamDecorator } from '@nestjs/common'

/** 已登录的用户与会话。不含会话令牌本身，只有由它派生的 CSRF 令牌。 */
export interface Principal {
  readonly user: User
  readonly sessionId: string
  readonly csrfToken: string
}

/** 控制器读写会话 Cookie 的窄接口：不把整个请求、响应交给控制器（规范 §1.2、P2 设计 §3.1）。 */
export interface SessionCookie {
  /** 请求带来的会话令牌（格式合法才有） */
  readonly token: string | undefined
  write: (token: string) => void
  clear: () => void
}

const PRINCIPAL: unique symbol = Symbol('nerve-office:principal')
const SESSION_COOKIE: unique symbol = Symbol('nerve-office:session-cookie')

interface AuthenticatedRequest extends Request {
  [PRINCIPAL]?: Principal
  [SESSION_COOKIE]?: SessionCookie
}

export function attachPrincipal(request: Request, principal: Principal): void {
  (request as AuthenticatedRequest)[PRINCIPAL] = principal
}

export function principalOf(request: Request): Principal | undefined {
  return (request as AuthenticatedRequest)[PRINCIPAL]
}

/** 会话守卫对每个请求（包括公开的接口）先挂上 Cookie 的读写。 */
export function attachSessionCookie(request: Request, response: Response, settings: SessionCookieSettings): void {
  (request as AuthenticatedRequest)[SESSION_COOKIE] = {
    token: settings.read(request.headers.cookie),
    write: token => settings.write(response, token),
    clear: () => settings.clear(response),
  }
}

/** 控制器的参数装饰器：`logout(@CurrentPrincipal() principal: Principal)`。只能用在需要登录的接口上。 */
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = principalOf(context.switchToHttp().getRequest<Request>())
  if (principal === undefined)
    throw new Error('没有当前用户：@CurrentPrincipal() 只能用在需要登录的接口上')
  return principal
})

/** 控制器的参数装饰器：`login(@SessionCookieJar() cookie: SessionCookie)`。 */
export const SessionCookieJar = createParamDecorator((_data: unknown, context: ExecutionContext): SessionCookie => {
  const cookie = (context.switchToHttp().getRequest<Request>() as AuthenticatedRequest)[SESSION_COOKIE]
  if (cookie === undefined)
    throw new Error('会话守卫没有挂上 Cookie 的读写：全局守卫是否注册？')
  return cookie
})

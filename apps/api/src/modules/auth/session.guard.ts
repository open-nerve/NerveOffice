import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Request, Response } from 'express'
import { Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppError } from '../../shared/errors/app-error.ts'
import { PUBLIC_ROUTE } from '../../shared/public.ts'
import { identifyRequestUser } from '../logging/index.ts'
import { UsersService } from '../users/index.ts'
import { attachPrincipal, attachSessionCookie } from './principal.ts'
import { SessionCookieSettings } from './session-cookie.ts'
import { csrfTokenFor } from './session-token.ts'
import { SessionService } from './session.service.ts'

/**
 * 认证（全局守卫，默认拒绝，P3 设计 §3.5）：除了标了 @Public() 的接口，都要求有效的会话。
 * - 没有会话 Cookie：UNAUTHENTICATED；
 * - 带着会话 Cookie，但会话无效（过期、撤销、账户不可用）：SESSION_EXPIRED，并清除 Cookie。
 * 守卫排在处理器的在途计数之前：这里的数据库访问要短（按摘要与主键各查一次，P2 交接单）。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly cookie: SessionCookieSettings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()
    attachSessionCookie(request, response, this.cookie)
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]) === true)
      return true

    if (!this.cookie.isPresent(request.headers.cookie))
      throw new AppError('UNAUTHENTICATED')
    const token = this.cookie.read(request.headers.cookie)
    const session = token === undefined ? undefined : await this.sessions.authenticate(token)
    const user = session === undefined ? undefined : await this.users.findActiveById(session.userId)
    if (token === undefined || session === undefined || user === undefined) {
      this.cookie.clear(response)
      throw new AppError('SESSION_EXPIRED')
    }
    attachPrincipal(request, { user, sessionId: session.id, csrfToken: csrfTokenFor(token) })
    identifyRequestUser(request, user.id)
    return true
  }
}

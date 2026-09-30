import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { AuthenticatedSession } from './session.service.ts'
import { Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppError } from '../../shared/errors/app-error.ts'
import { PUBLIC_ROUTE } from '../../shared/public.ts'
import { SYSTEM_ADMIN_ROUTE } from '../../shared/system-admin-only.ts'
import { identifyRequestUser } from '../logging/index.ts'
import { UsersService } from '../users/index.ts'
import { attachPrincipal, attachSessionCookie } from './principal.ts'
import { SessionCookieSettings } from './session-cookie.ts'
import { csrfTokenFor } from './session-token.ts'
import { SessionService } from './session.service.ts'

/**
 * 认证（全局守卫，默认拒绝，P3 设计 §3.5）：除了标了 @Public() 的接口，都要求有效的会话。
 * - 没有会话 Cookie：UNAUTHENTICATED；
 * - 带着会话 Cookie，但会话无效（过期、撤销、账户不可用）：SESSION_EXPIRED，并清除 Cookie；账户不可用时会话一并撤销。
 *   例外（复验 N3）：会话是因为换令牌（修改密码、同一个浏览器重新登录）而撤销的，仍回 SESSION_EXPIRED，但不清除 Cookie：
 *   换令牌之前发出、之后才处理的请求，响应晚于新的 Cookie 到达时，清除会把新的删掉，本人随即掉线；
 * - 标了 @SystemAdminOnly() 的接口，登录的不是系统管理员：PERMISSION_DENIED（M2-P1）。
 * 守卫排在处理器的在途计数之前：这里的数据库访问要短（按摘要与主键各查一次，间隔超过 1 分钟时顺延一次，P2 交接单；
 * 会话无效时另按摘要查一次撤销的原因，这条路径本来就少见）。
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
      // 会话还在、账户却不可用（停用）：撤销它，不顺延，启用之后它也不能再用（M2-P1 审查 A1 的纵深防御）
      if (session !== undefined)
        await this.sessions.revoke(session.id, 'disabled')
      if (!await this.rotatedAway(token, session))
        this.cookie.clear(response)
      throw new AppError('SESSION_EXPIRED')
    }
    await this.sessions.keepAlive(session)
    attachPrincipal(request, { user, sessionId: session.id, csrfToken: csrfTokenFor(token) })
    identifyRequestUser(request, user.id)
    // 只给系统管理员的接口（M2-P1 设计 §3.1）：系统角色每个请求重新读取，取消之后下一次请求就被拒绝
    if (this.reflector.getAllAndOverride<boolean | undefined>(SYSTEM_ADMIN_ROUTE, [context.getHandler(), context.getClass()]) === true && user.systemRole !== 'admin')
      throw new AppError('PERMISSION_DENIED')
    return true
  }

  /**
   * 带来的令牌是不是因为换令牌而失效的（复验 N3）：只在找不到有效的会话时问（令牌格式不对、账户不可用时都不问）。
   * 是的话这个浏览器多半已经拿到了新的 Cookie，不清除
   */
  private async rotatedAway(token: string | undefined, session: AuthenticatedSession | undefined): Promise<boolean> {
    return token !== undefined && session === undefined && await this.sessions.invalidatedByRotation(token)
  }
}

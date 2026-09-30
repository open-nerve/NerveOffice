import type { ChangePasswordRequest, LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal, SessionCookie } from './principal.ts'
import { changePasswordRequestSchema, loginRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { Public } from '../../shared/public.ts'
import { RequestOrigin } from '../audit/index.ts'
import { AuthService } from './auth.service.ts'
import { CurrentPrincipal, SessionCookieJar } from './principal.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 登录、退出与当前会话（P3 设计 §3.3）。 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginRequestSchema }) body: LoginRequest,
    @RequestOrigin() origin: HttpOrigin,
    @SessionCookieJar() cookie: SessionCookie,
  ): Promise<SessionResponse> {
    const result = await this.auth.login(body, origin, cookie.token)
    cookie.write(result.token)
    return result.session
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @RequestOrigin() origin: HttpOrigin,
    @SessionCookieJar() cookie: SessionCookie,
  ): Promise<void> {
    const outcome = await this.auth.logout(principal, cookie.token, origin)
    // 会话在认证之后已经结束（M2-P6）：换了令牌时不清除 Cookie——这个浏览器已经拿到了新的，清除会把它删掉（与会话守卫的例外相同）
    if (outcome !== 'rotated')
      cookie.clear()
    if (outcome !== 'ended')
      throw new AppError('SESSION_EXPIRED')
  }

  @Get('session')
  async session(@CurrentPrincipal() principal: Principal): Promise<SessionResponse> {
    return this.auth.current(principal)
  }

  /**
   * 修改密码（M2-P1 设计 §3.5）：本人的全部会话撤销（包括当前这个），当前页面换成新的会话——写回新的 Cookie，
   * 响应与登录相同，带着新的 CSRF 令牌（M2-P6 复核 B1）。页面照常可用，旧的会话令牌从此无效。
   */
  @Put('password')
  @HttpCode(200)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: changePasswordRequestSchema }) body: ChangePasswordRequest,
    @RequestOrigin() origin: HttpOrigin,
    @SessionCookieJar() cookie: SessionCookie,
  ): Promise<SessionResponse> {
    const result = await this.auth.changePassword(principal, body, origin)
    cookie.write(result.token)
    return result.session
  }
}

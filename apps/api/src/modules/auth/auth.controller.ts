import type { ChangePasswordRequest, LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal, SessionCookie } from './principal.ts'
import { changePasswordRequestSchema, loginRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common'
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
    await this.auth.logout(principal, origin)
    cookie.clear()
  }

  @Get('session')
  async session(@CurrentPrincipal() principal: Principal): Promise<SessionResponse> {
    return this.auth.current(principal)
  }

  /** 修改密码（M2-P1 设计 §3.5）：本人其他地方的登录全部退出，当前会话保留，Cookie 不变。 */
  @Put('password')
  @HttpCode(204)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: changePasswordRequestSchema }) body: ChangePasswordRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<void> {
    await this.auth.changePassword(principal, body, origin)
  }
}

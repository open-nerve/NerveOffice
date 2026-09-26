import type { LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal, SessionCookie } from './principal.ts'
import { loginRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
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
}

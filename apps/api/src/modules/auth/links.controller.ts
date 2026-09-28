import type { AcceptInvitationRequest, CompletePasswordResetRequest, InspectLinkRequest, InspectLinkResponse, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { SessionCookie } from './principal.ts'
import { acceptInvitationRequestSchema, completePasswordResetRequestSchema, inspectLinkRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Public } from '../../shared/public.ts'
import { RequestOrigin } from '../audit/index.ts'
import { AuthService } from './auth.service.ts'
import { InvitationsService } from './invitations.service.ts'
import { PasswordResetsService } from './password-resets.service.ts'
import { SessionCookieJar } from './principal.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 一次性链接的公开接口（M2-P1 设计 §3.3、§3.4）：邀请注册与重置密码。不需要登录，状态变更照样检查 Origin（CSRF 守卫）。
 * 令牌在请求体里：页面从链接的 # 部分读出，不经请求行，不进访问日志。成功接受或完成之后已登录，响应与登录相同。
 */
@Controller('auth')
@Public()
export class LinksController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly resets: PasswordResetsService,
    private readonly auth: AuthService,
  ) {}

  @Post('invitations/inspect')
  @HttpCode(200)
  async inspectInvitation(@Body({ schema: inspectLinkRequestSchema }) body: InspectLinkRequest, @RequestOrigin() origin: HttpOrigin): Promise<InspectLinkResponse> {
    return this.invitations.inspect(body.token, origin)
  }

  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(
    @Body({ schema: acceptInvitationRequestSchema }) body: AcceptInvitationRequest,
    @RequestOrigin() origin: HttpOrigin,
    @SessionCookieJar() cookie: SessionCookie,
  ): Promise<SessionResponse> {
    const accepted = await this.invitations.accept(body.token, body, origin, cookie.token)
    cookie.write(accepted.sessionToken)
    return this.auth.sessionResponseFor(accepted.user, accepted.sessionToken)
  }

  @Post('password-resets/inspect')
  @HttpCode(200)
  async inspectPasswordReset(@Body({ schema: inspectLinkRequestSchema }) body: InspectLinkRequest, @RequestOrigin() origin: HttpOrigin): Promise<InspectLinkResponse> {
    return this.resets.inspect(body.token, origin)
  }

  @Post('password-resets/complete')
  @HttpCode(200)
  async completePasswordReset(
    @Body({ schema: completePasswordResetRequestSchema }) body: CompletePasswordResetRequest,
    @RequestOrigin() origin: HttpOrigin,
    @SessionCookieJar() cookie: SessionCookie,
  ): Promise<SessionResponse> {
    const completed = await this.resets.complete(body.token, body, origin, cookie.token)
    cookie.write(completed.sessionToken)
    return this.auth.sessionResponseFor(completed.user, completed.sessionToken)
  }
}

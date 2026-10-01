import type { AppConfig } from '../config/index.ts'
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { UsersModule } from '../users/index.ts'
import { AuthController } from './auth.controller.ts'
import { AuthService } from './auth.service.ts'
import { CsrfGuard } from './csrf.guard.ts'
import { InvitationsRepository } from './invitations.repository.ts'
import { InvitationsService } from './invitations.service.ts'
import { LinkAttempts } from './link-attempts.ts'
import { LinksController } from './links.controller.ts'
import { LoginLockouts } from './login-lockouts.ts'
import { LoginThrottleRepository } from './login-throttle.repository.ts'
import { LinkThrottle, LoginThrottle } from './login-throttle.ts'
import { PasswordResetsRepository } from './password-resets.repository.ts'
import { PasswordResetsService } from './password-resets.service.ts'
import { SessionCookieSettings } from './session-cookie.ts'
import { SessionResponses } from './session-response.ts'
import { SessionGuard } from './session.guard.ts'
import { SessionService } from './session.service.ts'
import { SessionsRepository } from './sessions.repository.ts'

/**
 * 认证（P3 设计 §3.5；M2-P1 加上修改密码与一次性链接）。两个守卫由 app 层注册为全局守卫（APP_GUARD），顺序：先认证，再 CSRF 与 Origin。
 * 导出给 admin 模块：撤销会话（停用账户）、签发与作废邀请和重置（M2-P1 设计 §3.1）、登录锁定的查询与解除（M2-P6 复核 A1）。
 */
@Module({
  imports: [DatabaseModule, UsersModule, SpacesModule, AuditModule],
  controllers: [AuthController, LinksController],
  providers: [
    SessionsRepository,
    SessionService,
    LoginThrottleRepository,
    LoginThrottle,
    LoginLockouts,
    LinkThrottle,
    LinkAttempts,
    InvitationsRepository,
    InvitationsService,
    PasswordResetsRepository,
    PasswordResetsService,
    SessionResponses,
    AuthService,
    SessionGuard,
    CsrfGuard,
    {
      provide: SessionCookieSettings,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new SessionCookieSettings(config.http.publicOrigin, config.session.absoluteTimeoutMinutes * 60_000),
    },
  ],
  exports: [SessionGuard, CsrfGuard, SessionService, InvitationsService, PasswordResetsService, LoginLockouts],
})
export class AuthModule {}

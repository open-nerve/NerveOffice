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
import { LoginThrottleRepository } from './login-throttle.repository.ts'
import { LoginThrottle } from './login-throttle.ts'
import { SessionCookieSettings } from './session-cookie.ts'
import { SessionGuard } from './session.guard.ts'
import { SessionService } from './session.service.ts'
import { SessionsRepository } from './sessions.repository.ts'

/** 认证（P3 设计 §3.5）。两个守卫由 app 层注册为全局守卫（APP_GUARD），顺序：先认证，再 CSRF 与 Origin。 */
@Module({
  imports: [DatabaseModule, UsersModule, SpacesModule, AuditModule],
  controllers: [AuthController],
  providers: [
    SessionsRepository,
    SessionService,
    LoginThrottleRepository,
    LoginThrottle,
    AuthService,
    SessionGuard,
    CsrfGuard,
    {
      provide: SessionCookieSettings,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new SessionCookieSettings(config.http.publicOrigin, config.session.absoluteTimeoutMinutes * 60_000),
    },
  ],
  exports: [SessionGuard, CsrfGuard],
})
export class AuthModule {}

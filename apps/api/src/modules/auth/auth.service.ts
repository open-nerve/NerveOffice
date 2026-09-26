import type { LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { User } from '../users/index.ts'
import type { Principal } from './principal.ts'
import { normalizeUsername } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'
import { LoginThrottle } from './login-throttle.ts'
import { csrfTokenFor } from './session-token.ts'
import { SessionService } from './session.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

export interface LoginResult {
  /** 只交给 Cookie */
  readonly token: string
  readonly session: SessionResponse
}

/** 登录、退出与当前会话（P3 设计 §3.5）。 */
@Injectable()
export class AuthService {
  readonly #logger: AppLogger

  constructor(
    private readonly users: UsersService,
    private readonly spaces: SpacesService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottle,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'auth' })
  }

  /**
   * 登录：先查限流，再验证（事务外：哈希是计算密集的操作），最后在一个事务里写会话、限流计数与审计。
   * previousToken 是浏览器原来带着的会话，登录成功后作废。
   */
  async login(request: LoginRequest, origin: HttpOrigin, previousToken?: string): Promise<LoginResult> {
    const attempt = { username: normalizeUsername(request.username), clientIp: origin.clientIp }
    const lockedFor = await this.throttle.lockedFor(attempt)
    if (lockedFor !== undefined) {
      // 锁定期间的请求只记日志，不写审计：攻击时不能把审计表写爆
      this.#logger.warn('登录被限流拒绝', { lockedForSeconds: lockedFor })
      throw this.tooManyAttempts(lockedFor)
    }

    const check = await this.users.verifyCredentials(request.username, request.password)
    if (!check.valid) {
      const lockedNow = await this.transactions.run(async (transaction) => {
        const seconds = await this.throttle.recordFailure(attempt, transaction)
        await this.audit.record({
          action: 'auth.login_failed',
          actor: { type: 'anonymous' },
          ...(check.user === undefined ? {} : { target: { type: 'user' as const, id: check.user.id } }),
          origin,
          details: { reason: 'invalid_credentials', ...(seconds === undefined ? {} : { lockedForSeconds: seconds }) },
        }, { transaction })
        return seconds
      })
      throw lockedNow === undefined ? new AppError('INVALID_CREDENTIALS') : this.tooManyAttempts(lockedNow)
    }

    const { user } = check
    const created = await this.transactions.run(async (transaction) => {
      await this.throttle.succeeded(attempt, transaction)
      if (previousToken !== undefined)
        await this.sessions.replace(previousToken, transaction)
      const session = await this.sessions.create(user.id, transaction)
      await this.audit.record({
        action: 'auth.login_succeeded',
        actor: { type: 'user', id: user.id },
        target: { type: 'user', id: user.id },
        origin,
      }, { transaction })
      return session
    })
    return { token: created.token, session: await this.describe(user, csrfTokenFor(created.token)) }
  }

  async logout(principal: Principal, origin: HttpOrigin): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.sessions.revoke(principal.sessionId, 'logout', transaction)
      await this.audit.record({ action: 'auth.logout', actor: { type: 'user', id: principal.user.id }, origin }, { transaction })
    })
  }

  async current(principal: Principal): Promise<SessionResponse> {
    return this.describe(principal.user, principal.csrfToken)
  }

  private async describe(user: User, csrfToken: string): Promise<SessionResponse> {
    const space = await this.spaces.personalSpaceOf(user.id)
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${user.id}`)
    return {
      user: { id: user.id, username: user.username, displayName: user.displayName, systemRole: user.systemRole },
      personalSpace: { id: space.id, name: space.name },
      csrfToken,
    }
  }

  private tooManyAttempts(seconds: number): AppError {
    return new AppError('TOO_MANY_ATTEMPTS', undefined, { headers: { 'Retry-After': String(Math.max(1, seconds)) } })
  }
}

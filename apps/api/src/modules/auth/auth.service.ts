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
   * 登录：
   * 1. 限流放行：先占用名额，再验证（LoginThrottle）；
   * 2. 验证用户名与密码，在事务之外：哈希是计算密集的操作；
   * 3. 失败时写审计；成功时在一个事务里清除限流计数、作废浏览器原来的会话、新建会话、写审计；
   * 4. 在事务之外顺带清理过期的记录。
   * previousToken 是浏览器原来带着的会话，登录成功后作废。
   */
  async login(request: LoginRequest, origin: HttpOrigin, previousToken?: string): Promise<LoginResult> {
    const admission = await this.throttle.admit({ username: normalizeUsername(request.username), clientIp: origin.clientIp })
    if (!admission.admitted) {
      // 锁定期间的请求只记日志，不写审计：攻击时不能把审计表写爆
      this.#logger.warn('登录被限流拒绝', { lockedForSeconds: admission.retryAfterSeconds })
      throw this.tooManyAttempts(admission.retryAfterSeconds)
    }

    const { ticket } = admission
    // 验证出错（例如库里的哈希损坏）时名额不退回，按一次失败计
    const check = await this.users.verifyCredentials(request.username, request.password)
    if (!check.valid) {
      await this.audit.record({
        action: 'auth.login_failed',
        actor: { type: 'anonymous' },
        ...(check.user === undefined ? {} : { target: { type: 'user' as const, id: check.user.id } }),
        origin,
        details: { reason: 'invalid_credentials', ...(ticket.lockedForSeconds === undefined ? {} : { lockedForSeconds: ticket.lockedForSeconds }) },
      })
      await this.tidyUp()
      throw ticket.lockedForSeconds === undefined ? new AppError('INVALID_CREDENTIALS') : this.tooManyAttempts(ticket.lockedForSeconds)
    }

    const { user } = check
    const created = await this.transactions.run(async (transaction) => {
      await ticket.succeeded(transaction)
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
    await this.tidyUp()
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

  /**
   * 验证过密码之后，顺带删除一小批过期的限流计数与会话。
   * 在事务之外，尽力执行：失败只记日志，不影响这次登录的结果（P3 审查 A2）。
   */
  private async tidyUp(): Promise<void> {
    try {
      await this.throttle.purgeExpired()
      await this.sessions.purgeExpired()
    }
    catch (error) {
      this.#logger.warn('清理过期的登录限流计数与会话失败，下次登录时再试', { err: error })
    }
  }

  private tooManyAttempts(seconds: number): AppError {
    return new AppError('TOO_MANY_ATTEMPTS', undefined, { headers: { 'Retry-After': String(Math.max(1, seconds)) } })
  }
}

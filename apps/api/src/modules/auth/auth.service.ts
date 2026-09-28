import type { ChangePasswordRequest, LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { CredentialCheck, User } from '../users/index.ts'
import type { LoginTicket } from './login-throttle.ts'
import type { Principal } from './principal.ts'
import { normalizeUsername } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { PasswordHashingBusyError, UsersService } from '../users/index.ts'
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
   * 2. 验证用户名与密码，在事务之外：哈希是计算密集的操作；等待哈希的请求太多时返回 503（verify）；
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
    const check = await this.verify(request, ticket)
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

  /**
   * 验证用户名与密码。等待哈希的请求太多时（登录洪水，DEF-015）没有验证：退回名额，返回 503 与 Retry-After，
   * 与限流拒绝一样只记日志、不写审计。其他错误（例如库里的哈希损坏）原样抛出，名额不退回，按一次失败计。
   */
  private async verify(request: LoginRequest, ticket: LoginTicket): Promise<CredentialCheck> {
    return this.withHashing(ticket, async () => this.users.verifyCredentials(request.username, request.password))
  }

  /**
   * 执行要用密码哈希的一步（验证或计算新哈希）。等待哈希的请求太多时（DEF-015）：退回名额，返回 503 与 Retry-After，
   * 只记日志、不写审计。其他错误原样抛出，名额不退回，按一次失败计。
   */
  private async withHashing<T>(ticket: LoginTicket, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    }
    catch (error) {
      if (!(error instanceof PasswordHashingBusyError))
        throw error
      // 退回名额失败（例如数据库出错）只记日志：这次按一次失败计，回应仍是"服务繁忙"（审查 A11）
      await ticket.abandoned().catch((releaseError: unknown) => {
        this.#logger.warn('退回登录限流的名额失败，这次尝试按一次失败计', { err: releaseError })
      })
      this.#logger.warn('等待密码哈希的请求太多，拒绝这次请求', { retryAfterSeconds: error.retryAfterSeconds })
      throw new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error, headers: { 'Retry-After': String(error.retryAfterSeconds) } })
    }
  }

  /**
   * 修改密码（M2-P1 设计 §3.5，US-M2-02）：
   * 1. 按登录限流占名额（用户名与地址两个维度）：猜旧密码与猜登录密码按同一个计数，达到上限同样锁定登录；
   * 2. 按 id 验证旧密码，在事务之外（耗时补齐同登录）；新密码的哈希同样在事务之外；
   * 3. 在一个事务里：清除限流计数、更新哈希、撤销本人除当前会话以外的全部会话（原因 password_changed）、记审计。
   */
  async changePassword(principal: Principal, request: ChangePasswordRequest, origin: HttpOrigin): Promise<void> {
    const { user } = principal
    const admission = await this.throttle.admit({ username: user.username, clientIp: origin.clientIp })
    if (!admission.admitted) {
      this.#logger.warn('修改密码被限流拒绝', { lockedForSeconds: admission.retryAfterSeconds })
      throw this.tooManyAttempts(admission.retryAfterSeconds)
    }
    const { ticket } = admission
    const valid = await this.withHashing(ticket, async () => this.users.verifyPasswordOf(user.id, request.currentPassword))
    if (!valid)
      throw ticket.lockedForSeconds === undefined ? new AppError('CURRENT_PASSWORD_INCORRECT') : this.tooManyAttempts(ticket.lockedForSeconds)
    const passwordHash = await this.withHashing(ticket, async () => this.users.hashPassword(request.newPassword))
    await this.transactions.run(async (transaction) => {
      await ticket.succeeded(transaction)
      await this.users.setPasswordHash(user.id, passwordHash, transaction)
      await this.sessions.revokeAllOf(user.id, 'password_changed', { except: principal.sessionId, transaction })
      await this.audit.record({ action: 'users.password_changed', actor: { type: 'user', id: user.id }, target: { type: 'user', id: user.id }, origin }, { transaction })
    })
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

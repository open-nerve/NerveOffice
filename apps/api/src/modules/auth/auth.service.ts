import type { ChangePasswordRequest, LoginRequest, SessionResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { CredentialCheck, User } from '../users/index.ts'
import type { LoginTicket } from './login-throttle.ts'
import type { Principal } from './principal.ts'
import type { LoginResult } from './session-response.ts'
import { normalizeUsername } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { UsersService } from '../users/index.ts'
import { releasingIfBusy, settleQuietly, tooManyAttempts } from './attempt-errors.ts'
import { LoginThrottle } from './login-throttle.ts'
import { SessionResponses } from './session-response.ts'
import { SessionService } from './session.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 退出的结果（M2-P6）：ended——这次结束了会话；认证通过之后、撤销之前会话已经结束时，rotated——同一个浏览器刚修改了密码
 * 或重新登录，换成了新的会话（控制器不清除 Cookie，前端确认之后带新令牌再退出一次）；gone——别的原因（另一个标签页先退出了等）
 */
export type LogoutOutcome = 'ended' | 'rotated' | 'gone'

/**
 * 修改密码的事务里发现当前的会话已经结束（M2-P6）：回滚用，事务之外退回名额之后照原样抛出（"登录已过期"）。
 * 是 AppError：事务运行器只把以 AppError 结束的事务的连接放回池里，别的错误会丢弃连接（第三轮复验 一般-A）
 */
class SessionEndedDuringRequest extends AppError {
  constructor() {
    super('SESSION_EXPIRED')
  }
}

/**
 * 登录、修改密码的事务里复核凭据不通过（验证之后改了密码、签发或完成了重置、停用了，M2-P1 审查 A1、复验 N6）：回滚用。
 * 这个事务什么也没改，回滚而不是提交：不留下一次提交，之后写失败的审计时遇到数据库繁忙，回答的仍是确定的 503（M2-P6 第 3 片复验）。
 * 事务之外记审计、按凭据无效回答；是 AppError，理由同上
 */
class CredentialsChangedDuringRequest extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS')
  }
}

/**
 * 登录、退出与当前会话（P3 设计 §3.5）。
 * 新建会话的写操作在业务事务里拼好响应（SessionResponses），提交之后只剩写 Cookie 与尽力而为的顺带清理，不再有会失败的数据库访问：
 * 否则提交之后那一步遇到数据库繁忙，写入已经生效（会话建了、密码换了），客户端却收不到新的令牌（M2-P6 第 3 片复验）
 */
@Injectable()
export class AuthService {
  readonly #logger: AppLogger

  constructor(
    private readonly users: UsersService,
    private readonly responses: SessionResponses,
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
   * 2. 验证用户名与密码，在事务之外：哈希是计算密集的操作；等待哈希的请求太多、读凭据时数据库繁忙，都还没有比对，退回名额、回 503（verify）；
   * 3. 失败时写审计；成功时在一个事务里：先锁住账户行复核凭据（M2-P1 审查 A1），再清除限流计数、作废浏览器原来的会话、
   *    新建会话、写审计、拼好响应。复核不通过（验证之后改了密码、签发或完成了重置、停用了）回滚，按凭据无效处理；
   *    这个事务里遇到数据库繁忙时密码已经确认是对的，退回名额（M2-P6 第 3 片复验 建议 1）；
   * 4. 在事务之外顺带清理过期的记录（尽力而为，失败只记日志）。
   * previousToken 是浏览器原来带着的会话，登录成功后作废。
   * 事务里锁的顺序与其他改动账户的事务相同：账户行、限流计数（账户 → 账户与地址 → 地址，M2-P6 复核 A1）、会话（ADR-007，审查 A2）。
   */
  async login(request: LoginRequest, origin: HttpOrigin, previousToken?: string): Promise<LoginResult> {
    const admission = await this.throttle.admit({ username: normalizeUsername(request.username), clientIp: origin.clientIp })
    if (!admission.admitted) {
      // 锁定期间的请求只记日志，不写审计：攻击时不能把审计表写爆
      this.#logger.warn('登录被限流拒绝', { lockedForSeconds: admission.retryAfterSeconds })
      throw tooManyAttempts(admission.retryAfterSeconds)
    }

    const { ticket } = admission
    const check = await this.verify(request, ticket)
    if (!check.valid)
      throw await this.loginFailed(ticket, check.user, 'invalid_credentials', origin)

    const { credentials } = check
    const { user } = credentials
    let result: LoginResult
    try {
      result = await releasingIfBusy(ticket, this.#logger, async () => this.transactions.run(async (transaction) => {
        if (!await this.users.holdCredentials(credentials, transaction))
          throw new CredentialsChangedDuringRequest()
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
        return this.responses.forNewSession(user, session.token, transaction)
      }))
    }
    catch (error) {
      if (error instanceof CredentialsChangedDuringRequest)
        throw await this.loginFailed(ticket, user, 'credentials_changed', origin)
      throw error
    }
    await this.tidyUp()
    return result
  }

  /**
   * 登录失败：写审计（账户存在时带上对象）、顺带清理，返回要抛出的错误：这次失败使计数达到上限时 429，
   * 否则 INVALID_CREDENTIALS。原因：密码不对（invalid_credentials），或者验证之后凭据变了（credentials_changed：
   * 改了密码、签发或完成了重置、停用了，复验 N6）；对用户都是"用户名或密码错误"，审计里分开，管理员查得到。
   * 名额照样计一次失败：写审计时遇到数据库繁忙（503）也不退回，谁也不能借繁忙多猜一次（M2-P6 第 3 片复验 建议 1）
   */
  private async loginFailed(ticket: LoginTicket, user: User | undefined, reason: 'invalid_credentials' | 'credentials_changed', origin: HttpOrigin): Promise<AppError> {
    await this.audit.record({
      action: 'auth.login_failed',
      actor: { type: 'anonymous' },
      ...(user === undefined ? {} : { target: { type: 'user' as const, id: user.id } }),
      origin,
      details: { reason, ...(ticket.lockedForSeconds === undefined ? {} : { lockedForSeconds: ticket.lockedForSeconds }) },
    })
    await this.tidyUp()
    return ticket.lockedForSeconds === undefined ? new AppError('INVALID_CREDENTIALS') : tooManyAttempts(ticket.lockedForSeconds)
  }

  /**
   * 验证用户名与密码。还没有比对就失败时退回名额（releasingIfBusy）：等待哈希的请求太多（DEF-015）时 503 与 Retry-After，
   * 与限流拒绝一样只记日志、不写审计；读凭据时数据库繁忙同样退回（UsersService.verifyCredentials 只在比对之前读库）。
   * 其他错误（例如库里的哈希损坏）原样抛出，名额不退回，按一次失败计。
   */
  private async verify(request: LoginRequest, ticket: LoginTicket): Promise<CredentialCheck> {
    return releasingIfBusy(ticket, this.#logger, async () => this.users.verifyCredentials(request.username, request.password))
  }

  /**
   * 修改密码（M2-P1 设计 §3.5，US-M2-02）：
   * 1. 按登录限流占名额（账户、账户与这次请求的来源、来源三个维度，M2-P6 复核 A1）：猜旧密码与猜登录密码按同一套计数，
   *    达到上限同样锁定登录；
   * 2. 按 id 验证旧密码，在事务之外（失败时的计算同登录，ADR-007）；新密码的哈希同样在事务之外；
   * 3. 在一个事务里：锁住账户行，复核旧密码验证之后没有被改过（审查 A1、A2），更新哈希、清除限流计数、
   *    撤销本人的全部会话（**包括当前这个**：当前这条按 replaced——它换成了新的；别的设备上的按 password_changed，
   *    M2-P6 复验 一般-3，见 SessionService.revokeForPasswordChange）、为当前页面新建一个会话、记审计、拼好响应。
   * 当前的会话令牌也换掉（M2-P6 复核 B1）：偷到 Cookie 的人不能在本人改完密码之后接着用；当前页面拿到新令牌
   * （控制器写回 Cookie，响应里有新的 CSRF 令牌），仍然保持登录，与接受邀请、完成重置同一个做法。
   * 旧密码不对、复核不通过（回滚），都记审计 users.password_change_failed（审查 A6）。审计 users.password_changed 不带明细：
   * 会话怎么撤销的记在 auth_sessions.revoked_reason 上。
   * 当前的会话在认证之后、事务之前已经结束（同一个浏览器里刚退出，或者刚重新登录换成了新的会话，M2-P6）：不改密码、不新建会话，
   * 回滚之后按"登录已过期"回答，占的名额退回（不是猜错）——不能替已经退出的人重新登录，也不能在另一条会话之下改密码。
   * 比对旧密码之前、确认旧密码是对的之后遇到繁忙（等待哈希、数据库），名额都退回（M2-P6 第 3 片复验 建议 1）
   */
  async changePassword(principal: Principal, request: ChangePasswordRequest, origin: HttpOrigin): Promise<LoginResult> {
    const { user } = principal
    const admission = await this.throttle.admit({ username: user.username, clientIp: origin.clientIp })
    if (!admission.admitted) {
      this.#logger.warn('修改密码被限流拒绝', { lockedForSeconds: admission.retryAfterSeconds })
      throw tooManyAttempts(admission.retryAfterSeconds)
    }
    const { ticket } = admission
    const credentials = await releasingIfBusy(ticket, this.#logger, async () => this.users.verifyPasswordOf(user.id, request.currentPassword))
    if (credentials === undefined)
      throw await this.passwordChangeFailed(ticket, user, 'current_password_incorrect', origin)
    const passwordHash = await releasingIfBusy(ticket, this.#logger, async () => this.users.hashPassword(request.newPassword))
    try {
      return await releasingIfBusy(ticket, this.#logger, async () => this.transactions.run(async (transaction) => {
        if (!await this.users.replacePassword(credentials, passwordHash, transaction))
          throw new CredentialsChangedDuringRequest()
        // 限流计数在会话行之前（ADR-007 的锁顺序）；下面回滚时这一步一并撤回
        await ticket.succeeded(transaction)
        if (!await this.sessions.revokeForPasswordChange(user.id, principal.sessionId, transaction))
          throw new SessionEndedDuringRequest()
        const session = await this.sessions.create(user.id, transaction)
        await this.audit.record({ action: 'users.password_changed', actor: { type: 'user', id: user.id }, target: { type: 'user', id: user.id }, origin }, { transaction })
        return this.responses.forNewSession(user, session.token, transaction)
      }))
    }
    catch (error) {
      if (error instanceof SessionEndedDuringRequest)
        await settleQuietly(async () => ticket.abandoned(), this.#logger)
      if (error instanceof CredentialsChangedDuringRequest)
        throw await this.passwordChangeFailed(ticket, user, 'credentials_changed', origin)
      throw error
    }
  }

  /**
   * 修改密码失败：记审计，返回要抛出的错误。原因：旧密码不对（current_password_incorrect），或者验证之后凭据变了
   * （credentials_changed：别处改了密码、签发了重置、停用了，复验 N6）；对用户都是"当前密码不正确"。
   * 与登录共用同一套计数，这次失败使计数达到上限时是 429，details 带锁定秒数：管理员能从审计里查到这个人为什么登录不了（审查 A6）。
   * 名额照样计一次失败，写审计时遇到数据库繁忙也不退回（同 loginFailed）
   */
  private async passwordChangeFailed(ticket: LoginTicket, user: User, reason: 'current_password_incorrect' | 'credentials_changed', origin: HttpOrigin): Promise<AppError> {
    await this.audit.record({
      action: 'users.password_change_failed',
      actor: { type: 'user', id: user.id },
      target: { type: 'user', id: user.id },
      origin,
      details: { reason, ...(ticket.lockedForSeconds === undefined ? {} : { lockedForSeconds: ticket.lockedForSeconds }) },
    })
    return ticket.lockedForSeconds === undefined ? new AppError('CURRENT_PASSWORD_INCORRECT') : tooManyAttempts(ticket.lockedForSeconds)
  }

  /**
   * 退出：撤销这条会话、记审计。认证通过之后、撤销之前这条会话已经结束时不记审计，按原因回答（LogoutOutcome，M2-P6）：
   * 同一个浏览器刚修改了密码或重新登录时，退出的请求带的是换令牌之前的旧令牌，新会话还在——由前端确认之后带新令牌再退出一次。
   * 原因在同一个事务里问：提交之后不再访问数据库（M2-P6 第 3 片复验）
   */
  async logout(principal: Principal, sessionToken: string | undefined, origin: HttpOrigin): Promise<LogoutOutcome> {
    return this.transactions.run(async (transaction) => {
      if (await this.sessions.revoke(principal.sessionId, 'logout', transaction)) {
        await this.audit.record({ action: 'auth.logout', actor: { type: 'user', id: principal.user.id }, origin }, { transaction })
        return 'ended'
      }
      return sessionToken !== undefined && await this.sessions.invalidatedByRotation(sessionToken, transaction) ? 'rotated' : 'gone'
    })
  }

  async current(principal: Principal): Promise<SessionResponse> {
    return this.responses.describe(principal.user, principal.csrfToken)
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
}

import type { AuditDetailsOf, CompletePasswordResetRequest, InspectLinkResponse, IssuedPasswordReset, LinkIssuerRevocationReason } from '@nerve-office/contracts'
import type { AuditEvent, AuditOrigin } from '../audit/index.ts'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { User } from '../users/index.ts'
import type { LinkLookup } from './link-state.ts'
import type { PasswordResetRecord } from './password-resets.repository.ts'
import type { LoginResult } from './session-response.ts'
import { oneTimeLinkUrl, PASSWORD_RESET_LIFETIME_HOURS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { PasswordHashingBusyError, UsersService } from '../users/index.ts'
import { hashingBusy, releasingIfBusy, settleQuietly } from './attempt-errors.ts'
import { LinkAttempts } from './link-attempts.ts'
import { LinkUnusableDuringRequest, rejectionOf, usabilityOf } from './link-state.ts'
import { generateLinkToken, linkTokenDigest } from './link-token.ts'
import { LoginLockouts } from './login-lockouts.ts'
import { PasswordResetsRepository } from './password-resets.repository.ts'
import { SessionResponses } from './session-response.ts'
import { SessionService } from './session.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

function stateOf(record: PasswordResetRecord) {
  return { completedAt: record.usedAt, revokedAt: record.revokedAt, expired: record.expired }
}

/**
 * 重置密码（M2-P1 设计 §3.4，US-M2-03）：系统管理员（或运维命令）为某个账户签发一次性链接，签发时当前密码随即失效、
 * 撤销这个人的全部会话（审查 A7）；本人打开链接设置新密码，完成时再撤销一次全部会话，并以新密码登录。
 * 签发与完成的事务都先锁账户行、在锁里复核账户有效，再动重置与会话的行（统一的锁顺序，审查 A2）。
 */
@Injectable()
export class PasswordResetsService {
  readonly #logger: AppLogger

  constructor(
    private readonly repository: PasswordResetsRepository,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly responses: SessionResponses,
    private readonly attempts: LinkAttempts,
    private readonly lockouts: LoginLockouts,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'auth' })
  }

  /**
   * 签发：账户不存在 NOT_FOUND，已停用 ACCOUNT_DISABLED。一个事务里：复核操作者（系统管理员签发时，复验 N3）、
   * 锁住账户行并复核、作废这个账户未用的旧重置（记审计，M2-P6 复核 C3）、新建、把密码换成不可用的哈希（旧密码随即失效，审查 A7）、
   * 撤销全部会话（原因 password_reset）、记审计。并发的签发在账户行上排队，后一个作废前一个（审查 A2）。
   * actor 是签发的系统管理员，运维命令签发时是系统
   */
  async issue(actor: AuditEvent['actor'], userId: string, origin: AuditOrigin): Promise<IssuedPasswordReset> {
    // 先查一次：账户不存在或已停用时不必算哈希。事务里在锁内再复核
    requireIssuable(await this.users.findById(userId))
    const token = generateLinkToken()
    const digest = linkTokenDigest(token)
    if (digest === undefined)
      throw new Error('生成的令牌格式不对')
    const unusableHash = await this.unusablePasswordHash()
    const record = await this.transactions.run(async (transaction) => {
      if (actor.type === 'user')
        await this.users.lockActingAdmin(actor.id, transaction)
      requireIssuable(await this.users.lockAccount(userId, transaction))
      await this.revokeOpen(actor, userId, 'reissued', origin, transaction)
      const created = await this.repository.insert({
        userId,
        tokenHash: digest,
        createdBy: actor.type === 'user' ? actor.id : undefined,
        lifetimeHours: PASSWORD_RESET_LIFETIME_HOURS,
      }, transaction)
      await this.users.resetPassword(userId, unusableHash, transaction)
      await this.sessions.revokeAllOf(userId, 'password_reset', { transaction })
      await this.audit.record({
        action: 'users.password_reset_issued',
        actor,
        target: { type: 'user', id: userId },
        origin,
        details: { passwordResetId: created.id },
      }, { transaction })
      return created
    })
    return { url: oneTimeLinkUrl(this.config.http.publicOrigin, 'password_reset', token), expiresAt: record.expiresAt.toISOString() }
  }

  /** 运维命令（§3.9）：按登录名签发，操作者是系统 */
  async issueForUsername(username: string): Promise<IssuedPasswordReset & { readonly userId: string }> {
    const account = await this.users.findByUsername(username)
    if (account === undefined)
      throw new AppError('NOT_FOUND')
    return { ...await this.issue({ type: 'system' }, account.id, { source: 'cli' }), userId: account.id }
  }

  /** 停用账户时（admin 模块在同一个事务里调用，已锁住账户行）：作废这个人未用的重置，记审计（M2-P6 复核 C3） */
  async revokeOpenOf(actor: AuditEvent['actor'], userId: string, origin: AuditOrigin, transaction: Transaction): Promise<void> {
    await this.revokeOpen(actor, userId, 'account_disabled', origin, transaction)
  }

  /**
   * 签发人离任时（M2-P6 复核 A2；admin 模块在停用、取消系统管理员的同一个事务里调用，已锁住签发人的账户行）：
   * 作废这个人签发给别人的、还没用的重置，每作废一条记一条 users.password_reset_revoked（对象是被重置的账户，明细带原因）。
   * 否则离任之后，他手里的链接在 24 小时内仍能用来设置别人的密码、以别人的身份登录。
   * 锁的顺序：签发人的账户行 → 重置行。完成重置是被重置者的账户行 → 重置行：两边只在重置行上相遇，不成环
   */
  async revokeIssuedBy(actor: AuditEvent['actor'], issuerId: string, reason: LinkIssuerRevocationReason, origin: AuditOrigin, transaction: Transaction): Promise<void> {
    for (const revoked of await this.repository.revokeOpenIssuedBy(issuerId, transaction)) {
      await this.audit.record({
        action: 'users.password_reset_revoked',
        actor,
        target: { type: 'user', id: revoked.userId },
        origin,
        details: { passwordResetId: revoked.id, reason },
      }, { transaction })
    }
  }

  /**
   * 作废这个账户未用的重置，每作废一条记一条 users.password_reset_revoked（对象是这个账户，明细是重置的 id 与原因），
   * 与邀请的作废同一个做法：签发与完成都记了，作废也要记，追溯链上才看得出旧链接是什么时候、因为什么失效的
   */
  private async revokeOpen(actor: AuditEvent['actor'], userId: string, reason: AuditDetailsOf<'users.password_reset_revoked'>['reason'], origin: AuditOrigin, transaction: Transaction): Promise<void> {
    for (const passwordResetId of await this.repository.revokeOpenOfUser(userId, transaction)) {
      await this.audit.record({
        action: 'users.password_reset_revoked',
        actor,
        target: { type: 'user', id: userId },
        origin,
        details: { passwordResetId, reason },
      }, { transaction })
    }
  }

  /**
   * 公开：用令牌查看，只给出登录名与显示名；账户已停用的按作废处理。查令牌时数据库繁忙：还不知道令牌对不对，退回名额；
   * 令牌可用时退回名额，尽力而为：查看是只读的，退回失败只记日志，照样给出结果（与邀请相同，M2-P6 第 3 片复验 建议 1）
   */
  async inspect(token: string, origin: HttpOrigin): Promise<InspectLinkResponse> {
    const ticket = await this.attempts.admit(origin)
    const found = await releasingIfBusy(ticket, this.#logger, async () => this.lookup(token))
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'password_reset', found.rejection, origin)
    const { record, user } = found.record
    await settleQuietly(async () => ticket.succeeded(), this.#logger)
    return { username: user.username, displayName: user.displayName, expiresAt: record.expiresAt.toISOString() }
  }

  /**
   * 公开：设置新密码。先查令牌再算哈希，都在事务之外；然后在一个事务里：先锁账户行、再锁重置行，复核账户仍然有效、
   * 重置仍然可用（审查 A2），退回限流的名额、更新密码、标记已使用、清掉这个账户的登录失败计数（M2-P6 复核 A1：本人已经用链接
   * 证明控制着这个账户，别人留下的锁定不能挡住他用新密码登录）、撤销这个人的全部会话、新建本次的会话、记审计、拼好响应（与登录相同）：
   * 提交之后不再访问数据库，控制器随后才写 Cookie（M2-P6 第 3 片复验）。
   * 复核不通过（查令牌之后被用过、作废、账户停用）：回滚，事务之外交给 LinkAttempts.rejected，记审计（审查 A10）；
   * 找到了记录、只是不能用，不计入按地址的失败（M2-P6 复核 B3），另按这条记录计数。
   * 查令牌时、确认令牌可用之后（算哈希、事务里）遇到繁忙，名额退回（M2-P6 第 3 片复验 建议 1）
   */
  async complete(token: string, request: CompletePasswordResetRequest, origin: HttpOrigin, previousSessionToken: string | undefined): Promise<LoginResult> {
    const ticket = await this.attempts.admit(origin)
    const found = await releasingIfBusy(ticket, this.#logger, async () => this.lookup(token))
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'password_reset', found.rejection, origin)
    const { record } = found.record
    const passwordHash = await releasingIfBusy(ticket, this.#logger, async () => this.users.hashPassword(request.password))
    try {
      return await releasingIfBusy(ticket, this.#logger, async () => this.transactions.run(async (transaction) => {
        const account = await this.users.lockAccount(record.userId, transaction)
        if (account?.status !== 'active')
          throw new LinkUnusableDuringRequest('revoked')
        const locked = await this.repository.findByIdForUpdate(record.id, transaction)
        const now = locked === undefined ? 'invalid' : usabilityOf(stateOf(locked))
        if (now !== 'usable')
          throw new LinkUnusableDuringRequest(now)
        await ticket.succeeded(transaction)
        await this.users.resetPassword(account.id, passwordHash, transaction)
        await this.repository.markUsed(record.id, transaction)
        await this.lockouts.clear(account.username, transaction)
        await this.sessions.revokeAllOf(account.id, 'password_reset', { transaction })
        if (previousSessionToken !== undefined)
          await this.sessions.replace(previousSessionToken, transaction)
        const session = await this.sessions.create(account.id, transaction)
        await this.audit.record({
          action: 'users.password_reset_completed',
          actor: { type: 'user', id: account.id },
          target: { type: 'user', id: account.id },
          origin,
          details: { passwordResetId: record.id },
        }, { transaction })
        return this.responses.forNewSession(account, session.token, transaction)
      }))
    }
    catch (error) {
      if (error instanceof LinkUnusableDuringRequest)
        throw await this.attempts.rejected(ticket, 'password_reset', rejectionOf(error.reason, record.id, { type: 'user', id: record.userId }), origin)
      throw error
    }
  }

  /** 让当前密码失效用的哈希（审查 A7）。等待哈希的请求太多时 503，与登录相同 */
  private async unusablePasswordHash(): Promise<string> {
    try {
      return await this.users.unusablePasswordHash()
    }
    catch (error) {
      if (error instanceof PasswordHashingBusyError)
        throw hashingBusy(error)
      throw error
    }
  }

  /** 令牌对应的重置与账户；账户不存在或已停用时按作废处理。审计的对象是这个账户 */
  private async lookup(token: string): Promise<LinkLookup<{ readonly record: PasswordResetRecord, readonly user: User }>> {
    const digest = linkTokenDigest(token)
    const record = digest === undefined ? undefined : await this.repository.findByTokenHash(digest)
    if (record === undefined)
      return { usable: false, rejection: { reason: 'invalid' } }
    const target = { type: 'user' as const, id: record.userId }
    const user = await this.users.findActiveById(record.userId)
    if (user === undefined)
      return { usable: false, rejection: { reason: 'revoked', recordId: record.id, target } }
    const usability = usabilityOf(stateOf(record))
    return usability === 'usable' ? { usable: true, record: { record, user } } : { usable: false, rejection: { reason: usability, recordId: record.id, target } }
  }
}

/** 能签发重置的账户：不存在 NOT_FOUND，已停用 ACCOUNT_DISABLED */
function requireIssuable(account: User | undefined): void {
  if (account === undefined)
    throw new AppError('NOT_FOUND')
  if (account.status !== 'active')
    throw new AppError('ACCOUNT_DISABLED')
}

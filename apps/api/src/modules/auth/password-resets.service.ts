import type { CompletePasswordResetRequest, InspectLinkResponse, IssuedPasswordReset } from '@nerve-office/contracts'
import type { AuditEvent, AuditOrigin } from '../audit/index.ts'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { User } from '../users/index.ts'
import type { LinkLookup } from './link-state.ts'
import type { PasswordResetRecord } from './password-resets.repository.ts'
import { oneTimeLinkUrl, PASSWORD_RESET_LIFETIME_HOURS } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { UsersService } from '../users/index.ts'
import { withHashing } from './attempt-errors.ts'
import { LinkAttempts } from './link-attempts.ts'
import { usabilityOf } from './link-state.ts'
import { generateLinkToken, linkTokenDigest } from './link-token.ts'
import { PasswordResetsRepository } from './password-resets.repository.ts'
import { SessionService } from './session.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 完成重置之后：账户与新会话的令牌（只交给 Cookie） */
export interface CompletedReset {
  readonly user: User
  readonly sessionToken: string
}

function stateOf(record: PasswordResetRecord) {
  return { completedAt: record.usedAt, revokedAt: record.revokedAt, expired: record.expired }
}

/**
 * 重置密码（M2-P1 设计 §3.4，US-M2-03）：系统管理员（或运维命令）为某个账户签发一次性链接，签发时撤销这个人的全部会话；
 * 本人打开链接设置新密码，完成时再撤销一次全部会话，并以新密码登录。
 */
@Injectable()
export class PasswordResetsService {
  readonly #logger: AppLogger

  constructor(
    private readonly repository: PasswordResetsRepository,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly attempts: LinkAttempts,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'auth' })
  }

  /**
   * 签发：账户不存在 NOT_FOUND，已停用 ACCOUNT_DISABLED。一个事务里：作废这个账户未用的旧重置、新建、撤销全部会话
   * （原因 password_reset）、记审计。actor 是签发的系统管理员，运维命令签发时是系统
   */
  async issue(actor: AuditEvent['actor'], userId: string, origin: AuditOrigin): Promise<IssuedPasswordReset> {
    const account = await this.users.findById(userId)
    if (account === undefined)
      throw new AppError('NOT_FOUND')
    if (account.status !== 'active')
      throw new AppError('ACCOUNT_DISABLED')
    const token = generateLinkToken()
    const digest = linkTokenDigest(token)
    if (digest === undefined)
      throw new Error('生成的令牌格式不对')
    const record = await this.transactions.run(async (transaction) => {
      await this.repository.revokeOpenOfUser(userId, transaction)
      const created = await this.repository.insert({
        userId,
        tokenHash: digest,
        createdBy: actor.type === 'user' ? actor.id : undefined,
        lifetimeHours: PASSWORD_RESET_LIFETIME_HOURS,
      }, transaction)
      await this.sessions.revokeAllOf(userId, 'password_reset', { transaction })
      await this.audit.record({ action: 'users.password_reset_issued', actor, target: { type: 'user', id: userId }, origin }, { transaction })
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

  /** 停用账户时（admin 模块在同一个事务里调用）：作废这个人未用的重置 */
  async revokeOpenOf(userId: string, transaction: Transaction): Promise<void> {
    await this.repository.revokeOpenOfUser(userId, transaction)
  }

  /** 公开：用令牌查看，只给出登录名与显示名；账户已停用的按作废处理 */
  async inspect(token: string, origin: HttpOrigin): Promise<InspectLinkResponse> {
    const ticket = await this.attempts.admit(origin)
    const found = await this.lookup(token)
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'password_reset', found.reason, found.target, origin)
    const { record, user } = found.record
    await ticket.succeeded()
    return { username: user.username, displayName: user.displayName, expiresAt: record.expiresAt.toISOString() }
  }

  /**
   * 公开：设置新密码。先查令牌再算哈希，都在事务之外；然后在一个事务里：锁住重置复核、更新密码、标记已使用、
   * 撤销这个人的全部会话、退回限流的名额、新建本次的会话、记审计
   */
  async complete(token: string, request: CompletePasswordResetRequest, origin: HttpOrigin, previousSessionToken: string | undefined): Promise<CompletedReset> {
    const ticket = await this.attempts.admit(origin)
    const found = await this.lookup(token)
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'password_reset', found.reason, found.target, origin)
    const { record, user } = found.record
    const passwordHash = await withHashing(ticket, this.#logger, async () => this.users.hashPassword(request.password))
    const sessionToken = await this.transactions.run(async (transaction) => {
      const locked = await this.repository.findByIdForUpdate(record.id, transaction)
      const now = locked === undefined ? 'invalid' : usabilityOf(stateOf(locked))
      // 查令牌与这里之间被用过或作废了（并发、停用账户）：按原因回答，这次按一次失败计
      if (now !== 'usable')
        throw new AppError('LINK_INVALID', undefined, { details: { reason: now } })
      await this.users.setPasswordHash(user.id, passwordHash, transaction)
      await this.repository.markUsed(record.id, transaction)
      await this.sessions.revokeAllOf(user.id, 'password_reset', { transaction })
      await ticket.succeeded(transaction)
      if (previousSessionToken !== undefined)
        await this.sessions.replace(previousSessionToken, transaction)
      const session = await this.sessions.create(user.id, transaction)
      await this.audit.record({ action: 'users.password_reset_completed', actor: { type: 'user', id: user.id }, target: { type: 'user', id: user.id }, origin }, { transaction })
      return session.token
    })
    return { user, sessionToken }
  }

  /** 令牌对应的重置与账户；账户不存在或已停用时按作废处理。审计的对象是这个账户 */
  private async lookup(token: string): Promise<LinkLookup<{ readonly record: PasswordResetRecord, readonly user: User }>> {
    const digest = linkTokenDigest(token)
    const record = digest === undefined ? undefined : await this.repository.findByTokenHash(digest)
    if (record === undefined)
      return { usable: false, reason: 'invalid' }
    const target = { type: 'user' as const, id: record.userId }
    const user = await this.users.findActiveById(record.userId)
    if (user === undefined)
      return { usable: false, reason: 'revoked', target }
    const usability = usabilityOf(stateOf(record))
    return usability === 'usable' ? { usable: true, record: { record, user } } : { usable: false, reason: usability, target }
  }
}

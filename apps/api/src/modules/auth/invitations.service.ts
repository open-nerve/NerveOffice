import type { AcceptInvitationRequest, CreateInvitationRequest, InspectLinkResponse, Invitation, InvitationListQuery, InvitationListResponse, IssuedInvitation, UserSummary } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { User } from '../users/index.ts'
import type { InvitationRecord } from './invitations.repository.ts'
import type { LinkLookup } from './link-state.ts'
import { ADMIN_PAGE_SIZE, INVITATION_LIFETIME_HOURS, oneTimeLinkUrl } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { AuditService } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { AccountCreationService, UsersService } from '../users/index.ts'
import { withHashing } from './attempt-errors.ts'
import { InvitationsRepository } from './invitations.repository.ts'
import { LinkAttempts } from './link-attempts.ts'
import { invitationStatusOf, usabilityOf } from './link-state.ts'
import { generateLinkToken, linkTokenDigest } from './link-token.ts'
import { SessionService } from './session.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 接受邀请之后：新账户与它的会话令牌（只交给 Cookie） */
export interface AcceptedInvitation {
  readonly user: User
  readonly sessionToken: string
}

function stateOf(record: InvitationRecord) {
  return { completedAt: record.acceptedAt, revokedAt: record.revokedAt, expired: record.expired }
}

/** 签发人不在了（外键 restrict，不会发生）时的占位：只显示 id */
function summaryOf(user: User | undefined, id: string): UserSummary {
  return user === undefined ? { id, username: '', displayName: '' } : { id: user.id, username: user.username, displayName: user.displayName }
}

function toInvitation(record: InvitationRecord, issuer: UserSummary): Invitation {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    status: invitationStatusOf(stateOf(record)),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    createdBy: issuer,
    acceptedAt: record.acceptedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
  }
}

/**
 * 邀请注册（M2-P1 设计 §3.4，US-M2-01）：管理员填好登录名与显示名，签发一次性链接；受邀人打开链接设置密码，建成账户与个人空间，
 * 同时登录。锁的顺序固定为先按登录名的 advisory lock、再邀请的行锁（签发、重发、接受都一样），互相等待时不成环。
 */
@Injectable()
export class InvitationsService {
  readonly #logger: AppLogger

  constructor(
    private readonly repository: InvitationsRepository,
    private readonly accounts: AccountCreationService,
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

  /** 签发：登录名已被账户占用，或者已有未过期、待接受的邀请时拒绝（USERNAME_TAKEN）；已过期的旧邀请自动作废 */
  async issue(actor: User, request: CreateInvitationRequest, origin: HttpOrigin): Promise<IssuedInvitation> {
    const token = generateLinkToken()
    const record = await this.transactions.run(async (transaction) => {
      await this.accounts.lockUsername(request.username, transaction)
      await this.requireUsernameAvailable(request.username, actor, origin, transaction)
      return this.insert(actor, request.username, request.displayName, token, origin, transaction)
    })
    return { invitation: toInvitation(record, summaryOf(actor, actor.id)), url: this.linkFor(token) }
  }

  /** 重发：作废旧的（还没作废时）、按同一个登录名与显示名签发新的，一个事务；已接受的不能重发（登录名已被占用） */
  async reissue(actor: User, invitationId: string, origin: HttpOrigin): Promise<IssuedInvitation> {
    const peek = await this.repository.findById(invitationId)
    if (peek === undefined)
      throw new AppError('NOT_FOUND')
    const token = generateLinkToken()
    const record = await this.transactions.run(async (transaction) => {
      await this.accounts.lockUsername(peek.username, transaction)
      const old = await this.repository.findByIdForUpdate(invitationId, transaction)
      if (old === undefined)
        throw new AppError('NOT_FOUND')
      if (old.acceptedAt !== null)
        throw new AppError('USERNAME_TAKEN')
      if (old.revokedAt === null)
        await this.revokeLocked(actor, old, { reissued: true }, origin, transaction)
      await this.requireUsernameAvailable(old.username, actor, origin, transaction)
      return this.insert(actor, old.username, old.displayName, token, origin, transaction, old.id)
    })
    return { invitation: toInvitation(record, summaryOf(actor, actor.id)), url: this.linkFor(token) }
  }

  /** 作废：已接受或已作废的原样返回，不记审计 */
  async revoke(actor: User, invitationId: string, origin: HttpOrigin): Promise<Invitation> {
    const record = await this.transactions.run(async (transaction) => {
      const current = await this.repository.findByIdForUpdate(invitationId, transaction)
      if (current === undefined)
        throw new AppError('NOT_FOUND')
      if (current.acceptedAt !== null || current.revokedAt !== null)
        return current
      return this.revokeLocked(actor, current, {}, origin, transaction)
    })
    const issuers = await this.users.findByIds([record.createdBy])
    return toInvitation(record, summaryOf(issuers.get(record.createdBy), record.createdBy))
  }

  /** 管理界面的列表：按签发时间从新到旧分页，可按状态过滤；不含令牌 */
  async list(query: InvitationListQuery): Promise<InvitationListResponse> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    const rows = await this.repository.list({ status: query.status, after, limit: ADMIN_PAGE_SIZE + 1 })
    const page = rows.slice(0, ADMIN_PAGE_SIZE)
    const issuers = await this.users.findByIds(page.map(row => row.createdBy))
    const last = page.at(-1)
    return {
      items: page.map(row => toInvitation(row, summaryOf(issuers.get(row.createdBy), row.createdBy))),
      nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }

  /** 按 id 批量取邀请的登录名（审计查询补名字） */
  async usernamesOf(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const rows = await this.repository.findUsernames([...new Set(ids)])
    return new Map(rows.map(row => [row.id, row.username]))
  }

  /** 公开：用令牌查看，只给出登录名与显示名 */
  async inspect(token: string, origin: HttpOrigin): Promise<InspectLinkResponse> {
    const ticket = await this.attempts.admit(origin)
    const found = await this.lookup(token)
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'invitation', found.reason, found.target, origin)
    const { record } = found
    await ticket.succeeded()
    return { username: record.username, displayName: record.displayName, expiresAt: record.expiresAt.toISOString() }
  }

  /**
   * 公开：接受邀请。先查令牌再算新密码的哈希（无效的令牌不触发哈希计算），都在事务之外；然后在一个事务里：
   * 锁住邀请复核、建账户与个人空间、标记已接受、退回限流的名额、新建会话（浏览器原来带着的会话作废）、记审计
   */
  async accept(token: string, request: AcceptInvitationRequest, origin: HttpOrigin, previousSessionToken: string | undefined): Promise<AcceptedInvitation> {
    const ticket = await this.attempts.admit(origin)
    const found = await this.lookup(token)
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'invitation', found.reason, found.target, origin)
    const { record } = found
    const passwordHash = await withHashing(ticket, this.#logger, async () => this.users.hashPassword(request.password))
    return this.transactions.run(async (transaction) => {
      await this.accounts.lockUsername(record.username, transaction)
      const locked = await this.repository.findByIdForUpdate(record.id, transaction)
      const now = locked === undefined ? 'invalid' : usabilityOf(stateOf(locked))
      // 查令牌与这里之间被接受或作废了（并发）：按原因回答，这次按一次失败计
      if (now !== 'usable')
        throw new AppError('LINK_INVALID', undefined, { details: { reason: now } })
      if (await this.accounts.isUsernameTaken(record.username, transaction))
        throw new AppError('USERNAME_TAKEN')
      const { user } = await this.accounts.create({ username: record.username, displayName: request.displayName, passwordHash, systemRole: 'member' }, transaction)
      await this.repository.markAccepted(record.id, user.id, transaction)
      await ticket.succeeded(transaction)
      if (previousSessionToken !== undefined)
        await this.sessions.replace(previousSessionToken, transaction)
      const session = await this.sessions.create(user.id, transaction)
      await this.audit.record({
        action: 'users.invitation_accepted',
        actor: { type: 'user', id: user.id },
        target: { type: 'user', id: user.id },
        origin,
        details: { invitationId: record.id },
      }, { transaction })
      return { user, sessionToken: session.token }
    })
  }

  /** 令牌对应的邀请：可用；或者不能用的原因，以及审计的对象（找到了记录时） */
  private async lookup(token: string): Promise<LinkLookup<InvitationRecord>> {
    const digest = linkTokenDigest(token)
    const record = digest === undefined ? undefined : await this.repository.findByTokenHash(digest)
    if (record === undefined)
      return { usable: false, reason: 'invalid' }
    const usability = usabilityOf(stateOf(record))
    return usability === 'usable' ? { usable: true, record } : { usable: false, reason: usability, target: { type: 'invitation', id: record.id } }
  }

  /** 调用方已取这个登录名的锁：账户占用了，或者有未过期、待接受的邀请时 USERNAME_TAKEN；过期未处理的先作废 */
  private async requireUsernameAvailable(username: string, actor: User, origin: HttpOrigin, transaction: Transaction): Promise<void> {
    if (await this.accounts.isUsernameTaken(username, transaction))
      throw new AppError('USERNAME_TAKEN')
    const open = await this.repository.findOpenByUsername(username, transaction)
    if (open === undefined)
      return
    if (!open.expired)
      throw new AppError('USERNAME_TAKEN')
    await this.revokeLocked(actor, open, { expired: true }, origin, transaction)
  }

  private async revokeLocked(actor: User, record: InvitationRecord, details: Record<string, boolean>, origin: HttpOrigin, transaction: Transaction): Promise<InvitationRecord> {
    const revoked = await this.repository.revoke(record.id, actor.id, transaction)
    await this.audit.record({
      action: 'users.invitation_revoked',
      actor: { type: 'user', id: actor.id },
      target: { type: 'invitation', id: record.id },
      origin,
      details,
    }, { transaction })
    return revoked
  }

  private async insert(actor: User, username: string, displayName: string, token: string, origin: HttpOrigin, transaction: Transaction, reissuedFrom?: string): Promise<InvitationRecord> {
    const digest = linkTokenDigest(token)
    if (digest === undefined)
      throw new Error('生成的令牌格式不对')
    const record = await this.repository.insert({ username, displayName, tokenHash: digest, createdBy: actor.id, lifetimeHours: INVITATION_LIFETIME_HOURS }, transaction)
    await this.audit.record({
      action: 'users.invited',
      actor: { type: 'user', id: actor.id },
      target: { type: 'invitation', id: record.id },
      origin,
      details: reissuedFrom === undefined ? { username } : { username, reissuedFrom },
    }, { transaction })
    return record
  }

  private linkFor(token: string): string {
    return oneTimeLinkUrl(this.config.http.publicOrigin, 'invitation', token)
  }
}

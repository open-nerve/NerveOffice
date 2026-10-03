import type { AcceptInvitationRequest, AuditDetailsOf, CreateInvitationRequest, InspectLinkResponse, Invitation, InvitationListQuery, InvitationListResponse, IssuedInvitation, LinkIssuerRevocationReason, UserSummary } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { User } from '../users/index.ts'
import type { InvitationRecord } from './invitations.repository.ts'
import type { LinkLookup } from './link-state.ts'
import type { LoginResult } from './session-response.ts'
import { ADMIN_PAGE_SIZE, INVITATION_LIFETIME_HOURS, oneTimeLinkUrl } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { AuditService } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { AccountCreationService, UsersService } from '../users/index.ts'
import { releasingIfBusy, settleQuietly } from './attempt-errors.ts'
import { InvitationsRepository } from './invitations.repository.ts'
import { LinkAttempts } from './link-attempts.ts'
import { invitationStatusOf, LinkUnusableDuringRequest, rejectionOf, usabilityOf } from './link-state.ts'
import { generateLinkToken, linkTokenDigest } from './link-token.ts'
import { LoginLockouts } from './login-lockouts.ts'
import { SessionResponses } from './session-response.ts'
import { SessionService } from './session.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

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
    superseded: record.superseded,
  }
}

/**
 * 邀请注册（M2-P1 设计 §3.4，US-M2-01）：管理员填好登录名与显示名，签发一次性链接；受邀人打开链接设置密码，建成账户与个人空间，
 * 同时登录。锁的顺序固定为先按登录名的 advisory lock、再邀请的行锁（签发、重发、接受都一样），互相等待时不成环。
 * 签发、重发、作废的事务第一步复核操作者（system-admins 的共享锁，复验 N3），排在这两把锁之前。
 */
@Injectable()
export class InvitationsService {
  readonly #logger: AppLogger

  constructor(
    private readonly repository: InvitationsRepository,
    private readonly accounts: AccountCreationService,
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

  /** 签发：登录名已被账户占用，或者已有未过期、待接受的邀请时拒绝（USERNAME_TAKEN）；已过期的旧邀请自动作废 */
  async issue(actor: User, request: CreateInvitationRequest, origin: HttpOrigin): Promise<IssuedInvitation> {
    const token = generateLinkToken()
    const record = await this.transactions.run(async (transaction) => {
      await this.users.lockActingAdmin(actor.id, transaction)
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
      await this.users.lockActingAdmin(actor.id, transaction)
      await this.accounts.lockUsername(peek.username, transaction)
      const old = await this.repository.findByIdForUpdate(invitationId, transaction)
      if (old === undefined)
        throw new AppError('NOT_FOUND')
      if (old.acceptedAt !== null)
        throw new AppError('USERNAME_TAKEN')
      if (old.revokedAt === null)
        await this.revokeOpen(actor, old, { reissued: true }, origin, transaction)
      await this.requireUsernameAvailable(old.username, actor, origin, transaction)
      return this.insert(actor, old.username, old.displayName, token, origin, transaction, old.id)
    })
    return { invitation: toInvitation(record, summaryOf(actor, actor.id)), url: this.linkFor(token) }
  }

  /**
   * 作废：已接受或已作废的原样返回，不记审计。签发人的名字在同一个事务里补上：提交之后不再访问数据库——
   * 提交之后才读的话，这一步遇到数据库繁忙时邀请已经作废，客户端却只能得到"结果未知"（M2-P6 第 3 片复验）
   */
  async revoke(actor: User, invitationId: string, origin: HttpOrigin): Promise<Invitation> {
    return this.transactions.run(async (transaction) => {
      await this.users.lockActingAdmin(actor.id, transaction)
      const current = await this.repository.findByIdForUpdate(invitationId, transaction)
      if (current === undefined)
        throw new AppError('NOT_FOUND')
      const record = current.acceptedAt !== null || current.revokedAt !== null
        ? current
        : await this.revokeOpen(actor, current, {}, origin, transaction) ?? current
      const issuers = await this.users.findByIds([record.createdBy], transaction)
      return toInvitation(record, summaryOf(issuers.get(record.createdBy), record.createdBy))
    })
  }

  /**
   * 签发人离任时（M2-P6 复核 A2；admin 模块在停用、取消系统管理员的同一个事务里调用，已锁住签发人的账户行）：
   * 作废这个人签发的、还没接受的邀请，每作废一条记一条 users.invitation_revoked（明细带原因）。
   * 否则离任之后，他发出去的链接在 7 天内仍能用来建账户。代价：对方还没接受的邀请要由另一位管理员重发。
   * 锁的顺序：签发人的账户行 → 邀请行。接受邀请是按登录名的 advisory lock → 邀请行，不锁签发人的账户行：两边只在邀请行上相遇，不成环
   */
  async revokeIssuedBy(actor: User, issuerId: string, reason: LinkIssuerRevocationReason, origin: HttpOrigin, transaction: Transaction): Promise<void> {
    for (const invitationId of await this.repository.revokeOpenIssuedBy(issuerId, actor.id, transaction)) {
      await this.audit.record({
        action: 'users.invitation_revoked',
        actor: { type: 'user', id: actor.id },
        target: { type: 'invitation', id: invitationId },
        origin,
        details: { reason },
      }, { transaction })
    }
  }

  /** 管理界面的列表：按签发时间从新到旧分页，可按状态过滤；不含令牌 */
  async list(query: InvitationListQuery): Promise<InvitationListResponse> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 一页邀请与签发人的名字在同一个只读快照里读（M2 Codex 评审 CX1）
    return this.transactions.readSnapshot(async (transaction) => {
      const rows = await this.repository.list({ status: query.status, after, limit: ADMIN_PAGE_SIZE + 1 }, transaction)
      const page = rows.slice(0, ADMIN_PAGE_SIZE)
      const issuers = await this.users.findByIds(page.map(row => row.createdBy), transaction)
      const last = page.at(-1)
      return {
        items: page.map(row => toInvitation(row, summaryOf(issuers.get(row.createdBy), row.createdBy))),
        nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
      }
    })
  }

  /** 按 id 批量取邀请的登录名（审计查询补名字，在它的只读快照里） */
  async usernamesOf(ids: readonly string[], transaction: Transaction): Promise<ReadonlyMap<string, string>> {
    const rows = await this.repository.findUsernames([...new Set(ids)], transaction)
    return new Map(rows.map(row => [row.id, row.username]))
  }

  /**
   * 公开：用令牌查看，只给出登录名与显示名。查令牌时数据库繁忙：还不知道令牌对不对，退回名额（releasingIfBusy）；
   * 令牌可用时退回名额，尽力而为（M2-P6 第 3 片复验 建议 1）：查看是只读的，退回失败只记日志，照样给出结果
   */
  async inspect(token: string, origin: HttpOrigin): Promise<InspectLinkResponse> {
    const ticket = await this.attempts.admit(origin)
    const found = await releasingIfBusy(ticket, this.#logger, async () => this.lookup(token))
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'invitation', found.rejection, origin)
    const { record } = found
    await settleQuietly(async () => ticket.succeeded(), this.#logger)
    return { username: record.username, displayName: record.displayName, expiresAt: record.expiresAt.toISOString() }
  }

  /**
   * 公开：接受邀请。先查令牌再算新密码的哈希（无效的令牌不触发哈希计算），都在事务之外；然后在一个事务里：
   * 锁住邀请复核、建账户与个人空间、退回限流的名额、标记已接受、清掉这个登录名的登录失败计数（M2-P6 复核 A1：
   * 账户建成之前别人用这个登录名试过的失败不能挡住本人；与完成重置同理，本人用链接证明了控制着这个账户）、
   * 新建会话（浏览器原来带着的会话作废）、记审计、拼好响应（与登录相同）：提交之后不再访问数据库，控制器随后才写 Cookie（M2-P6 第 3 片复验）。
   * 复核不通过（查令牌之后被接受或作废）：回滚，事务之外交给 LinkAttempts.rejected，记审计（审查 A10）；
   * 找到了记录、只是不能用，不计入按地址的失败（M2-P6 复核 B3），另按这条记录计数。
   * 查令牌时、确认令牌可用之后（算哈希、事务里）遇到繁忙，名额退回（M2-P6 第 3 片复验 建议 1）
   */
  async accept(token: string, request: AcceptInvitationRequest, origin: HttpOrigin, previousSessionToken: string | undefined): Promise<LoginResult> {
    const ticket = await this.attempts.admit(origin)
    const found = await releasingIfBusy(ticket, this.#logger, async () => this.lookup(token))
    if (!found.usable)
      throw await this.attempts.rejected(ticket, 'invitation', found.rejection, origin)
    const { record } = found
    const passwordHash = await releasingIfBusy(ticket, this.#logger, async () => this.users.hashPassword(request.password))
    try {
      return await releasingIfBusy(ticket, this.#logger, async () => this.transactions.run(async (transaction) => {
        await this.accounts.lockUsername(record.username, transaction)
        const locked = await this.repository.findByIdForUpdate(record.id, transaction)
        const now = locked === undefined ? 'invalid' : usabilityOf(stateOf(locked))
        if (now !== 'usable')
          throw new LinkUnusableDuringRequest(now)
        if (await this.accounts.isUsernameTaken(record.username, transaction))
          throw new AppError('USERNAME_TAKEN')
        const { user } = await this.accounts.create({ username: record.username, displayName: request.displayName, passwordHash, systemRole: 'member' }, transaction)
        await ticket.succeeded(transaction)
        await this.repository.markAccepted(record.id, user.id, transaction)
        await this.lockouts.clear(user.username, transaction)
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
        return this.responses.forNewSession(user, session.token, transaction)
      }))
    }
    catch (error) {
      if (error instanceof LinkUnusableDuringRequest)
        throw await this.attempts.rejected(ticket, 'invitation', rejectionOf(error.reason, record.id, { type: 'invitation', id: record.id }), origin)
      throw error
    }
  }

  /** 令牌对应的邀请：可用；或者不能用的原因，以及审计的对象（找到了记录时） */
  private async lookup(token: string): Promise<LinkLookup<InvitationRecord>> {
    const digest = linkTokenDigest(token)
    const record = digest === undefined ? undefined : await this.repository.findByTokenHash(digest)
    if (record === undefined)
      return { usable: false, rejection: { reason: 'invalid' } }
    const usability = usabilityOf(stateOf(record))
    return usability === 'usable' ? { usable: true, record } : { usable: false, rejection: { reason: usability, recordId: record.id, target: { type: 'invitation', id: record.id } } }
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
    await this.revokeOpen(actor, open, { expired: true }, origin, transaction)
  }

  /**
   * 作废一条未接受、未作废的邀请并记审计。更新带着状态条件（审查 A9）：签发时自动作废的旧邀请没有锁行，
   * 同时被管理员手动作废时，后到的一方更新不到行，返回 undefined，也不再记一次审计
   */
  private async revokeOpen(actor: User, record: InvitationRecord, details: AuditDetailsOf<'users.invitation_revoked'>, origin: HttpOrigin, transaction: Transaction): Promise<InvitationRecord | undefined> {
    const revoked = await this.repository.revokeOpen(record.id, actor.id, transaction)
    if (revoked === undefined)
      return undefined
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

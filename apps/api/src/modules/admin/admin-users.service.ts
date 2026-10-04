import type { AdminUser, AdminUserListQuery, AdminUserListResponse, LinkIssuerRevocationReason, UserSystemRole } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { AccountRecord } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { InvitationsService, LoginLockouts, PasswordResetsService, SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { WriteAccessRevocation } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { actorOf, toAdminUser } from './admin-views.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 管理界面的账户操作（M2-P1 设计 §3.5）：跨模块的编排都在一个事务里。
 * 没有变化的操作（例如停用已停用的账户）原样返回，不记审计。
 * 返回的账户带着登录的锁定（M2-P6 复核 A1）：在同一个事务里、提交之前读（看得到这个事务自己的改动）。提交之后不再访问数据库——
 * 提交之后才读的话，这一步遇到数据库繁忙时账户已经停用，客户端却只能得到"结果未知"（M2-P6 第 3 片复验）
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly resets: PasswordResetsService,
    private readonly invitations: InvitationsService,
    private readonly lockouts: LoginLockouts,
    private readonly writeAccess: WriteAccessRevocation,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 一个账户（含停用的）；不存在时 NOT_FOUND。账户与登录的锁定在同一个只读快照里读（M2 Codex 评审 CX1） */
  async get(userId: string): Promise<AdminUser> {
    return this.transactions.readSnapshot(async (transaction) => {
      const account = await this.users.findAccount(userId, transaction)
      if (account === undefined)
        throw new AppError('NOT_FOUND')
      return this.view(account, transaction)
    })
  }

  /** 账户列表与各自的登录锁定：在同一个只读快照里读（M2 Codex 评审 CX1） */
  async list(query: AdminUserListQuery): Promise<AdminUserListResponse> {
    return this.transactions.readSnapshot(async (transaction) => {
      const page = await this.users.listAccounts(query, transaction)
      const locks = await this.lockouts.locksOf(page.items.map(account => account.username), transaction)
      return { items: page.items.map(account => toAdminUser(account, locks.get(account.username))), nextCursor: page.nextCursor }
    })
  }

  /**
   * 停用：状态改为停用、作废这个人未用的重置（记审计，M2-P6 复核 C3）、作废这个人签发给别人的还没用的邀请与重置
   * （记审计，M2-P6 复核 A2）、撤销全部会话（原因 disabled）、收回写入权（M2-P2 设计 §3.7）、记审计，一个事务。
   * 会话守卫对每个请求检查账户状态，事务提交之后这个人的请求一律被拒绝。
   * 锁的顺序：system-admins 的锁、账户行、重置与邀请的行、会话、文档行、租约行（收回写入权，M3-P1 起结束这个人的编辑租约）（ADR-007，审查 A2）
   */
  async disable(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.disable(userId, actor.user.id, transaction)
      if (change.changed) {
        // 未用的重置链接一并作废：启用之后要重置密码得重新签发
        await this.resets.revokeOpenOf(actorOf(actor), userId, origin, transaction)
        await this.revokeLinksIssuedBy(actor, userId, 'issuer_disabled', origin, transaction)
        await this.sessions.revokeAllOf(userId, 'disabled', { transaction })
        await this.writeAccess.revoke({ kind: 'user', userId: change.account.id }, transaction)
        await this.audit.record({ action: 'users.disabled', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      }
      return this.view(change.account, transaction)
    })
  }

  /** 启用：只改状态。个人空间还在；停用期间转移走的文档不会回来（M2-P2 设计 §3.8）；停用时作废的链接也不会恢复 */
  async enable(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.enable(userId, actor.user.id, transaction)
      if (change.changed)
        await this.audit.record({ action: 'users.enabled', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      return this.view(change.account, transaction)
    })
  }

  /**
   * 授予或取消系统管理员；审计记下原角色与新角色。取消时在同一个事务里作废这个人签发给别人的、还没用的邀请与重置（M2-P6 复核 A2）：
   * 不再是管理员之后，不能再借任期内签发的链接建账户、设置别人的密码
   */
  async changeSystemRole(actor: Principal, userId: string, systemRole: UserSystemRole, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.changeSystemRole(userId, systemRole, actor.user.id, transaction)
      if (change.changed) {
        const from: UserSystemRole = systemRole === 'admin' ? 'member' : 'admin'
        if (systemRole === 'member')
          await this.revokeLinksIssuedBy(actor, userId, 'issuer_no_longer_admin', origin, transaction)
        await this.audit.record({
          action: 'users.system_role_changed',
          actor: actorOf(actor),
          target: { type: 'user', id: userId },
          origin,
          details: { from, to: systemRole },
        }, { transaction })
      }
      return this.view(change.account, transaction)
    })
  }

  /**
   * 解除登录锁定（M2-P6 复核 A1）：清掉这个账户在所有来源上的失败计数（只按用户名的、按用户名与各个来源的），本人随即可以登录；
   * 只按来源的计数不属于这个账户，不动。一个事务：复核操作者（system-admins 的共享锁）、锁账户行（与这个账户的登录、
   * 修改密码的成功排队）、清计数、记审计 users.login_unlocked。没有计数可清时原样返回，不记审计
   */
  async unlockLogin(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      await this.users.lockActingAdmin(actor.user.id, transaction)
      const locked = await this.users.lockAccount(userId, transaction)
      if (locked === undefined)
        throw new AppError('NOT_FOUND')
      if (await this.lockouts.clear(locked.username, transaction))
        await this.audit.record({ action: 'users.login_unlocked', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      return this.view(locked, transaction)
    })
  }

  /**
   * 这个人签发的、还没用的重置与邀请一并作废（M2-P6 复核 A2），逐条记审计。调用方已在同一个事务里锁住这个人的账户行：
   * 锁的顺序是账户行在前、链接行在后，与完成重置（被重置者的账户行 → 重置行）、接受邀请（登录名的锁 → 邀请行）不成环
   */
  private async revokeLinksIssuedBy(actor: Principal, issuerId: string, reason: LinkIssuerRevocationReason, origin: HttpOrigin, transaction: Transaction): Promise<void> {
    await this.resets.revokeIssuedBy(actorOf(actor), issuerId, reason, origin, transaction)
    await this.invitations.revokeIssuedBy(actor.user, issuerId, reason, origin, transaction)
  }

  /** 管理界面里的账户，带着登录的锁定：写操作传入它的事务（在提交之前读），读接口传入它的只读快照 */
  private async view(account: AccountRecord, transaction: Transaction): Promise<AdminUser> {
    const locks = await this.lockouts.locksOf([account.username], transaction)
    return toAdminUser(account, locks.get(account.username))
  }
}

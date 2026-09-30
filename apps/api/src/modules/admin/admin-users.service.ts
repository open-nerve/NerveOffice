import type { AdminUser, AdminUserListQuery, AdminUserListResponse, UserSystemRole } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { PasswordResetsService, SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { WriteAccessRevocation } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { actorOf, toAdminUser } from './admin-views.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 管理界面的账户操作（M2-P1 设计 §3.5）：跨模块的编排都在一个事务里。
 * 没有变化的操作（例如停用已停用的账户）原样返回，不记审计。
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly resets: PasswordResetsService,
    private readonly writeAccess: WriteAccessRevocation,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 一个账户（含停用的）；不存在时 NOT_FOUND */
  async get(userId: string): Promise<AdminUser> {
    const account = await this.users.findAccount(userId)
    if (account === undefined)
      throw new AppError('NOT_FOUND')
    return toAdminUser(account)
  }

  async list(query: AdminUserListQuery): Promise<AdminUserListResponse> {
    const page = await this.users.listAccounts(query)
    return { items: page.items.map(toAdminUser), nextCursor: page.nextCursor }
  }

  /**
   * 停用：状态改为停用、作废未用的重置（记审计，M2-P6 复核 C3）、撤销全部会话（原因 disabled）、收回写入权（M2-P2 设计 §3.7）、
   * 记审计，一个事务。会话守卫对每个请求检查账户状态，事务提交之后这个人的请求一律被拒绝。
   * 锁的顺序：system-admins 的锁、账户行、重置、会话、文档（收回写入权，M3 起锁租约与文档行）（ADR-007，审查 A2）
   */
  async disable(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.disable(userId, actor.user.id, transaction)
      if (change.changed) {
        // 未用的重置链接一并作废：启用之后要重置密码得重新签发
        await this.resets.revokeOpenOf(actorOf(actor), userId, origin, transaction)
        await this.sessions.revokeAllOf(userId, 'disabled', { transaction })
        await this.writeAccess.revoke({ kind: 'user', userId: change.account.id }, transaction)
        await this.audit.record({ action: 'users.disabled', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      }
      return toAdminUser(change.account)
    })
  }

  /** 启用：只改状态。个人空间还在；停用期间转移走的文档不会回来（M2-P2 设计 §3.8） */
  async enable(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.enable(userId, actor.user.id, transaction)
      if (change.changed)
        await this.audit.record({ action: 'users.enabled', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      return toAdminUser(change.account)
    })
  }

  /** 授予或取消系统管理员；审计记下原角色与新角色 */
  async changeSystemRole(actor: Principal, userId: string, systemRole: UserSystemRole, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.changeSystemRole(userId, systemRole, actor.user.id, transaction)
      if (change.changed) {
        const from: UserSystemRole = systemRole === 'admin' ? 'member' : 'admin'
        await this.audit.record({
          action: 'users.system_role_changed',
          actor: actorOf(actor),
          target: { type: 'user', id: userId },
          origin,
          details: { from, to: systemRole },
        }, { transaction })
      }
      return toAdminUser(change.account)
    })
  }
}

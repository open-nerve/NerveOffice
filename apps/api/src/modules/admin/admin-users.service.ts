import type { AdminUser, AdminUserListQuery, AdminUserListResponse, UserSystemRole } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
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
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  async list(query: AdminUserListQuery): Promise<AdminUserListResponse> {
    const page = await this.users.listAccounts(query)
    return { items: page.items.map(toAdminUser), nextCursor: page.nextCursor }
  }

  /**
   * 停用：状态改为停用、撤销全部会话（原因 disabled）、记审计，一个事务。会话守卫对每个请求检查账户状态，
   * 事务提交之后这个人的请求一律被拒绝
   */
  async disable(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.disable(userId, transaction)
      if (change.changed) {
        await this.sessions.revokeAllOf(userId, 'disabled', { transaction })
        await this.audit.record({ action: 'users.disabled', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      }
      return toAdminUser(change.account)
    })
  }

  /** 启用：个人空间与文档都没有变过，只改状态 */
  async enable(actor: Principal, userId: string, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.enable(userId, transaction)
      if (change.changed)
        await this.audit.record({ action: 'users.enabled', actor: actorOf(actor), target: { type: 'user', id: userId }, origin }, { transaction })
      return toAdminUser(change.account)
    })
  }

  /** 授予或取消系统管理员；审计记下原角色与新角色 */
  async changeSystemRole(actor: Principal, userId: string, systemRole: UserSystemRole, origin: HttpOrigin): Promise<AdminUser> {
    return this.transactions.run(async (transaction) => {
      const change = await this.users.changeSystemRole(userId, systemRole, transaction)
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

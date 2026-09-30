import type { AddSpaceMemberRequest, SpaceMember, SpaceMemberListResponse, SpaceRole } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { Actor } from '../documents/index.ts'
import type { SpaceMemberRecord } from '../spaces/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { DocumentAccessPolicy, requireSpaceManagement, WriteAccessRevocation } from '../documents/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'
import { ManagedSpaces } from './managed-space.ts'
import { compareMembers, toSpaceMember, toTeamSpace } from './workspace-views.ts'

/**
 * 团队空间的成员与空间角色（M2-P2 设计 §3.9，US-M2-06）：空间管理员（空间没有归档）与系统管理员管理，
 * 有空间角色的人都能查看。成员的变更与收回写入权、审计在一个事务里。
 */
@Injectable()
export class SpaceMembershipService {
  constructor(
    private readonly policy: DocumentAccessPolicy,
    private readonly spaces: SpacesService,
    private readonly users: UsersService,
    private readonly managed: ManagedSpaces,
    private readonly writeAccess: WriteAccessRevocation,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 成员列表：含停用的成员（带状态），先按角色、再按显示名排序 */
  async list(actor: Actor, spaceId: string): Promise<SpaceMemberListResponse> {
    const access = await requireSpaceManagement(this.policy, actor, spaceId, 'viewMembers')
    const members = await this.spaces.members(spaceId)
    const accounts = await this.users.findByIds(members.map(member => member.userId))
    return {
      space: toTeamSpace(access.space),
      canManage: access.permissions.canManageMembers,
      items: members.map(member => toSpaceMember(member, this.accountOf(accounts, member.userId))).sort(compareMembers),
    }
  }

  /**
   * 添加成员：要添加的人必须是有效账户（以共享锁持住，到提交之前不会被停用），否则 ACCOUNT_UNAVAILABLE；
   * 已经是成员时 ALREADY_MEMBER。操作者把自己加入（只有没有加入的系统管理员会这样）时，审计记为系统管理员加入空间。
   * 锁的顺序：system-admins 的锁（系统管理员）→ 账户行 → 空间行 → 成员行。
   * 是不是本人、审计的明细都用数据库返回的 id：不依赖请求里 id 的写法（契约已统一成小写，M2-P2 审查 A1、复验 N3）
   */
  async add(principal: Principal, spaceId: string, request: AddSpaceMemberRequest, origin: AuditOrigin): Promise<SpaceMember> {
    return this.transactions.run(async (transaction) => {
      const actor = await this.managed.actorOf(principal, transaction)
      await this.managed.check(actor, spaceId, 'manageMembers', transaction)
      const account = await this.users.holdActiveAccount(request.userId, transaction)
      if (account === undefined)
        throw new AppError('ACCOUNT_UNAVAILABLE')
      const { space } = await this.managed.lock(actor, spaceId, 'manageMembers', transaction)
      const member = await this.spaces.addMember(space, account.id, request.role, transaction)
      const joined = account.id === actor.userId
      await this.audit.record({
        ...(joined
          ? { action: 'spaces.admin_joined', details: { role: member.role } } as const
          : { action: 'spaces.member_added', details: { userId: member.userId, role: member.role } } as const),
        actor: { type: 'user', id: actor.userId },
        target: { type: 'space', id: space.id },
        origin,
      }, { transaction })
      return toSpaceMember(member, account)
    })
  }

  /**
   * 调整角色：至少保留一个空间管理员（LAST_SPACE_ADMIN）；角色有变化时经收回写入权的入口（由入口判断谁失去了写入权），记审计。
   * 可以调整自己的角色（不是最后一个空间管理员时），之后立即失去相应的权限
   */
  async changeRole(principal: Principal, spaceId: string, userId: string, role: SpaceRole, origin: AuditOrigin): Promise<SpaceMember> {
    const member = await this.transactions.run(async (transaction) => {
      const actor = await this.managed.actorOf(principal, transaction)
      await this.managed.check(actor, spaceId, 'manageMembers', transaction)
      const { space } = await this.managed.lock(actor, spaceId, 'manageMembers', transaction)
      const change = await this.spaces.changeMemberRole(space, userId, role, transaction)
      if (change.changed) {
        await this.writeAccess.revoke({ kind: 'membership', userId: change.member.userId, spaceId: space.id }, transaction)
        await this.audit.record({
          action: 'spaces.member_role_changed',
          actor: { type: 'user', id: actor.userId },
          target: { type: 'space', id: space.id },
          origin,
          details: { userId: change.member.userId, from: change.previousRole, to: change.member.role },
        }, { transaction })
      }
      return change.member
    })
    return this.withAccount(member)
  }

  /** 移出：空间角色带来的权限立即失效（经收回写入权的入口），至少保留一个空间管理员；记审计 */
  async remove(principal: Principal, spaceId: string, userId: string, origin: AuditOrigin): Promise<void> {
    await this.transactions.run(async (transaction) => {
      const actor = await this.managed.actorOf(principal, transaction)
      await this.managed.check(actor, spaceId, 'manageMembers', transaction)
      const { space } = await this.managed.lock(actor, spaceId, 'manageMembers', transaction)
      const removed = await this.spaces.removeMember(space, userId, transaction)
      await this.writeAccess.revoke({ kind: 'membership', userId: removed.userId, spaceId: space.id }, transaction)
      await this.audit.record({
        action: 'spaces.member_removed',
        actor: { type: 'user', id: actor.userId },
        target: { type: 'space', id: space.id },
        origin,
        details: { userId: removed.userId, role: removed.role },
      }, { transaction })
    })
  }

  /** 事务之后补上名字：不在事务里另从连接池取连接 */
  private async withAccount(member: SpaceMemberRecord): Promise<SpaceMember> {
    return toSpaceMember(member, this.accountOf(await this.users.findByIds([member.userId]), member.userId))
  }

  private accountOf(accounts: ReadonlyMap<string, User>, userId: string): User {
    const account = accounts.get(userId)
    // 成员行有外键指向账户，账户不删（只停用）：取不到说明数据不一致
    if (account === undefined)
      throw new Error(`成员的账户不存在：${userId}`)
    return account
  }
}

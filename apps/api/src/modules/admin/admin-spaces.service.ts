import type { AdminSpace, AdminSpaceListQuery, AdminSpaceListResponse, AuditActionDetailsInput, CreateTeamSpaceRequest, SpaceStatus } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SpaceChange, SpaceRecord } from '../spaces/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { WriteAccessRevocation } from '../documents/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'
import { actorOf, toAdminSpace } from './admin-views.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 空间状态的改动记的审计：动作与明细一起给出（明细按动作的严格结构） */
type SpaceChangeAudit = Extract<AuditActionDetailsInput, { action: 'spaces.visibility_changed' | 'spaces.archived' | 'spaces.restored' }>

/**
 * 管理界面的团队空间（M2-P2 设计 §3.9，US-M2-05）：列表、创建（连同首个空间管理员）、全员可见、归档与恢复。
 * 事务第一步取 system-admins 的共享锁复核操作者（ADR-007 的补充）；没有变化的操作原样返回、不记审计（沿用 P1）。
 * 改名与成员管理，系统管理员用空间的接口（workspace），那里的授权规则包含系统管理员。
 */
@Injectable()
export class AdminSpacesService {
  constructor(
    private readonly users: UsersService,
    private readonly spaces: SpacesService,
    private readonly writeAccess: WriteAccessRevocation,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 团队空间的列表：在只读快照里读（M2 Codex 评审 CX1） */
  async list(actor: Principal, query: AdminSpaceListQuery): Promise<AdminSpaceListResponse> {
    return this.transactions.readSnapshot(async (transaction) => {
      const page = await this.spaces.listTeamSpaces(actor.user.id, query, { transaction })
      return { items: page.items.map(toAdminSpace), nextCursor: page.nextCursor }
    })
  }

  /**
   * 创建：首个空间管理员必须是有效账户（以共享锁持住，到提交之前不会被停用），否则 ACCOUNT_UNAVAILABLE；
   * 名称已被使用时 SPACE_NAME_TAKEN。锁的顺序：system-admins 的锁 → 账户行 → 新的空间与成员行
   */
  async create(actor: Principal, request: CreateTeamSpaceRequest, origin: HttpOrigin): Promise<AdminSpace> {
    return this.transactions.run(async (transaction) => {
      await this.users.lockActingAdmin(actor.user.id, transaction)
      const admin = await this.users.holdActiveAccount(request.adminUserId, transaction)
      if (admin === undefined)
        throw new AppError('ACCOUNT_UNAVAILABLE')
      const space = await this.spaces.createTeamSpace({ name: request.name, adminUserId: admin.id, visibleToAll: request.visibleToAll, createdBy: actor.user.id }, transaction)
      await this.audit.record({
        action: 'spaces.created',
        actor: actorOf(actor),
        target: { type: 'space', id: space.id },
        origin,
        details: { adminUserId: admin.id, visibleToAll: space.visibleToAll },
      }, { transaction })
      return this.overview(actor, space.id, transaction)
    })
  }

  /** 全员可见：打开时所有有效账户都是查看者；关上不收回写入权（全员可见只带来查看） */
  async setVisibility(actor: Principal, spaceId: string, visibleToAll: boolean, origin: HttpOrigin): Promise<AdminSpace> {
    return this.change(actor, spaceId, origin, async (space, transaction) => ({
      change: await this.spaces.setVisibility(space, visibleToAll, transaction),
      audit: { action: 'spaces.visibility_changed', details: { visibleToAll } },
    }))
  }

  /** 归档：所有人至多是查看者，经收回写入权的入口（整个空间）；恢复不收回 */
  async setStatus(actor: Principal, spaceId: string, status: SpaceStatus, origin: HttpOrigin): Promise<AdminSpace> {
    return this.change(actor, spaceId, origin, async (space, transaction) => {
      const change = await this.spaces.setStatus(space, status, transaction)
      if (change.changed && status === 'archived')
        await this.writeAccess.revoke({ kind: 'space', spaceId: space.id }, transaction)
      return { change, audit: { action: status === 'archived' ? 'spaces.archived' : 'spaces.restored' } }
    })
  }

  /**
   * 改动团队空间的共同步骤：复核操作者 → 判断是团队空间（不加锁）→ 锁住空间行、锁下再判断 → 改 → 有变化时记审计。
   * 个人空间对系统管理员始终看不到（00 号计划书 §5.2），与不存在一样是 NOT_FOUND，而且不在它的行上取锁（M2-P2 审查 A4）
   */
  private async change(
    actor: Principal,
    spaceId: string,
    origin: HttpOrigin,
    apply: (space: SpaceRecord, transaction: Transaction) => Promise<{ change: SpaceChange, audit: SpaceChangeAudit }>,
  ): Promise<AdminSpace> {
    return this.transactions.run(async (transaction) => {
      await this.users.lockActingAdmin(actor.user.id, transaction)
      if ((await this.spaces.accessFactsOf(actor.user.id, spaceId, { transaction }))?.type !== 'team')
        throw new AppError('NOT_FOUND')
      const space = await this.spaces.lockSpace(spaceId, transaction)
      if (space?.type !== 'team')
        throw new AppError('NOT_FOUND')
      const { change, audit } = await apply(space, transaction)
      if (change.changed)
        await this.audit.record({ ...audit, actor: actorOf(actor), target: { type: 'space', id: space.id }, origin }, { transaction })
      return this.overview(actor, space.id, transaction)
    })
  }

  private async overview(actor: Principal, spaceId: string, transaction: Transaction): Promise<AdminSpace> {
    const overview = await this.spaces.teamSpaceOverview(actor.user.id, spaceId, transaction)
    if (overview === undefined)
      throw new Error(`团队空间不在了：${spaceId}`)
    return toAdminSpace(overview)
  }
}

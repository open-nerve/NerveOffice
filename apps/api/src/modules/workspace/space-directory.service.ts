import type { SpaceListResponse, SpaceView, TeamSpace } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { Actor } from '../documents/index.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { DocumentAccessPolicy, requireSpaceContent } from '../documents/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { ManagedSpaces } from './managed-space.ts'
import { toSpaceView, toTeamSpace } from './workspace-views.ts'

/** 我能看到的空间与空间页头、改名（M2-P2 设计 §3.3）。 */
@Injectable()
export class SpaceDirectoryService {
  constructor(
    private readonly policy: DocumentAccessPolicy,
    private readonly spaces: SpacesService,
    private readonly managed: ManagedSpaces,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 左侧导航：个人空间、我是成员的团队空间、全员可见的团队空间（含已归档的）。在只读快照里读（M2 Codex 评审 CX1） */
  async list(actor: Actor): Promise<SpaceListResponse> {
    return this.transactions.readSnapshot(async transaction => ({ items: (await this.policy.visibleSpaces(actor, transaction)).map(toSpaceView) }))
  }

  /** 空间页头：看不到与不存在都是 NOT_FOUND（没有加入的系统管理员看不到团队空间的内容）。在只读快照里读（M2 Codex 评审 CX1） */
  async get(actor: Actor, spaceId: string): Promise<SpaceView> {
    return this.transactions.readSnapshot(async transaction => toSpaceView(await requireSpaceContent(this.policy, actor, spaceId, 'view', transaction)))
  }

  /** 改名：团队空间的空间管理员（空间没有归档）或系统管理员；名称没有变化时原样返回、不记审计 */
  async rename(principal: Principal, spaceId: string, name: string, origin: AuditOrigin): Promise<TeamSpace> {
    return this.transactions.run(async (transaction) => {
      const actor = await this.managed.actorOf(principal, transaction)
      await this.managed.check(actor, spaceId, 'rename', transaction)
      const { space } = await this.managed.lock(actor, spaceId, 'rename', transaction)
      const change = await this.spaces.rename(space, name, transaction)
      if (change.changed) {
        await this.audit.record({
          action: 'spaces.renamed',
          actor: { type: 'user', id: actor.userId },
          target: { type: 'space', id: spaceId },
          origin,
          details: { from: space.name, to: change.space.name },
        }, { transaction })
      }
      return toTeamSpace(change.space)
    })
  }
}

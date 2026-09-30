import type { AdminUserDocumentListQuery, AdminUserDocumentListResponse, TransferDocumentsRequest, TransferDocumentsResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SpaceRecord } from '../spaces/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { inIdOrder } from '../../shared/id-order.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { DocumentTransferService } from '../documents/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'
import { actorOf } from './admin-views.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 目标空间看不到（不存在、写成团队空间的个人空间）时的说明：锁前与锁下两处判断用同一句 */
const TARGET_MISSING = '目标空间不存在'

/**
 * 停用者文档的转移（M2-P2 设计 §3.8，US-M2-04）：标题列表与整批转移。转移时系统管理员只看得到标题，不能打开内容；
 * 转移不经内容权限（授权是系统角色，事务第一步在锁里复核）。
 */
@Injectable()
export class AdminTransferService {
  constructor(
    private readonly users: UsersService,
    private readonly spaces: SpacesService,
    private readonly transfers: DocumentTransferService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 停用者个人空间里的文档标题：账户不存在 NOT_FOUND；账户仍然有效时 ACCOUNT_NOT_DISABLED（个人空间的内容对系统管理员不可见） */
  async titles(userId: string, query: AdminUserDocumentListQuery): Promise<AdminUserDocumentListResponse> {
    const account = (await this.users.findByIds([userId])).get(userId)
    const personalSpaceId = await this.personalSpaceIdOf(this.requireDisabled(account), undefined)
    return this.transfers.titles(personalSpaceId, query.cursor)
  }

  /**
   * 整批转移到某个有效账户的个人空间，或某个没有归档的团队空间。一个事务，锁的顺序（M2-P2 设计 §3.8、§3.9）：
   * system-admins 的共享锁（复核操作者）→ 账户行（来源与目标，按 id）→ 空间行（来源与目标，FOR SHARE，按 id）→ 文档行（按 id）→ 审计。
   * 团队空间的目标在锁空间行之前先判断（不加锁），看不到的不取锁；锁下再判断。
   * 每份文档一条审计（来源与目标空间的 id，不记标题）。目标不能是操作者自己的个人空间：转移不能拿来打开内容
   * （00 号计划书 §5.4 "转移到其他人的个人空间"，M2-P2 审查 A7），PERMISSION_DENIED
   */
  async transfer(actor: Principal, userId: string, request: TransferDocumentsRequest, origin: HttpOrigin): Promise<TransferDocumentsResponse> {
    const { target } = request
    if (target.type === 'personal' && target.userId === actor.user.id)
      throw new AppError('PERMISSION_DENIED', '不能转移到自己的个人空间')
    return this.transactions.run(async (transaction) => {
      await this.users.lockActingAdmin(actor.user.id, transaction)

      const accounts = new Map<string, User | undefined>()
      for (const id of inIdOrder(target.type === 'personal' ? [userId, target.userId] : [userId]))
        accounts.set(id, await this.users.holdAccount(id, transaction))
      const source = this.requireDisabled(accounts.get(userId))
      // 目标账户要有效：来源是停用的，所以目标不会是来源本人
      if (target.type === 'personal' && accounts.get(target.userId)?.status !== 'active')
        throw new AppError('ACCOUNT_UNAVAILABLE')

      const fromSpaceId = await this.personalSpaceIdOf(source, transaction)
      const toSpaceId = target.type === 'personal' ? await this.personalSpaceIdOf({ id: target.userId }, transaction) : target.spaceId
      // 团队空间的目标先判断（不加锁）：写成团队空间的个人空间与不存在的一样是 NOT_FOUND，执行同样的查询，不在它的行上取锁（M2-P2 复验 N1）
      if (target.type === 'team' && (await this.spaces.accessFactsOf(actor.user.id, toSpaceId, { transaction }))?.type !== 'team')
        throw new AppError('NOT_FOUND', TARGET_MISSING)
      const spaces = new Map<string, SpaceRecord | undefined>()
      for (const id of inIdOrder([fromSpaceId, toSpaceId]))
        spaces.set(id, await this.spaces.holdSpace(id, transaction))
      const destination = this.requireTarget(spaces.get(toSpaceId), target.type)

      const moved = await this.transfers.transfer(request.documentIds, fromSpaceId, destination.id, transaction)
      for (const documentId of moved) {
        await this.audit.record({
          action: 'documents.transferred',
          actor: actorOf(actor),
          target: { type: 'document', id: documentId },
          origin,
          details: { fromSpaceId, toSpaceId: destination.id },
        }, { transaction })
      }
      return { transferred: moved.length }
    })
  }

  private requireDisabled(account: User | undefined): User {
    if (account === undefined)
      throw new AppError('NOT_FOUND')
    if (account.status !== 'disabled')
      throw new AppError('ACCOUNT_NOT_DISABLED')
    return account
  }

  /** 目标空间：团队空间要存在、没有归档；目标是个人空间时就是那个人的个人空间 */
  private requireTarget(space: SpaceRecord | undefined, type: 'personal' | 'team'): SpaceRecord {
    if (space === undefined || space.type !== type)
      throw new AppError('NOT_FOUND', TARGET_MISSING)
    if (space.status === 'archived')
      throw new AppError('SPACE_ARCHIVED')
    return space
  }

  private async personalSpaceIdOf(account: Pick<User, 'id'>, transaction: Transaction | undefined): Promise<string> {
    const space = await this.spaces.personalSpaceOf(account.id, { transaction })
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${account.id}`)
    return space.id
  }
}

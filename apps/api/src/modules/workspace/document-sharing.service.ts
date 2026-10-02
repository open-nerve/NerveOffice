import type { AuditActionDetailsInput, DocumentGrant, DocumentGrantListResponse, GrantRole } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { Actor, DocumentGrantRecord, GrantChange } from '../documents/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { DocumentGrantsService } from '../documents/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'
import { compareMembers, toDocumentGrant } from './workspace-views.ts'

/**
 * 分享（M2-P5 设计 §3.2、§3.4(3)，US-M2-10）：一份文档的单独授权的查看、设置与调整、取消。
 * 写入由这里编排：要锁被授权人的账户行，documents 不依赖 users（与成员管理同一个做法，space-membership.service.ts）。
 * 规则与文档这一段（判断、锁文档行、锁下复核、写授权、收回写入权）在 documents 的 DocumentGrantsService；
 * 这里负责事务、被授权人的账户行、空间行、审计与拼响应。一个写请求只有这一个业务事务，提交之后不再访问数据库。
 *
 * 写入的顺序（一个事务里）：不加锁判断（看不到 404、不能分享 403，归档时冻结的说明只给恢复之后能分享的人；PUT 给自己 400）
 * → PUT 持住被授权人的账户行（FOR SHARE，不存在或已停用 409；DELETE 不锁：停用的人的授权也要能取消）
 * → 持住第一步看到的空间的行（FOR SHARE）→ documents 锁文档行（FOR UPDATE）并锁下复核 → 读写授权、收回写入权 → 审计
 * → 在同一个事务里补人名、拼好响应。锁的顺序是"账户行 → 空间行 → 文档行"（ADR-007、ADR-014 的全局顺序）：
 * 账户行放在文档行之后，会与"先锁账户行、再动文档"的操作（停用；M3 起停用还要收回他持有的租约）互相等待。不取空间树的锁：授权不改目录结构。
 * 每把锁都有确定交错的用例（tests/integration 的 documents/sharing-locks.test.ts）
 */
@Injectable()
export class DocumentSharingService {
  constructor(
    private readonly grants: DocumentGrantsService,
    private readonly spaces: SpacesService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 授权列表：要有分享的权限（规则在 documents）；含停用的人的授权（带状态），先按角色、再按显示名排序 */
  async list(actor: Actor, documentId: string): Promise<DocumentGrantListResponse> {
    const grants = await this.grants.list(actor, documentId)
    const accounts = await this.users.findByIds(grants.flatMap(grant => [grant.userId, grant.grantedBy]))
    return { items: grants.map(grant => toDocumentGrant(grant, accounts)).sort(compareMembers) }
  }

  /**
   * 设置或调整授权（按状态幂等）：新建记 documents.shared，调整记 documents.share_changed（编辑者降为查看者时 documents 在同一个事务里
   * 收回他在这份文档上的写入权）；已有同样的角色时什么都不写（不记审计、不收回），照样 200，返回这一条授权
   */
  async set(actor: Actor, documentId: string, userId: string, role: GrantRole, origin: AuditOrigin): Promise<DocumentGrant> {
    return this.transactions.run(async (transaction) => {
      const target = await this.grants.requireSharing(actor, documentId, transaction)
      // 先判断文档、再看被授权人（设计 §3.2）：看不到的文档不论被授权人是谁都是 404。
      // 路径里的 id 已由契约统一成小写（userIdSchema），与会话里的 id 可以直接比较；表上另有"被授权人不是设置人"的 CHECK 兜底
      if (userId === actor.userId)
        throw new AppError('REQUEST_INVALID', '不能把文档分享给自己')
      const account = await this.users.holdActiveAccount(userId, transaction)
      if (account === undefined)
        throw new AppError('ACCOUNT_UNAVAILABLE')
      await this.spaces.holdSpace(target.spaceId, transaction)
      // 被授权人用数据库返回的 id（ADR-014 的约定）
      const change = await this.grants.set(actor, target, account.id, role, transaction)
      const audit = auditOf(change)
      if (audit !== undefined)
        await this.record(audit, actor, target.id, origin, transaction)
      return this.withPeople(change.grant, transaction)
    })
  }

  /** 取消授权（按状态幂等）：有这一条时删掉、记 documents.share_revoked（documents 收回他的写入权）；没有时什么都不写，照样 204 */
  async remove(actor: Actor, documentId: string, userId: string, origin: AuditOrigin): Promise<void> {
    await this.transactions.run(async (transaction) => {
      const target = await this.grants.requireSharing(actor, documentId, transaction)
      await this.spaces.holdSpace(target.spaceId, transaction)
      const removed = await this.grants.remove(actor, target, userId, transaction)
      // 明细用数据库返回的那一条（被授权人的 id、删掉之前的角色）
      if (removed !== undefined)
        await this.record({ action: 'documents.share_revoked', details: { userId: removed.userId, role: removed.role } }, actor, target.id, origin, transaction)
    })
  }

  /**
   * 在调用方的事务里补上被授权人与设置人的名字：用事务自己的连接，不留到提交之后——提交之后才读的话，这一步遇到数据库繁忙时
   * 授权已经改了，客户端却只能得到"结果未知"（M2-P6 第 3 片复验，与成员管理相同）
   */
  private async withPeople(grant: DocumentGrantRecord, transaction: Transaction): Promise<DocumentGrant> {
    return toDocumentGrant(grant, await this.users.findByIds([grant.userId, grant.grantedBy], transaction))
  }

  /** 动作与明细一起给出：明细按动作的严格结构（contracts 的 auditDetailsSchema），只记定长标量，不记标题 */
  private async record(
    audit: SharingAudit,
    actor: Actor,
    documentId: string,
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<void> {
    await this.audit.record({
      ...audit,
      actor: { type: 'user', id: actor.userId },
      target: { type: 'document', id: documentId },
      origin,
    }, { transaction })
  }
}

/** 分享的三个审计动作与明细 */
type SharingAudit = Extract<AuditActionDetailsInput, { action: 'documents.shared' | 'documents.share_changed' | 'documents.share_revoked' }>

/** 设置授权要记的审计：新建与调整各一种，没有变化时不记 */
function auditOf(change: GrantChange): SharingAudit | undefined {
  switch (change.kind) {
    case 'created':
      return { action: 'documents.shared', details: { userId: change.grant.userId, role: change.grant.role } }
    case 'changed':
      return { action: 'documents.share_changed', details: { userId: change.grant.userId, from: change.previousRole, to: change.grant.role } }
    case 'unchanged':
      return undefined
  }
}

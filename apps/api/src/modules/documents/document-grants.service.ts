import type { GrantRole } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { GrantRow } from './document-grants.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { atLeast } from './access-rules.ts'
import { DocumentAccessPolicy, requireDocumentContent } from './document-access-policy.ts'
import { DocumentGrantsRepository } from './document-grants.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { WriteAccessRevocation } from './write-access.ts'

/** 一条单独授权：被授权人与角色、最后设置它的人与时间（人名由 workspace 经 users 补上） */
export type DocumentGrantRecord = GrantRow

/**
 * 要分享的文档：不加锁判断时读到的 id 与所在的空间。调用方按 spaceId 持住空间行（FOR SHARE）之后才写，
 * 写入时在文档行的锁下核对它仍在这个空间里（见 DocumentGrantsService.lockForSharing）
 */
export interface SharingTarget {
  readonly id: string
  readonly spaceId: string
}

/** 设置授权的结果：新建；调整（原来的角色）；没有变化（同样的角色：什么都没写，调用方不记审计） */
export type GrantChange
  = | { readonly kind: 'created', readonly grant: DocumentGrantRecord }
    | { readonly kind: 'changed', readonly grant: DocumentGrantRecord, readonly previousRole: GrantRole }
    | { readonly kind: 'unchanged', readonly grant: DocumentGrantRecord }

/**
 * 单独授权的规则与数据（M2-P5 设计 §3.2、§3.4(3)）：判断能不能分享、在调用方的事务里锁文档行并锁下复核、写授权、收回写入权。
 * 写入的编排在 workspace（DocumentSharingService）：它要锁被授权人的账户行，documents 不依赖 users（与成员管理同一个做法）。
 * 事务、账户行、空间行、审计与拼响应都在那里；这里只做文档这一段，锁的全局顺序是"账户行 → 空间行 → 文档行"（ADR-007、ADR-014）。
 *
 * 能不能分享只经访问策略判断（requireDocumentContent 的 share：空间管理员或个人空间的所有者，结构性的操作只看空间角色），
 * 归档的空间里冻结，给冻结的说明（SHARING_FROZEN_MESSAGE）。文档行取 FOR UPDATE（lockById）：复制对源文档取 FOR SHARE、
 * 保存对文档取 FOR UPDATE，都在锁下重新读这个人的授权，所以取消或降级提交之后的复制与保存一定看到变化（设计 §3.4(3)）
 */
@Injectable()
export class DocumentGrantsService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly grants: DocumentGrantsRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly writeAccess: WriteAccessRevocation,
  ) {}

  /**
   * 这份文档的授权列表：要有分享的权限才看得到（被授权人列表本身是分享的一部分）；看不到与不存在都是 NOT_FOUND，
   * 看得到却不能分享是 PERMISSION_DENIED（归档时给冻结的说明）
   */
  async list(actor: Actor, documentId: string): Promise<DocumentGrantRecord[]> {
    await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId), ['share'])
    return this.grants.listFor(documentId)
  }

  /**
   * 写入之前不加锁的判断（设计 §3.4(3) 第 1 步）：看不到 NOT_FOUND（与不存在执行同样的语句）；不能分享 PERMISSION_DENIED。
   * 看不到与不能做的请求不取任何锁。返回文档与它所在的空间：调用方随后持住这个空间的行
   */
  async requireSharing(actor: Actor, documentId: string, transaction: Transaction): Promise<SharingTarget> {
    const { document } = await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), ['share'], transaction)
    return { id: document.id, spaceId: document.spaceId }
  }

  /**
   * 设置或调整授权（调用方已持住被授权人的账户行与 target.spaceId 的空间行）：锁文档行、锁下复核，再按现有的授权
   * 新建、调整或什么都不写。编辑者降为查看者时在同一个事务里收回"这个人在这份文档上"的写入权（userDocuments，
   * 不能用 documents：那是这些文档上的所有人）；查看者升为编辑者不收回。同样的角色什么都不写：不改设置人与时间、不收回
   */
  async set(actor: Actor, target: SharingTarget, granteeId: string, role: GrantRole, transaction: Transaction): Promise<GrantChange> {
    await this.lockForSharing(actor, target, transaction)
    const existing = await this.grants.find(target.id, granteeId, transaction)
    if (existing === undefined)
      return { kind: 'created', grant: await this.grants.insert({ documentId: target.id, userId: granteeId, role, grantedBy: actor.userId }, transaction) }
    if (existing.role === role)
      return { kind: 'unchanged', grant: existing }
    const grant = await this.grants.updateRole(target.id, granteeId, role, actor.userId, transaction)
    // 收回的范围用数据库返回的 id（ADR-014 的约定，与成员管理相同）
    if (!atLeast(grant.role, existing.role))
      await this.writeAccess.revoke({ kind: 'userDocuments', userId: grant.userId, documentIds: [grant.documentId] }, transaction)
    return { kind: 'changed', grant, previousRole: existing.role }
  }

  /**
   * 取消授权（调用方已持住 target.spaceId 的空间行；不锁被授权人的账户行：停用的人的授权也要能取消）：锁文档行、锁下复核，
   * 删掉这一条并收回他在这份文档上的写入权；没有这一条时什么也不写，返回 undefined（按状态幂等，接口照样 204）
   */
  async remove(actor: Actor, target: SharingTarget, userId: string, transaction: Transaction): Promise<DocumentGrantRecord | undefined> {
    await this.lockForSharing(actor, target, transaction)
    const removed = await this.grants.delete(target.id, userId, transaction)
    if (removed !== undefined)
      await this.writeAccess.revoke({ kind: 'userDocuments', userId: removed.userId, documentIds: [removed.documentId] }, transaction)
    return removed
  }

  /**
   * 锁住文档行（FOR UPDATE）并在锁下复核（设计 §3.4(3) 第 4 步），按这个顺序：
   * 1. 文档还在、没进回收站（lockById 只取正常状态的行）；
   * 2. 仍在调用方持住的那个空间里，不在就 NOT_FOUND——与 8 处树锁下的核对（清单见 FoldersService.update）、复制对源文档的核对同一个做法：
   *    跨空间移动可以插在不加锁的判断与持住空间行之间，这时锁下读到的是新空间，而新空间的行没被持住，归档就能并发提交、冻结被绕过。
   *    先核对空间、再判断权限：新空间里的权限没被持住，按它判断出的结果不可靠；
   * 3. 空间没归档、自己仍是空间管理员或所有者（访问策略的 share；看不到了是 NOT_FOUND）。
   * 确定交错的用例在 tests/integration 的 documents/sharing-locks.test.ts
   */
  private async lockForSharing(actor: Actor, target: SharingTarget, transaction: Transaction): Promise<void> {
    const locked = await this.documents.lockById(target.id, transaction)
    if (locked !== undefined && locked.spaceId !== target.spaceId)
      throw new AppError('NOT_FOUND')
    await requireDocumentContent(this.policy, actor.userId, locked, ['share'], transaction)
  }
}

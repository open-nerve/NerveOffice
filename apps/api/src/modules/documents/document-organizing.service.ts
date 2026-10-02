import type { AuditActionDetailsInput, DocumentDetail } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { DocumentAccess } from './access-rules.ts'
import type { AccessibleDocument, Actor, DocumentOperation } from './document-access-policy.ts'
import type { DocumentRow } from './documents.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { inIdOrder } from '../../shared/id-order.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { documentAccessIn, DocumentAccessPolicy, requireCreateTarget, requireDocumentContent } from './document-access-policy.ts'
import { toDetail } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { folderIdIn } from './folder-location.ts'
import { FoldersRepository } from './folders.repository.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { WriteAccessRevocation } from './write-access.ts'

/** 改名或在同一个空间里移动（已经过 contracts 的校验）：两项都没有时什么也不改。 */
export interface UpdateDocumentCommand {
  readonly title?: string | undefined
  /** null 表示移到空间的根目录；undefined 表示不移动 */
  readonly folderId?: string | null | undefined
}

/** 移动到某个空间的某个位置（已经过 contracts 的校验）。 */
export interface MoveDocumentCommand {
  readonly spaceId: string
  /** 目标空间里的文件夹；没有时是那个空间的根目录 */
  readonly folderId?: string | undefined
}

/**
 * 文档的整理（M2-P4 设计 §3.2、§3.4，US-M2-07）：改名、在同一个空间里移动、移动到别的空间。
 * 都是结构性的改动，所以在事务的第一步取空间树的 advisory lock（跨空间时按空间 id 排序取两把），
 * 再按顺序取空间行、文档行，锁下重新判断一次权限（ADR-007 的锁顺序）。
 * 复制见 DocumentCopyService；停用者文档的整批转移是系统管理员的操作，另见 DocumentTransferService。
 */
@Injectable()
export class DocumentOrganizingService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly folders: FoldersRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
    private readonly writeAccess: WriteAccessRevocation,
  ) {}

  /**
   * 改名或在同一个空间里移动：要有编辑者及以上的角色；没有变化的那一项不改、不记审计。
   * 写入代次不变（00 号计划书 §6.4：空间内移动不递增），进行中的编辑不受影响。
   */
  async update(actor: Actor, id: string, command: UpdateDocumentCommand, origin: AuditOrigin): Promise<DocumentDetail> {
    return this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能做的请求不取任何锁；看不到与不存在都是 NOT_FOUND
      const checked = await this.checkUpdate(actor, await this.documents.findById(id, transaction), command, transaction)
      await this.tree.lock([checked.document.spaceId], transaction)
      await this.spaces.holdSpace(checked.document.spaceId, transaction)
      // 锁下重新读、重新判断：这期间它可能被移走、被删，空间可能被归档，自己可能被移出空间
      const { document, access } = await this.checkUpdate(actor, await this.documents.lockById(id, transaction), command, transaction)
      // 树锁是按取锁之前读到的空间取的：万一刚好有一次跨空间移动提交了，这把锁就保护不到它（与文件夹的改动相同）。
      // 8 处锁下核对之一（清单见 FoldersService.update）；这一处与 move 那一处的集成用例在 tests/integration 的
      // documents/structure-locks.test.ts（M2-P6 复核 A 的 M-1、B 的 B1）
      if (document.spaceId !== checked.document.spaceId)
        throw new AppError('NOT_FOUND')

      let current = document
      if (command.title !== undefined && command.title !== current.title) {
        current = await this.documents.rename(current.id, command.title, transaction)
        // 只记位置，不记改动前后的标题（M2 总设计 §2.1 第 5 条，M2-P6 复核 M-1）：系统管理员能查审计，却看不到别人空间里的标题
        await this.record({ action: 'documents.renamed', details: { spaceId: current.spaceId, folderId: current.folderId } }, actor, current, origin, transaction)
      }
      if (command.folderId !== undefined) {
        const folderId = await folderIdIn(this.folders, current.spaceId, command.folderId, transaction)
        if (folderId !== current.folderId)
          current = await this.moved(actor, current, folderId, origin, transaction)
      }
      return toDetail(current, access, actor.userId)
    })
  }

  /**
   * 移动到某个空间的某个位置（M2-P4 设计 §3.2）：
   * - 目标是别的空间：要源空间的空间管理员角色 + 目标空间的新建权限（00 号计划书 §5.3）；
   *   同一个事务里写入代次加一并收回写入权（§5.4：权限随之改变，移动时终止编辑租约）；
   * - 目标就是现在所在的空间：与空间内移动同一条规则（编辑者及以上），代次不变——
   *   移动成功之后重试同一个请求因此是幂等的，不会白白递增代次。
   */
  async move(actor: Actor, id: string, command: MoveDocumentCommand, origin: AuditOrigin): Promise<DocumentDetail> {
    return this.transactions.run(async (transaction) => {
      // 先判断（不加锁）：看不到与不能做的请求不取任何锁
      const checked = await this.checkMove(actor, await this.documents.findById(id, transaction), command, transaction)
      // 两个空间的树锁一起取（目标就是本空间时只有一把）：防成环的取锁顺序由 SpaceTreeRepository 一处负责，
      // 服务只把牵涉到的空间一起交给它；空间行在这里按同一个顺序（id）取，两个方向的跨空间移动同时发生时不成环
      const involved = [...new Set([checked.document.spaceId, command.spaceId])]
      await this.tree.lock(involved, transaction)
      for (const spaceId of inIdOrder(involved))
        await this.spaces.holdSpace(spaceId, transaction)
      // 锁下重新读、重新判断：来源与目标的权限、归档状态都以锁下的为准
      const { document, access, target } = await this.checkMove(actor, await this.documents.lockById(id, transaction), command, transaction)
      // 同上：树锁按取锁之前读到的空间取，刚好被跨空间移走时这把锁保护不到它
      if (document.spaceId !== checked.document.spaceId)
        throw new AppError('NOT_FOUND')

      const folderId = await folderIdIn(this.folders, command.spaceId, command.folderId ?? null, transaction)
      if (document.spaceId === command.spaceId) {
        const current = folderId === document.folderId ? document : await this.moved(actor, document, folderId, origin, transaction)
        return toDetail(current, access, actor.userId)
      }
      const moved = await this.toSpace(actor, document, command.spaceId, folderId, origin, transaction)
      return toDetail(moved, target, actor.userId)
    })
  }

  /** 判断这次改动要的权限：改名要改名的权限，移动要移动的权限，两项都给就两项都要（一条查询判断完）。 */
  private async checkUpdate(
    actor: Actor,
    document: DocumentRow | undefined,
    command: UpdateDocumentCommand,
    transaction: Transaction,
  ): Promise<AccessibleDocument<DocumentRow>> {
    const operations: DocumentOperation[] = []
    if (command.title !== undefined)
      operations.push('rename')
    if (command.folderId !== undefined)
      operations.push('moveWithinSpace')
    // 两项都没有给时也判断一次：不存在与看不到执行同样的查询、给同样的响应
    return requireDocumentContent(this.policy, actor.userId, document, operations, transaction)
  }

  /**
   * 判断移动要的权限：目标是别的空间时要源空间的空间管理员，还要目标空间的新建权限（目标已归档是 409）；
   * 目标就是现在所在的空间时只要编辑者及以上，不再判断一次目标空间（归档时上一步就拒绝了，403 说明空间已归档）。
   * 两项都只看空间角色：只凭授权的人一律 403（M2-P5 设计 §3.4(1)）。target 是移过去之后调用者在这份文档上的访问（拼响应用）
   */
  private async checkMove(
    actor: Actor,
    document: DocumentRow | undefined,
    command: MoveDocumentCommand,
    transaction: Transaction,
  ): Promise<AccessibleDocument<DocumentRow> & { readonly target: DocumentAccess }> {
    const sameSpace = document?.spaceId === command.spaceId
    const accessible = await requireDocumentContent(this.policy, actor.userId, document, [sameSpace ? 'moveWithinSpace' : 'moveAcrossSpaces'], transaction)
    if (sameSpace)
      return { ...accessible, target: accessible.access }
    const target = await requireCreateTarget(this.policy, actor, command.spaceId, 'createDocuments', transaction)
    return { ...accessible, target: documentAccessIn(target) }
  }

  /** 在同一个空间里换文件夹（调用方已锁住这一行、已判断权限与目标位置）。 */
  private async moved(actor: Actor, document: DocumentRow, folderId: string | null, origin: AuditOrigin, transaction: Transaction): Promise<DocumentRow> {
    const moved = await this.documents.moveToFolder(document.id, folderId, transaction)
    await this.recordMove(actor, moved, origin, { fromSpaceId: document.spaceId, fromFolderId: document.folderId }, transaction)
    return moved
  }

  /**
   * 移到别的空间（调用方已锁住这一行、已判断两边的权限与目标位置）：
   * 改所属空间与位置、写入代次加一，同一个事务里收回这份文档上的写入权（M3 在这个入口里终止租约）。
   */
  private async toSpace(
    actor: Actor,
    document: DocumentRow,
    spaceId: string,
    folderId: string | null,
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<DocumentRow> {
    const [moved] = await this.documents.moveToSpace([document.id], spaceId, folderId, transaction)
    if (moved === undefined)
      throw new Error(`移动时文档不在了：${document.id}`)
    await this.writeAccess.revoke({ kind: 'documents', documentIds: [document.id] }, transaction)
    await this.recordMove(actor, moved, origin, { fromSpaceId: document.spaceId, fromFolderId: document.folderId }, transaction)
    return moved
  }

  /** 移动的审计：原位置与目标位置都记下（空间与文件夹各一对），空间内移动时两个空间相同。 */
  private async recordMove(
    actor: Actor,
    moved: DocumentRow,
    origin: AuditOrigin,
    from: { readonly fromSpaceId: string, readonly fromFolderId: string | null },
    transaction: Transaction,
  ): Promise<void> {
    await this.record({ action: 'documents.moved', details: { ...from, toSpaceId: moved.spaceId, toFolderId: moved.folderId } }, actor, moved, origin, transaction)
  }

  /** 动作与明细一起给出：明细按动作的严格结构（contracts 的 auditDetailsSchema） */
  private async record(
    audit: Extract<AuditActionDetailsInput, { action: 'documents.renamed' | 'documents.moved' }>,
    actor: Actor,
    document: DocumentRow,
    origin: AuditOrigin,
    transaction: Transaction,
  ): Promise<void> {
    await this.audit.record({
      ...audit,
      actor: { type: 'user', id: actor.userId },
      target: { type: 'document', id: document.id },
      origin,
    }, { transaction })
  }
}

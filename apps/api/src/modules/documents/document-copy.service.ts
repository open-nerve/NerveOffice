import type { DocumentDetail } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { Actor, DocumentAccess } from './document-access-policy.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { DocumentRow } from './documents.repository.ts'
import { copiedDocumentTitle } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentAccessPolicy, requireCreateTarget, requireDocumentContent } from './document-access-policy.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { toDetail } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { folderIdIn } from './folder-location.ts'
import { FoldersRepository } from './folders.repository.ts'
import { copiedPayloadDigest } from './payload-digest.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'

/** 复制请求（已经过 contracts 的校验）。 */
export interface CopyDocumentCommand {
  /** 复制到哪个空间 */
  readonly spaceId: string
  /** 目标空间里的文件夹；没有时是那个空间的根目录 */
  readonly folderId?: string | undefined
  /** 副本的标题；没有时是"源标题 的副本" */
  readonly title?: string | undefined
  readonly requestId: string
}

/**
 * 复制一份文档（M2-P4 设计 §3.4 第 4 条，US-M2-08）：能读源文档 + 在目标空间有新建权限。
 * 副本是一份新文档：新的 id、修订号 1、写入代次 0、创建人是操作者，修订记录写一条（kind='created'）；
 * 不复制历史修订，也不复制单独授权（P5）。快照不经解析，由数据库直接复制压缩后的字节，副本与源逐字节一致（A10）；
 * unitId 原样复制（00 号计划书 §8.3）。requestId 幂等，与新建文档同一个做法。
 */
@Injectable()
export class DocumentCopyService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly folders: FoldersRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
  ) {}

  async copy(actor: Actor, id: string, command: CopyDocumentCommand, origin: AuditOrigin): Promise<DocumentDetail> {
    const userId = actor.userId
    // 摘要只按请求里的东西算（源文档、目标位置与请求里的标题）：源文档随后被改名也不影响重试按重放处理
    const digest = copiedPayloadDigest(id, command.spaceId, command.folderId, command.title)
    return this.transactions.run(async (transaction) => {
      // 同一个 requestId 的两次复制排队执行：后到的一方在下面就能看到前一方的修订记录，按重放处理（与新建文档相同，锁排在最前）
      await this.revisions.lockCreateRequest(command.requestId, transaction)
      const previous = await this.revisions.findByRequestId(command.requestId, transaction)
      if (previous !== undefined)
        return this.replay(userId, previous, digest, transaction)

      // 先判断（不加锁）：看不到源文档、不能在目标空间新建的请求不取任何锁
      const source = await requireDocumentContent(this.policy, userId, await this.documents.findById(id, transaction), ['copy'], transaction)
      const title = command.title ?? copiedDocumentTitle(source.document.title)
      await requireCreateTarget(this.policy, actor, command.spaceId, transaction)
      // 空间树的结构性改动串行：只取目标空间的锁，源文档不改动
      await this.tree.lock([command.spaceId], transaction)
      await this.spaces.holdSpace(command.spaceId, transaction)
      // 锁下再判断：与归档、移出成员互斥，它们提交之后的复制一定被拒绝
      const target = await requireCreateTarget(this.policy, actor, command.spaceId, transaction)
      const folderId = await folderIdIn(this.folders, command.spaceId, command.folderId ?? null, transaction)

      const copy = await this.documents.copyFrom(id, { spaceId: command.spaceId, folderId, title, createdBy: userId }, transaction)
      // 判断过之后源文档被删了（它不在这把锁的保护下）：按"没找到"回答，与一开始就看不到一致
      if (copy === undefined)
        throw new AppError('NOT_FOUND')
      if (!await this.contents.copyFrom(id, copy.id, transaction))
        throw new Error(`文档有记录却没有内容：${id}`)
      const revision = await this.revisions.insert({
        documentId: copy.id,
        revision: 1,
        kind: 'created',
        requestId: command.requestId,
        payloadDigest: digest,
        source: null,
        savedBy: userId,
      }, transaction)
      // 同一个 requestId 同时被一次保存用掉了（advisory lock 只让新建与复制之间排队）
      if (revision === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      await this.audit.record({
        action: 'documents.copied',
        actor: { type: 'user', id: userId },
        target: { type: 'document', id: copy.id },
        origin,
        details: { sourceId: id, sourceSpaceId: source.document.spaceId, spaceId: copy.spaceId, folderId: copy.folderId },
      }, { transaction })
      return toDetail(copy, { role: target.role, space: target.space }, userId)
    })
  }

  /**
   * 同一个 requestId 已经有修订记录：是同一个人、同一次复制（摘要一致），而且这个人仍能访问那份副本，
   * 才返回那份副本的当前元数据；否则拒绝，不透露那份文档的任何信息（与新建文档相同）。
   */
  private async replay(userId: string, previous: RevisionRow, digest: Buffer, transaction: Transaction): Promise<DocumentDetail> {
    const sameRequest = previous.kind === 'created' && previous.savedBy === userId && previous.payloadDigest.equals(digest)
    const document: DocumentRow | undefined = sameRequest ? await this.documents.findById(previous.documentId, transaction) : undefined
    const access: DocumentAccess | undefined = document === undefined ? undefined : await this.policy.accessOf(userId, document, transaction)
    if (document === undefined || access === undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    return toDetail(document, access, userId)
  }
}

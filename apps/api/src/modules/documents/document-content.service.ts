import type { RevisionConflictDetails, SaveContentQuery, SaveContentResponse } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { GzipBody } from '../security/index.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { DocumentRow } from './documents.repository.ts'
import { UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { canEdit, DocumentAccessPolicy, requireAccess } from './document-access-policy.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { savedPayloadDigest } from './payload-digest.ts'
import { validateSnapshot } from './snapshot-validation.ts'

/** 读取到的内容：gzip 压缩的快照 JSON 字节，与它对应的修订号（ETag）。 */
export interface DocumentContent {
  readonly revision: number
  readonly snapshot: Buffer
}

function toSaved(revision: RevisionRow): SaveContentResponse {
  return { revision: revision.revision, savedAt: revision.createdAt.toISOString() }
}

/** 文档的内容（P4 设计 §3.5）：读取当前快照；按基准修订号条件写入新的快照。 */
@Injectable()
export class DocumentContentService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
  ) {}

  /** 能读取就返回当前内容；别人的与不存在的都是 NOT_FOUND。有记录却没有内容是数据不一致，按意外错误处理，不伪装成 404。 */
  async read(userId: string, id: string): Promise<DocumentContent> {
    await requireAccess(this.policy, userId, await this.documents.findById(id))
    const content = await this.contents.findCurrent(id)
    if (content === undefined)
      throw new Error(`文档有记录却没有内容：${id}`)
    return content
  }

  /**
   * 保存（P4 设计 §3.5.1）：先做与文档无关的基本校验，再在一个事务里依次
   * 判断权限 → 锁住文档行 → 按 requestId 幂等 → 核对 unitId → 按基准修订号条件写入。
   * 先判断权限再加锁：没有权限的请求不在别人的文档上取锁，不让它的保存排队，响应的时序也与不存在的文档相同（审查 A2）。
   * 先锁文档再查幂等：同一个请求的两次并发重试，后到的一方拿到锁时前一方已经提交，按幂等返回原结果，而不是误报冲突。
   */
  async save(userId: string, id: string, query: SaveContentQuery, upload: GzipBody, origin: AuditOrigin): Promise<SaveContentResponse> {
    const snapshot = validateSnapshot(upload.decompressed)
    const digest = savedPayloadDigest(query.baseRevision, upload.decompressed)
    return this.transactions.run(async (transaction) => {
      const document = await this.lockEditable(userId, id, transaction)

      const previous = await this.revisions.findByRequestId(query.requestId, transaction)
      if (previous !== undefined)
        return this.replay(userId, document, previous, digest)

      if (snapshot.unitId !== document.unitId)
        throw new AppError('SNAPSHOT_INVALID', '表格内容不属于这份文档')
      if (query.baseRevision !== document.revision)
        throw await this.conflict(document, transaction)

      const next = document.revision + 1
      const revision = await this.revisions.insert({
        documentId: id,
        revision: next,
        kind: 'saved',
        requestId: query.requestId,
        payloadDigest: digest,
        source: { clientInstanceId: query.clientInstanceId, localSeq: query.localSeq },
        savedBy: userId,
      }, transaction)
      // 同一个 requestId 同时被另一份文档的保存或一次新建用掉了（它们锁的不是这一行）
      if (revision === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      await this.documents.advanceRevision(id, next, UNIVER_SDK_VERSION, transaction)
      if (!await this.contents.replace(id, { snapshot: upload.compressed, rawBytes: upload.decompressed.length }, transaction))
        throw new Error(`文档有记录却没有内容：${id}`)
      await this.audit.record({
        action: 'documents.content_saved',
        actor: { type: 'user', id: userId },
        target: { type: 'document', id },
        origin,
        details: { revision: next },
      }, { transaction })
      return toSaved(revision)
    })
  }

  /**
   * 判断能否编辑，再锁住文档行并返回锁下的最新状态（修订号等）。
   * 加锁之前文档可能已经移到别的空间（M2）：锁下的空间与判断权限时不同，就按锁下的状态再判断一次。
   */
  private async lockEditable(userId: string, id: string, transaction: Transaction): Promise<DocumentRow> {
    const checked = await requireAccess(this.policy, userId, await this.documents.findById(id, transaction), transaction)
    const locked = await this.documents.lockById(id, transaction)
    const { document, access } = locked?.spaceId === checked.document.spaceId
      ? { document: locked, access: checked.access }
      : await requireAccess(this.policy, userId, locked, transaction)
    if (!canEdit(access))
      throw new AppError('PERMISSION_DENIED', '只能查看这份文档，不能保存')
    return document
  }

  /** 同一个 requestId 已经有修订记录：是同一个人对这份文档的同一次保存（摘要一致）才返回原来的结果。 */
  private replay(userId: string, document: DocumentRow, previous: RevisionRow, digest: Buffer): SaveContentResponse {
    const sameRequest = previous.kind === 'saved' && previous.documentId === document.id && previous.savedBy === userId && previous.payloadDigest.equals(digest)
    if (!sameRequest)
      throw new AppError('REQUEST_ID_CONFLICT')
    return toSaved(previous)
  }

  /** 修订号冲突，详情带当前修订号及其来源：客户端据此判断是不是"自己追自己"（P4 设计 §3.5.2）。 */
  private async conflict(document: DocumentRow, transaction: Transaction): Promise<AppError> {
    const current = await this.revisions.findByRevision(document.id, document.revision, transaction)
    const details: RevisionConflictDetails = { currentRevision: document.revision, source: current?.source ?? null }
    return new AppError('DOCUMENT_REVISION_CONFLICT', undefined, { details })
  }
}

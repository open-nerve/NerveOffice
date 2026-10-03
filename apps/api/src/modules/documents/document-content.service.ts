import type { RevisionConflictDetails, SaveContentQuery, SaveContentResponse } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { GzipBody } from '../security/index.ts'
import type { AccessibleDocument } from './document-access-policy.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { DocumentRow } from './documents.repository.ts'
import type { EditingActor } from './edit-lease.service.ts'
import { UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { DocumentAccessPolicy, requireAccess, requireDocumentContent, requireDocumentOperations } from './document-access-policy.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { requestLeaseLoss } from './edit-lease-rules.ts'
import { requireActiveLogin } from './edit-lease.service.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { savedPayloadDigest } from './payload-digest.ts'
import { validateSnapshot } from './snapshot-validation.ts'

/** 读取到的内容：gzip 压缩的快照 JSON 字节，与它对应的修订号（ETag）。 */
export interface DocumentContent {
  readonly revision: number
  readonly snapshot: Buffer
}

/**
 * 谁在保存（M3-P1 设计 §3.4.4）：账户、这次登录（会话守卫认证过的），与请求头里的编辑租约令牌（没带时为 undefined，按没有租约处理）。
 * 控制器从 @CurrentPrincipal() 与 @EditLeaseToken() 取得
 */
export interface ContentSaver extends EditingActor {
  readonly token: string | undefined
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
    private readonly leases: EditLeasesRepository,
    private readonly sessions: SessionService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
  ) {}

  /**
   * 能读取就返回当前内容；别人的与不存在的都是 NOT_FOUND。有记录却没有内容是数据不一致，按意外错误处理，不伪装成 404。
   * 判断权限与读内容在同一个只读快照里（M2 Codex 评审 CX1）：原来先判断、再另读内容，判断之后撤权（取消授权、移出空间）、
   * 随即保存的新内容会被这个在途的请求带出去；现在读到的是判断权限的那一刻的内容
   */
  async read(userId: string, id: string): Promise<DocumentContent> {
    return this.transactions.readSnapshot(async (transaction) => {
      await requireAccess(this.policy, userId, await this.documents.findById(id, transaction), transaction)
      const content = await this.contents.findCurrent(id, transaction)
      if (content === undefined)
        throw new Error(`文档有记录却没有内容：${id}`)
      return content
    })
  }

  /**
   * 保存（P4 设计 §3.5.1，M3-P1 设计 §3.4.4）：先做与文档无关的基本校验，再在一个事务里依次
   * 判断能否访问 → 能编辑时锁住文档行、锁下再判断一次 → 按 requestId 幂等 → 这次登录仍然有效 → 能否编辑 → 编辑租约 → 核对 unitId
   * → 按基准修订号条件写入。
   * 幂等这一步只要求仍能访问（00 号计划书 §7.4 第 2 步）：一次结果未知的保存提交之后被降为查看者、空间被归档、租约失效或被别人接手，
   * 重发同一个请求照样拿到原来的结果，而不是 403 或编辑权已失效——客户端按约定会把它们当作"没有提交"（M2-P6 复核 A 的 S-4；
   * 重放先于租约，A07）；不是重放才核对登录、要求能编辑、再要求租约。
   * 登录在锁下再核对一次（M3-P1 审查 A1，requireActiveLogin）：会话守卫之后还隔着上传正文与等锁，这期间退出、签发重置（撤销全部登录）不经文档行，
   * 只看"请求的登录就是租约绑定的那一个"挡不住撤销之后才落库的保存；失效时 401，与守卫的回答一致。
   * 先判断再加锁：看不到的请求不在文档上取锁，响应的时序与不存在的文档相同（审查 A2）；只能查看的请求同样不取锁，
   * 不让能编辑的人的保存排队（复验 RA7）——它能得到的只有重放，不加锁查一次请求标识就有结论，到不了租约这一步。
   * 能编辑时先锁文档再查幂等：同一个请求的两次并发重试，后到的一方拿到锁时前一方已经提交，按幂等返回原结果，而不是误报冲突。
   */
  async save(saver: ContentSaver, id: string, query: SaveContentQuery, upload: GzipBody, origin: AuditOrigin): Promise<SaveContentResponse> {
    const snapshot = validateSnapshot(upload.decompressed)
    const digest = savedPayloadDigest(query.baseRevision, upload.decompressed)
    return this.transactions.run(async (transaction) => {
      const accessible = await this.lockIfEditable(saver.userId, id, transaction)
      const { document } = accessible

      const previous = await this.revisions.findByRequestId(query.requestId, transaction)
      if (previous !== undefined)
        return this.replay(saver.userId, document, previous, digest)
      await requireActiveLogin(this.sessions, saver, transaction)
      // 不是重放才要求能编辑：能编辑时这是锁下的判断，只能查看时就是上面那次（没有取锁）
      requireDocumentOperations(accessible, ['edit'])
      await this.requireLease(saver, document, query, transaction)

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
        savedBy: saver.userId,
      }, transaction)
      // 同一个 requestId 同时被另一份文档的保存或一次新建用掉了（它们锁的不是这一行）
      if (revision === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      await this.documents.advanceRevision(id, next, UNIVER_SDK_VERSION, transaction)
      if (!await this.contents.replace(id, { snapshot: upload.compressed, rawBytes: upload.decompressed.length }, transaction))
        throw new Error(`文档有记录却没有内容：${id}`)
      await this.audit.record({
        action: 'documents.content_saved',
        actor: { type: 'user', id: saver.userId },
        target: { type: 'document', id },
        origin,
        details: { revision: next },
      }, { transaction })
      return toSaved(revision)
    })
  }

  /**
   * 保存要求编辑租约（M3-P1 设计 §3.4.4）：令牌是当前这一行的、按有效条件有效（edit-lease-rules.ts 的 requestLeaseLoss）、
   * 代次等于查询参数的 writeEpoch、这次登录与查询参数的标签页都是租约绑定的，否则 EDIT_LEASE_LOST（details 带原因）。
   * 文档行已经锁住（能编辑的请求才走到这里），代次是锁下读到的；租约行不加锁读：能改写它的申请与收回写入权都要先拿文档行的锁。
   * 保存不续租（续租靠心跳）
   */
  private async requireLease(saver: ContentSaver, document: DocumentRow, query: SaveContentQuery, transaction: Transaction): Promise<void> {
    const lease = await this.leases.findByDocument(document.id, transaction)
    const loss = requestLeaseLoss(lease, document.writeEpoch, { token: saver.token, sessionId: saver.sessionId, clientInstanceId: query.clientInstanceId, writeEpoch: query.writeEpoch })
    if (loss !== undefined)
      throw new AppError('EDIT_LEASE_LOST', undefined, { details: { reason: loss } })
  }

  /**
   * 判断能否访问（别人的与不存在的都是 NOT_FOUND）；能编辑时再锁住文档行、锁下再判断一次，返回锁下的最新状态（修订号等）。
   * 锁下再判断：加锁之前文档可能已经移到别的空间，或者授权被收回了（M2），都按锁下的状态为准（复验 RA7）。
   * 只能查看的不取锁，返回不加锁读到的那一版：调用方拿它只能查重放，写入之前还要求能编辑。
   * 与改名、移动、删除走同一个判断（requireDocumentContent）：归档的空间里说明"空间已归档"，而不是"只能查看"
   */
  private async lockIfEditable(userId: string, id: string, transaction: Transaction): Promise<AccessibleDocument<DocumentRow>> {
    const unlocked = await requireDocumentContent(this.policy, userId, await this.documents.findById(id, transaction), [], transaction)
    if (!unlocked.permissions.canEdit)
      return unlocked
    return requireDocumentContent(this.policy, userId, await this.documents.lockById(id, transaction), [], transaction)
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

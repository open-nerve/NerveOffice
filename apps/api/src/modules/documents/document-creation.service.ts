import type { DocumentDetail, DocumentType } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { DEFAULT_DOCUMENT_TITLES, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentAccessPolicy, requireSpaceContent } from './document-access-policy.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { toDetail } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { createdPayloadDigest } from './payload-digest.ts'

/** 新建请求（已经过 contracts 的校验）。 */
export interface CreateDocumentCommand {
  readonly type: DocumentType
  readonly title?: string | undefined
  readonly requestId: string
  /** 建在哪个空间；没有时是本人的个人空间（M1 兼容） */
  readonly spaceId?: string | undefined
}

/** 各类型的模板快照：换上文档的 unitId 之后的 JSON 文本（P4 设计 §3.4）。 */
const TEMPLATES: Readonly<Record<DocumentType, (unitId: string) => string>> = { sheet: sheetSnapshotFor }

/**
 * 新建文档（M1-P4 设计 §3.4，M2-P2 设计 §3.6）：在指定的空间（没有指定时是个人空间）里建文档，内容取收敛的模板快照，修订号 1。
 * 要有新建权限：空间角色是编辑者及以上，空间没有归档。
 * requestId 幂等：同一个请求重试只建一份，重放返回那份文档的当前元数据；同一个 requestId 用于不同的请求时拒绝。
 */
@Injectable()
export class DocumentCreationService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
  ) {}

  async create(actor: Actor, command: CreateDocumentCommand, origin: AuditOrigin): Promise<DocumentDetail> {
    const userId = actor.userId
    const title = command.title ?? DEFAULT_DOCUMENT_TITLES[command.type]
    const digest = createdPayloadDigest(command.type, title, command.spaceId)
    return this.transactions.run(async (transaction) => {
      // 同一个 requestId 的两个请求排队执行：后到的一方在下面就能看到前一方的修订记录，按重放处理
      await this.revisions.lockCreateRequest(command.requestId, transaction)
      const previous = await this.revisions.findByRequestId(command.requestId, transaction)
      if (previous !== undefined)
        return this.replay(userId, previous, digest, transaction)

      const spaceId = command.spaceId ?? await this.personalSpaceIdOf(userId, transaction)
      // 先判断（不加锁）：看不到与不能新建的请求不在空间行上取锁。再取共享锁、锁下再判断：
      // 与归档、移出成员（空间行的 FOR NO KEY UPDATE）互斥，它们提交之后的新建一定被拒绝
      await requireSpaceContent(this.policy, actor, spaceId, 'createDocuments', transaction)
      await this.spaces.lockShared(spaceId, transaction)
      const access = await requireSpaceContent(this.policy, actor, spaceId, 'createDocuments', transaction)

      const unitId = randomUUID()
      const document = await this.documents.insert({
        spaceId,
        type: command.type,
        title,
        createdBy: userId,
        unitId,
        profile: DOCUMENT_PROFILE_OF[command.type],
        formatVersion: PLATFORM_FORMAT_VERSION,
        sdkVersion: UNIVER_SDK_VERSION,
      }, transaction)
      const raw = Buffer.from(TEMPLATES[command.type](unitId), 'utf8')
      await this.contents.insert(document.id, { snapshot: zlib.gzipSync(raw), rawBytes: raw.length }, transaction)
      const revision = await this.revisions.insert({
        documentId: document.id,
        revision: 1,
        kind: 'created',
        requestId: command.requestId,
        payloadDigest: digest,
        source: null,
        savedBy: userId,
      }, transaction)
      // 同一个 requestId 同时被一次保存用掉了（advisory lock 只让新建之间排队）
      if (revision === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      await this.audit.record({
        action: 'documents.created',
        actor: { type: 'user', id: userId },
        target: { type: 'document', id: document.id },
        origin,
        details: { revision: 1 },
      }, { transaction })
      return toDetail(document, access)
    })
  }

  /**
   * 同一个 requestId 已经有修订记录：是同一个人、同一个新建请求（摘要一致），而且这个人仍能访问那份文档，
   * 才返回那份文档的当前元数据；否则拒绝，不透露那份文档的任何信息。
   */
  private async replay(userId: string, previous: RevisionRow, digest: Buffer, transaction: Transaction): Promise<DocumentDetail> {
    const sameRequest = previous.kind === 'created' && previous.savedBy === userId && previous.payloadDigest.equals(digest)
    const document = sameRequest ? await this.documents.findById(previous.documentId, transaction) : undefined
    const access = document === undefined ? undefined : await this.policy.accessOf(userId, document, transaction)
    if (document === undefined || access === undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    return toDetail(document, access)
  }

  private async personalSpaceIdOf(userId: string, transaction: Transaction): Promise<string> {
    const space = await this.spaces.personalSpaceOf(userId, { transaction })
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${userId}`)
    return space.id
  }
}

import type { DocumentDetail, DocumentType } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
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
import { DocumentAccessPolicy } from './document-access-policy.ts'
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
}

/** 各类型的模板快照：换上文档的 unitId 之后的 JSON 文本（P4 设计 §3.4）。 */
const TEMPLATES: Readonly<Record<DocumentType, (unitId: string) => string>> = { sheet: sheetSnapshotFor }

/**
 * 新建文档（P4 设计 §3.4）：在调用者的个人空间里建文档，内容取收敛的模板快照，修订号 1。
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

  async create(userId: string, command: CreateDocumentCommand, origin: AuditOrigin): Promise<DocumentDetail> {
    const title = command.title ?? DEFAULT_DOCUMENT_TITLES[command.type]
    const digest = createdPayloadDigest(command.type, title)
    // 个人空间随账户一起创建、不会改变，在事务之外读取
    const space = await this.spaces.personalSpaceOf(userId)
    if (space === undefined)
      throw new Error(`账户没有个人空间：${userId}`)
    return this.transactions.run(async (transaction) => {
      // 同一个 requestId 的两个请求排队执行：后到的一方在下面就能看到前一方的修订记录，按重放处理
      await this.revisions.lockCreateRequest(command.requestId, transaction)
      const previous = await this.revisions.findByRequestId(command.requestId, transaction)
      if (previous !== undefined)
        return this.replay(userId, previous, digest, transaction)

      const unitId = randomUUID()
      const document = await this.documents.insert({
        spaceId: space.id,
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
      return toDetail(document, 'owner')
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
}

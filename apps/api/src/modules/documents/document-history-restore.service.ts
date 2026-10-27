import type { CreatedDocument, RestoreDocumentHistoryRequest } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { ValidatedHistory } from './document-history-validation.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import { isDeepStrictEqual } from 'node:util'
import { copiedDocumentTitle } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { inIdOrder } from '../../shared/id-order.ts'
import { AssetReferenceService } from '../assets/index.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { documentAccessIn, DocumentAccessPolicy, requireCreateTarget, requireDocumentContent } from './document-access-policy.ts'
import { DocumentAssetsRepository } from './document-assets.repository.ts'
import { DocumentCheckpointClock } from './document-checkpoint-clock.ts'
import { DocumentCheckpointService } from './document-checkpoint.service.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentHistoryValidation } from './document-history-validation.ts'
import { DocumentHistoryRepository } from './document-history.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { toDetail } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { folderIdIn } from './folder-location.ts'
import { FoldersRepository } from './folders.repository.ts'
import { historyRestorePayloadDigest } from './payload-digest.ts'
import { RequestLedger } from './request-ledger.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'

/** 原件完全不写；准入后加载/验证，锁下复核身份与权限，再原样写入独立新文档。 */
@Injectable()
export class DocumentHistoryRestoreService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly history: DocumentHistoryRepository,
    private readonly validation: DocumentHistoryValidation,
    private readonly clock: DocumentCheckpointClock,
    private readonly policy: DocumentAccessPolicy,
    private readonly ledger: RequestLedger,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly folders: FoldersRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly assets: AssetReferenceService,
    private readonly links: DocumentAssetsRepository,
    private readonly checkpoints: DocumentCheckpointService,
    private readonly audit: AuditService,
  ) {}

  async restore(actor: Actor, documentId: string, historyId: string, command: RestoreDocumentHistoryRequest, origin: AuditOrigin): Promise<CreatedDocument> {
    const digest = historyRestorePayloadDigest(documentId, historyId, command.spaceId, command.folderId, command.title)
    // 已完成结果先于正文准入与旧源鉴权：未知结果的重试不因源后来撤权/清除而重新创建。
    const replay = await this.transactions.readSnapshot(async (tx) => {
      const recorded = await this.ledger.recorded(command.requestId, tx)
      if (recorded.revision !== undefined)
        return this.replay(actor.userId, recorded.revision, digest, tx)
      if (recorded.receipt !== undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      return undefined
    })
    if (replay !== undefined)
      return replay
    return this.validation.admit(actor.userId, async () => {
      const prepared = await this.transactions.readSnapshot(async (tx) => {
        const source = await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, tx), ['viewHistory'], tx)
        await requireCreateTarget(this.policy, actor, command.spaceId, 'createDocuments', tx)
        await folderIdIn(this.folders, command.spaceId, command.folderId ?? null, tx)
        const material = await this.history.material(documentId, historyId, await this.clock.now(tx), tx)
        if (material === undefined)
          throw new AppError('NOT_FOUND')
        return { sourceSpaceId: source.document.spaceId, material }
      })
      const verified = await this.validation.validate(prepared.material, actor.userId)
      return this.write(actor, command, digest, prepared.sourceSpaceId, verified, origin)
    })
  }

  private async write(actor: Actor, command: RestoreDocumentHistoryRequest, digest: Buffer, sourceSpaceId: string, verified: ValidatedHistory, origin: AuditOrigin): Promise<CreatedDocument> {
    const { record } = verified
    return this.transactions.run(async (tx) => {
      const previous = await this.ledger.lockForCreated(command.requestId, tx)
      if (previous !== undefined)
        return this.replay(actor.userId, previous, digest, tx)
      await this.tree.lock([command.spaceId], tx)
      for (const spaceId of inIdOrder([sourceSpaceId, command.spaceId]))
        await this.spaces.holdSpace(spaceId, tx)
      const source = await requireDocumentContent(this.policy, actor.userId, await this.documents.holdById(record.sourceDocumentId, tx), ['viewHistory'], tx)
      if (source.document.spaceId !== sourceSpaceId)
        throw new AppError('NOT_FOUND')
      const target = await requireCreateTarget(this.policy, actor, command.spaceId, 'createDocuments', tx)
      const folderId = await folderIdIn(this.folders, command.spaceId, command.folderId ?? null, tx)
      const held = await this.history.hold(record.sourceDocumentId, record.id, tx)
      const now = await this.clock.now(tx)
      if (held === undefined || held.expiresAt.getTime() <= now.getTime())
        throw new AppError('NOT_FOUND')
      const { snapshot: _snapshot, ...identity } = record
      if (!isDeepStrictEqual(held, identity))
        throw new AppError('HISTORY_UNUSABLE')
      const assetIds = await this.history.assets(record.id, tx)
      const assets = await this.assets.hold(assetIds, tx)
      if (assets.length !== assetIds.length)
        throw new AppError('HISTORY_UNUSABLE')

      const copy = await this.documents.insert({
        spaceId: command.spaceId,
        folderId,
        title: command.title ?? copiedDocumentTitle(record.title),
        createdBy: actor.userId,
        type: record.type,
        unitId: record.unitId,
        profile: verified.profile,
        formatVersion: verified.formatVersion,
        sdkVersion: record.sdkVersion,
        clientBuild: record.clientBuild,
        formulasPending: record.formulasPending,
      }, tx)
      await this.contents.insertPreserved(copy.id, record, tx)
      await this.links.replace(copy.id, assetIds, tx)
      const revision = await this.revisions.insert({
        documentId: copy.id,
        revision: 1,
        kind: 'created',
        requestId: command.requestId,
        payloadDigest: digest,
        source: null,
        savedBy: actor.userId,
        contentHash: record.contentHash,
        clientBuild: record.clientBuild,
      }, tx)
      if (revision === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      await this.checkpoints.captureHourly(copy.id, tx)
      await this.audit.record({
        action: 'documents.history_restored',
        actor: { type: 'user', id: actor.userId },
        target: { type: 'document', id: copy.id },
        origin,
        details: { sourceId: record.sourceDocumentId, historyId: record.id, spaceId: copy.spaceId, folderId: copy.folderId },
      }, { transaction: tx })
      return { ...toDetail(copy, documentAccessIn(target), actor.userId), replayed: false }
    })
  }

  private async replay(userId: string, previous: RevisionRow, digest: Buffer, tx: Transaction): Promise<CreatedDocument> {
    const same = previous.kind === 'created' && previous.savedBy === userId && previous.payloadDigest.equals(digest)
    const document = same ? await this.documents.findById(previous.documentId, tx) : undefined
    const access = document === undefined ? undefined : await this.policy.accessOf(userId, document, tx)
    if (document === undefined || access === undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    return { ...toDetail(document, access, userId), replayed: true }
  }
}

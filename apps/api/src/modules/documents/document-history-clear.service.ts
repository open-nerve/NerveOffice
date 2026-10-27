import type { ClearDocumentHistoryResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Actor } from './document-access-policy.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentAccessPolicy, requireDocumentContent } from './document-access-policy.ts'
import { DocumentHistoryMaintenanceRepository } from './document-history-maintenance.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'

/** 清除当前用户历史；不改变源内容、编辑权、小时占位或运维检查点。 */
@Injectable()
export class DocumentHistoryClearService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly history: DocumentHistoryMaintenanceRepository,
    private readonly audit: AuditService,
  ) {}

  async clear(actor: Actor, documentId: string, origin: AuditOrigin): Promise<ClearDocumentHistoryResponse> {
    return this.transactions.run(async (tx) => {
      const checked = await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, tx), ['clearHistory'], tx)
      await this.spaces.holdSpace(checked.document.spaceId, tx)
      const { document } = await requireDocumentContent(this.policy, actor.userId, await this.documents.lockById(documentId, tx), ['clearHistory'], tx)
      if (document.spaceId !== checked.document.spaceId)
        throw new AppError('NOT_FOUND')
      const cleared = await this.history.clearHourly(documentId, tx)
      await this.audit.record({
        action: 'documents.history_cleared',
        actor: { type: 'user', id: actor.userId },
        target: { type: 'document', id: documentId },
        origin,
        details: { spaceId: document.spaceId, cleared },
      }, { transaction: tx })
      return { cleared }
    })
  }
}

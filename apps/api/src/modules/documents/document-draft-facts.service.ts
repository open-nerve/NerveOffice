import type { DocumentDraftFact, DocumentDraftFactsResponse } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { documentPermissionsOf } from './access-rules.ts'
import { DocumentAccessPolicy, MISSING_DOCUMENT } from './document-access-policy.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { holderFactsOf, partyFactsOf } from './edit-lease-facts.ts'
import { occupancyOf, reservationOf } from './edit-lease-rules.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { revisionSourceFor } from './revision-source.ts'

/** 本机草稿页所需的服务端事实：权限、修订和占用来自同一个只读快照，不读取正文。 */
@Injectable()
export class DocumentDraftFactsService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly leases: EditLeasesRepository,
    private readonly sessions: SessionService,
    private readonly transactions: TransactionRunner,
  ) {}

  async get(userId: string, ids: readonly string[]): Promise<DocumentDraftFactsResponse> {
    return this.transactions.readSnapshot(async (transaction) => {
      const rows = await this.documents.findManyWithGrants(userId, ids, transaction)
      const byId = new Map(rows.map(row => [row.id, row]))
      // 缺失项也参与权限查询：全部缺失与全部无权仍执行相同的语句序列。
      const access = await this.policy.accessOfMany(userId, ids.map((id) => {
        const document = byId.get(id)
        return { document: document ?? MISSING_DOCUMENT, grant: document?.grantRole ?? undefined }
      }), transaction)
      const readable = ids.flatMap((id) => {
        const document = byId.get(id)
        const located = access.get(id)
        return document === undefined || located === undefined ? [] : [{ document, access: located.access }]
      })
      const facts = new Map<string, DocumentDraftFact>()
      if (readable.length > 0) {
        const readableIds = readable.map(({ document }) => document.id)
        const revisions = new Map((await this.revisions.findCurrentOf(readableIds, transaction)).map(row => [row.documentId, row]))
        const leases = new Map((await this.leases.findByDocuments(readableIds, transaction)).map(row => [row.documentId, row]))
        for (const { document, access } of readable) {
          const lease = leases.get(document.id)
          const occupancy = await occupancyOf(lease, document.writeEpoch, userId, holderFactsOf(this.sessions, this.policy, lease, document, transaction))
          const reservation = await reservationOf(lease, partyFactsOf(this.sessions, this.policy, document, transaction).canEdit)
          facts.set(document.id, {
            status: 'accessible',
            id: document.id,
            title: document.title,
            type: document.type,
            canEdit: documentPermissionsOf(access, document, userId).canEdit,
            revision: document.revision,
            revisionSource: revisionSourceFor(revisions.get(document.id), userId),
            occupied: occupancy.kind === 'occupied' || reservation !== undefined,
          })
        }
      }
      return { items: ids.map(id => facts.get(id) ?? { status: 'unavailable', id }) }
    })
  }
}

import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { DocumentHistoryMaintenanceRepository } from './document-history-maintenance.repository.ts'

export interface PurgedHistory {
  readonly checkpoints: number
  readonly buckets: number
}

/** 仅供 Jobs：删除到期元数据与保留关系，图片对象的物理回收由后续 GC 负责。 */
@Injectable()
export class DocumentHistoryPurgeService {
  constructor(private readonly history: DocumentHistoryMaintenanceRepository, private readonly audit: AuditService) {}

  async purgeExpired(now: Date, limit: number, tx: Transaction): Promise<PurgedHistory> {
    const checkpoints = await this.history.deleteExpiredCheckpoints(now, limit, tx)
    const buckets = await this.history.deleteExpiredBuckets(now, limit, tx)
    const result = { checkpoints, buckets }
    if (checkpoints + buckets > 0) {
      await this.audit.record({
        action: 'documents.checkpoints_expired',
        actor: { type: 'system' },
        origin: { source: 'job' },
        details: result,
      }, { transaction: tx })
    }
    return result
  }
}

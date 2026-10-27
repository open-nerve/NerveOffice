import type { Transaction } from '../database/index.ts'
import type { OperationCheckpointKind } from './document-checkpoints.repository.ts'
import { Injectable } from '@nestjs/common'
import { DocumentCheckpointClock } from './document-checkpoint-clock.ts'
import { DocumentCheckpointsRepository } from './document-checkpoints.repository.ts'

/** 调用方已完成正文与合法引用更新；原事务一起提交，采样失败也让原事务回滚。 */
@Injectable()
export class DocumentCheckpointService {
  constructor(
    private readonly repository: DocumentCheckpointsRepository,
    private readonly clock: DocumentCheckpointClock,
  ) {}

  async captureHourly(documentId: string, transaction: Transaction): Promise<string | undefined> {
    return this.repository.captureHourly(documentId, await this.clock.now(transaction), transaction)
  }

  async captureOperation(documentId: string, kind: OperationCheckpointKind, eventId: string, transaction: Transaction): Promise<string | undefined> {
    return this.repository.captureOperation(documentId, kind, eventId, await this.clock.now(transaction), transaction)
  }

  /** 一次删除单元使用同一数据库时刻；调用方已按 id 持有全部源文档锁。 */
  async captureOperations(documentIds: readonly string[], kind: OperationCheckpointKind, eventId: string, transaction: Transaction): Promise<void> {
    if (documentIds.length === 0)
      return
    const at = await this.clock.now(transaction)
    for (const id of documentIds)
      await this.repository.captureOperation(id, kind, eventId, at, transaction)
  }
}

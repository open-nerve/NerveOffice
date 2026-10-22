import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { DocumentCheckpointsRepository } from './document-checkpoints.repository.ts'

/** 在业务锁后取时刻；外部请求不能指定，测试可以替换此依赖。 */
export abstract class DocumentCheckpointClock {
  abstract now(transaction: Transaction): Promise<Date>
}

@Injectable()
export class DatabaseDocumentCheckpointClock extends DocumentCheckpointClock {
  constructor(private readonly repository: DocumentCheckpointsRepository) {
    super()
  }

  override async now(transaction: Transaction): Promise<Date> {
    return this.repository.now(transaction)
  }
}

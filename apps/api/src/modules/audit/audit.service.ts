import type { Transaction } from '../database/index.ts'
import type { AuditEvent } from './audit-event.ts'
import { Injectable } from '@nestjs/common'
import { auditEventSchema } from './audit-event.ts'
import { AuditRepository } from './audit.repository.ts'

export interface RecordOptions {
  /** 需要与业务写入放在同一个事务里时，传入调用方开启的事务（TransactionRunner） */
  transaction?: Transaction
}

/** 写入审计事件（只追加）。事件不合法说明调用方写错了，直接抛出，按意外错误处理。 */
@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async record(event: AuditEvent, options: RecordOptions = {}): Promise<void> {
    await this.repository.insert(auditEventSchema.parse(event), options.transaction)
  }
}

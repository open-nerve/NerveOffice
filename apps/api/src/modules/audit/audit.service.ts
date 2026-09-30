import type { AuditEventQuery } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { AuditEvent } from './audit-event.ts'
import type { AuditRecord } from './audit.repository.ts'
import { ADMIN_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { parseAuditEvent } from './audit-event.ts'
import { AuditRepository } from './audit.repository.ts'

export interface RecordOptions {
  /** 需要与业务写入放在同一个事务里时，传入调用方开启的事务（TransactionRunner） */
  transaction?: Transaction
}

/** 写入审计事件（只追加）。事件不合法说明调用方写错了，直接抛出，按意外错误处理。 */
@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  /** 明细按动作的严格结构校验（contracts 的 auditDetailsSchema，M2-P6 复核 M-1）：多出来的键（例如标题）写不进去 */
  async record(event: AuditEvent, options: RecordOptions = {}): Promise<void> {
    await this.repository.insert(parseAuditEvent(event), options.transaction)
  }

  /**
   * 按条件查询（M2-P1 设计 §3.7，只给 admin 模块）：按时间倒序，每页 ADMIN_PAGE_SIZE 条。
   * 游标不是我们发的时候 REQUEST_INVALID
   */
  async search(query: AuditEventQuery): Promise<{ readonly items: AuditRecord[], readonly nextCursor: string | null }> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    const rows = await this.repository.query({ ...query, after, limit: ADMIN_PAGE_SIZE + 1 })
    const items = rows.slice(0, ADMIN_PAGE_SIZE)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null }
  }
}

import type { Database, Transaction } from '../database/index.ts'
import type { ValidAuditEvent } from './audit-event.ts'
import { Inject, Injectable } from '@nestjs/common'
import { auditEvents } from '../../db/schema/audit/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 只有它读写 audit_events（规范 §1.2）。表只追加，更新与删除由数据库的触发器拒绝。 */
@Injectable()
export class AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(event: ValidAuditEvent, transaction?: Transaction): Promise<void> {
    const { actor, target, origin } = event
    await executorOf(this.db, transaction).insert(auditEvents).values({
      action: event.action,
      actorType: actor.type,
      actorId: actor.type === 'user' ? actor.id : null,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      source: origin.source,
      requestId: origin.source === 'http' ? origin.requestId : null,
      clientIp: origin.source === 'http' ? origin.clientIp ?? null : null,
      details: event.details ?? {},
    })
  }
}

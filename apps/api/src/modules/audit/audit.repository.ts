import type { Database, Transaction } from '../database/index.ts'
import type { ValidAuditEvent } from './audit-event.ts'
import { Inject, Injectable } from '@nestjs/common'
import { getTableName, sql } from 'drizzle-orm'
import { auditEvents } from '../../db/schema/audit/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 当前连接数据库的角色与审计表的关系。 */
export interface AuditTableAccess {
  readonly role: string
  readonly superuser: boolean
  /** 是审计表的所有者或所有者角色的成员；表还不存在（还没有迁移）时为 undefined */
  readonly ownsTable: boolean | undefined
}

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

  /** 当前角色是不是超级用户、是不是审计表的所有者（或所有者角色的成员，可以切换成所有者）。 */
  async currentAccess(): Promise<AuditTableAccess> {
    const result = await this.db.execute<{ role: string, superuser: boolean, owns_table: boolean | null }>(sql`
      SELECT current_user AS role, r.rolsuper AS superuser, pg_has_role(current_user, c.relowner, 'MEMBER') AS owns_table
      FROM pg_roles AS r LEFT JOIN pg_class AS c ON c.oid = to_regclass(${getTableName(auditEvents)})
      WHERE r.rolname = current_user`)
    const [row] = result.rows
    if (row === undefined)
      throw new Error('查不到当前数据库角色')
    return { role: row.role, superuser: row.superuser, ownsTable: row.owns_table ?? undefined }
  }
}

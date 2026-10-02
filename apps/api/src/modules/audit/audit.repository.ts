import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import type { ValidAuditEvent } from './audit-event.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, getTableName, gte, lt, sql } from 'drizzle-orm'
import { auditEvents } from '../../db/schema/audit/index.ts'
import { DATABASE, executorOf, keysetPosition } from '../database/index.ts'

/** 审计查询的条件（contracts 的 auditEventQuerySchema 解析之后）与分页 */
export interface AuditFilter {
  readonly from?: string
  readonly to?: string
  readonly actorId?: string
  readonly action?: string
  readonly targetType?: string
  readonly targetId?: string
  readonly after?: TimeCursor
  readonly limit: number
}

/** 查询出来的一条审计事件：表里只有 id，名字由调用方补 */
export interface AuditRecord {
  readonly id: string
  readonly occurredAt: Date
  /** 游标用的时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
  readonly action: string
  readonly actorType: string
  readonly actorId: string | null
  readonly targetType: string | null
  readonly targetId: string | null
  readonly source: string
  readonly requestId: string | null
  readonly clientIp: string | null
  readonly details: Record<string, unknown>
}

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
      details: event.details,
    })
  }

  /**
   * 按条件查询（M2-P1 设计 §3.7）：条件之间是"并且"，按时间与 id 倒序；after 是上一页最后一条的位置（keyset）。
   * 多取的一条由调用方判断有没有下一页。现有的三个索引（时间、操作者、对象）覆盖这几种条件
   */
  async query(filter: AuditFilter): Promise<AuditRecord[]> {
    const e = auditEvents
    const { after } = filter
    return this.db
      .select({
        id: e.id,
        occurredAt: e.occurredAt,
        position: keysetPosition(e.occurredAt),
        action: e.action,
        actorType: e.actorType,
        actorId: e.actorId,
        targetType: e.targetType,
        targetId: e.targetId,
        source: e.source,
        requestId: e.requestId,
        clientIp: sql<string | null>`host(${e.clientIp})`,
        details: e.details,
      })
      .from(e)
      .where(and(
        filter.from === undefined ? undefined : gte(e.occurredAt, new Date(filter.from)),
        filter.to === undefined ? undefined : lt(e.occurredAt, new Date(filter.to)),
        filter.actorId === undefined ? undefined : eq(e.actorId, filter.actorId),
        filter.action === undefined ? undefined : eq(e.action, filter.action),
        filter.targetType === undefined ? undefined : eq(e.targetType, filter.targetType),
        filter.targetId === undefined ? undefined : eq(e.targetId, filter.targetId),
        after === undefined ? undefined : sql`(${e.occurredAt}, ${e.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`,
      ))
      .orderBy(desc(e.occurredAt), desc(e.id))
      .limit(filter.limit)
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

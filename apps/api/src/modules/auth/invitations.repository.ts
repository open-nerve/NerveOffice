import type { InvitationStatus } from '@nerve-office/contracts'
import type { Name, SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Buffer } from 'node:buffer'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, getTableName, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { authInvitations } from '../../db/schema/auth/index.ts'
import { DATABASE, executorOf, keysetPosition } from '../database/index.ts'

export interface InvitationRecord {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly createdBy: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly acceptedAt: Date | null
  readonly acceptedUserId: string | null
  readonly revokedAt: Date | null
  /** 数据库时间算出的：到期了（expires_at <= now()） */
  readonly expired: boolean
  /** 游标用的签发时间：数据库算出的 UTC 文本，保留微秒 */
  readonly position: string
  /** 同一个登录名后来又签发过邀请（审查 B6） */
  readonly superseded: boolean
}

export interface NewInvitation {
  readonly username: string
  readonly displayName: string
  readonly tokenHash: Buffer
  readonly createdBy: string
  readonly lifetimeHours: number
}

const i = authInvitations

const invitationsTable = sql.identifier(getTableName(i))
const newerTable = sql.identifier('newer')

function qualified(table: Name, column: AnyPgColumn): SQL {
  return sql`${table}.${sql.identifier(column.name)}`
}

/**
 * 同一个登录名有更晚签发的邀请。子查询里的列都写上表名：drizzle 在单表的查询与 RETURNING 里不给列加表名，
 * 直接写 ${i.username} 会被子查询里的同名列截走
 */
const superseded = sql<boolean>`EXISTS (SELECT 1 FROM ${invitationsTable} AS ${newerTable} WHERE ${qualified(newerTable, i.username)} = ${qualified(invitationsTable, i.username)} AND (${qualified(newerTable, i.createdAt)}, ${qualified(newerTable, i.id)}) > (${qualified(invitationsTable, i.createdAt)}, ${qualified(invitationsTable, i.id)}))`

const COLUMNS = {
  id: i.id,
  username: i.username,
  displayName: i.displayName,
  createdBy: i.createdBy,
  createdAt: i.createdAt,
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  acceptedUserId: i.acceptedUserId,
  revokedAt: i.revokedAt,
  expired: sql<boolean>`${i.expiresAt} <= now()`,
  position: keysetPosition(i.createdAt),
  superseded,
}

/** 未接受、未作废（可能已过期） */
const open = and(isNull(i.acceptedAt), isNull(i.revokedAt))

/** 管理界面按状态过滤的条件 */
function statusIs(status: InvitationStatus) {
  switch (status) {
    case 'pending': return and(open, sql`${i.expiresAt} > now()`)
    case 'expired': return and(open, sql`${i.expiresAt} <= now()`)
    case 'accepted': return isNotNull(i.acceptedAt)
    case 'revoked': return isNotNull(i.revokedAt)
  }
}

/** 只有它读写 auth_invitations（规范 §1.2）。时间一律用数据库时间。 */
@Injectable()
export class InvitationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(invitation: NewInvitation, transaction: Transaction): Promise<InvitationRecord> {
    const [row] = await executorOf(this.db, transaction)
      .insert(i)
      .values({
        username: invitation.username,
        displayName: invitation.displayName,
        tokenHash: invitation.tokenHash,
        createdBy: invitation.createdBy,
        expiresAt: sql`now() + make_interval(hours => ${invitation.lifetimeHours})`,
      })
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error('新建邀请没有返回记录')
    return row
  }

  async findByTokenHash(tokenHash: Buffer): Promise<InvitationRecord | undefined> {
    const [row] = await this.db.select(COLUMNS).from(i).where(eq(i.tokenHash, tokenHash))
    return row
  }

  async findById(id: string): Promise<InvitationRecord | undefined> {
    const [row] = await this.db.select(COLUMNS).from(i).where(eq(i.id, id))
    return row
  }

  /** 按 id 批量取登录名：审计查询补名字用 */
  async findUsernames(ids: readonly string[]): Promise<{ readonly id: string, readonly username: string }[]> {
    if (ids.length === 0)
      return []
    return this.db.select({ id: i.id, username: i.username }).from(i).where(inArray(i.id, [...ids]))
  }

  /** 锁住这一条再读：接受、作废、重发在事务里串行，复核之后再改 */
  async findByIdForUpdate(id: string, transaction: Transaction): Promise<InvitationRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(i).where(eq(i.id, id)).for('update')
    return row
  }

  /** 这个登录名未接受、未作废的邀请（最多一条，部分唯一索引保证）；调用方先取了这个登录名的锁 */
  async findOpenByUsername(username: string, transaction: Transaction): Promise<InvitationRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(i).where(and(eq(i.username, username), open))
    return row
  }

  /** 作废：只改未接受、未作废的（条件与更新在同一条语句里）；已经不是这个状态时返回 undefined */
  async revokeOpen(id: string, revokedBy: string, transaction: Transaction): Promise<InvitationRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).update(i).set({ revokedAt: sql`now()`, revokedBy }).where(and(eq(i.id, id), open)).returning(COLUMNS)
    return row
  }

  /**
   * 签发人离任时（M2-P6 复核 A2）：作废这个人签发的、还没接受也没作废、还没到期的邀请，返回作废了的那些的 id（调用方逐条记审计）。
   * 已经到期的本来就不能用，不再改状态（列表里仍是"已过期"）
   */
  async revokeOpenIssuedBy(issuerId: string, revokedBy: string, transaction: Transaction): Promise<string[]> {
    const rows = await executorOf(this.db, transaction)
      .update(i)
      .set({ revokedAt: sql`now()`, revokedBy })
      .where(and(eq(i.createdBy, issuerId), open, sql`${i.expiresAt} > now()`))
      .returning({ id: i.id })
    return rows.map(row => row.id)
  }

  async markAccepted(id: string, userId: string, transaction: Transaction): Promise<InvitationRecord> {
    const [row] = await executorOf(this.db, transaction).update(i).set({ acceptedAt: sql`now()`, acceptedUserId: userId }).where(eq(i.id, id)).returning(COLUMNS)
    return updated(row, id)
  }

  /** 按签发时间从新到旧；after 是上一页最后一条的位置（keyset）。多取的一条由调用方判断有没有下一页 */
  async list(filter: { readonly status?: InvitationStatus, readonly after?: TimeCursor, readonly limit: number }): Promise<InvitationRecord[]> {
    const { after } = filter
    return this.db
      .select(COLUMNS)
      .from(i)
      .where(and(
        filter.status === undefined ? undefined : statusIs(filter.status),
        after === undefined ? undefined : sql`(${i.createdAt}, ${i.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`,
      ))
      .orderBy(desc(i.createdAt), desc(i.id))
      .limit(filter.limit)
  }
}

/** 更新的是调用方刚锁住（或刚读到）的那一条：没有返回说明数据不一致，按意外错误处理 */
function updated(row: InvitationRecord | undefined, id: string): InvitationRecord {
  if (row === undefined)
    throw new Error(`更新邀请时记录不在了：${id}`)
  return row
}

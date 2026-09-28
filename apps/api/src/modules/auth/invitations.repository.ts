import type { InvitationStatus } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { TimeCursor } from '../../shared/time-cursor.ts'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
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
}

export interface NewInvitation {
  readonly username: string
  readonly displayName: string
  readonly tokenHash: Buffer
  readonly createdBy: string
  readonly lifetimeHours: number
}

const i = authInvitations
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

  async revoke(id: string, revokedBy: string, transaction: Transaction): Promise<InvitationRecord> {
    const [row] = await executorOf(this.db, transaction).update(i).set({ revokedAt: sql`now()`, revokedBy }).where(eq(i.id, id)).returning(COLUMNS)
    return updated(row, id)
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

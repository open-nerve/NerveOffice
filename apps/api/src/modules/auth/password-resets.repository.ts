import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import { authPasswordResets } from '../../db/schema/auth/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

export interface PasswordResetRecord {
  readonly id: string
  readonly userId: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
  /** 数据库时间算出的：到期了（expires_at <= now()） */
  readonly expired: boolean
}

export interface NewPasswordReset {
  readonly userId: string
  readonly tokenHash: Buffer
  /** 签发人；运维命令签发的为空 */
  readonly createdBy: string | undefined
  readonly lifetimeHours: number
}

const r = authPasswordResets
const COLUMNS = {
  id: r.id,
  userId: r.userId,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  usedAt: r.usedAt,
  revokedAt: r.revokedAt,
  expired: sql<boolean>`${r.expiresAt} <= now()`,
}

/** 只有它读写 auth_password_resets（规范 §1.2）。时间一律用数据库时间。 */
@Injectable()
export class PasswordResetsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(reset: NewPasswordReset, transaction: Transaction): Promise<PasswordResetRecord> {
    const [row] = await executorOf(this.db, transaction)
      .insert(r)
      .values({
        userId: reset.userId,
        tokenHash: reset.tokenHash,
        createdBy: reset.createdBy ?? null,
        expiresAt: sql`now() + make_interval(hours => ${reset.lifetimeHours})`,
      })
      .returning(COLUMNS)
    if (row === undefined)
      throw new Error('新建重置没有返回记录')
    return row
  }

  async findByTokenHash(tokenHash: Buffer): Promise<PasswordResetRecord | undefined> {
    const [row] = await this.db.select(COLUMNS).from(r).where(eq(r.tokenHash, tokenHash))
    return row
  }

  /** 锁住这一条再读：完成重置时复核之后再改 */
  async findByIdForUpdate(id: string, transaction: Transaction): Promise<PasswordResetRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(COLUMNS).from(r).where(eq(r.id, id)).for('update')
    return row
  }

  /** 作废这个账户未使用、未作废的重置（签发新的、停用账户时），返回作废了的那些的 id（部分唯一索引保证至多一条）：调用方逐条记审计 */
  async revokeOpenOfUser(userId: string, transaction: Transaction): Promise<string[]> {
    const rows = await executorOf(this.db, transaction)
      .update(r)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(r.userId, userId), isNull(r.usedAt), isNull(r.revokedAt)))
      .returning({ id: r.id })
    return rows.map(row => row.id)
  }

  /**
   * 签发人离任时（M2-P6 复核 A2）：作废这个人签发给别人的、还没用也没作废、还没到期的重置，返回作废了的那些（id 与被重置的账户），
   * 调用方逐条记审计。给自己签发的不在这里：停用时随"这个账户未用的重置"一起作废（revokeOpenOfUser）；
   * 只是不再是系统管理员时，那是他自己账户的链接，照常可用。已经到期的本来就不能用，不再改状态
   */
  async revokeOpenIssuedBy(issuerId: string, transaction: Transaction): Promise<{ readonly id: string, readonly userId: string }[]> {
    return executorOf(this.db, transaction)
      .update(r)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(r.createdBy, issuerId), ne(r.userId, issuerId), isNull(r.usedAt), isNull(r.revokedAt), gt(r.expiresAt, sql`now()`)))
      .returning({ id: r.id, userId: r.userId })
  }

  async markUsed(id: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).update(r).set({ usedAt: sql`now()` }).where(eq(r.id, id))
  }
}

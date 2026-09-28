import type { Buffer } from 'node:buffer'
import type { Database, Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
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

  /** 作废这个账户未使用、未作废的重置（签发新的、停用账户时） */
  async revokeOpenOfUser(userId: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction)
      .update(r)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(r.userId, userId), isNull(r.usedAt), isNull(r.revokedAt)))
  }

  async markUsed(id: string, transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).update(r).set({ usedAt: sql`now()` }).where(eq(r.id, id))
  }
}

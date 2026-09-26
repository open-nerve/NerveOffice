import type { UserSystemRole } from '@nerve-office/contracts'
import type { Database, Transaction } from '../database/index.ts'
import type { User } from './user.ts'
import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { users } from '../../db/schema/users/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

export interface NewUser {
  readonly username: string
  readonly displayName: string
  readonly passwordHash: string
  readonly systemRole: UserSystemRole
}

export interface UserCredentials {
  readonly user: User
  readonly passwordHash: string
}

const USER_COLUMNS = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  systemRole: users.systemRole,
  status: users.status,
}

/** 只有它读写 users（规范 §1.2）。 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(user: NewUser, transaction?: Transaction): Promise<User> {
    const [row] = await executorOf(this.db, transaction).insert(users).values(user).returning(USER_COLUMNS)
    if (row === undefined)
      throw new Error('新建账户没有返回记录')
    return row
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select(USER_COLUMNS).from(users).where(eq(users.id, id))
    return row
  }

  async findCredentialsByUsername(username: string): Promise<UserCredentials | undefined> {
    const [row] = await this.db.select({ ...USER_COLUMNS, passwordHash: users.passwordHash }).from(users).where(eq(users.username, username))
    if (row === undefined)
      return undefined
    const { passwordHash, ...user } = row
    return { user, passwordHash }
  }

  async existsWithRole(systemRole: UserSystemRole, transaction?: Transaction): Promise<boolean> {
    const [row] = await executorOf(this.db, transaction).select({ id: users.id }).from(users).where(eq(users.systemRole, systemRole)).limit(1)
    return row !== undefined
  }

  /** 事务级的 advisory lock：两个并发的初始化排队执行，后一个能看到前一个创建的管理员 */
  async lockAdminInitialization(transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('nerve-office:admin-initialization', 0))`)
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash, updatedAt: sql`now()` }).where(eq(users.id, id))
  }
}

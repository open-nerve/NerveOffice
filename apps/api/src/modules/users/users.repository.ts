import type { UserStatus, UserSystemRole } from '@nerve-office/contracts'
import type { Database, Transaction } from '../database/index.ts'
import type { AccountRecord, User } from './user.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, gt, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import { users } from '../../db/schema/users/index.ts'
import { containsPattern } from '../../shared/like-pattern.ts'
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

const RECORD_COLUMNS = { ...USER_COLUMNS, createdAt: users.createdAt }

/** 管理界面的账户列表的过滤条件（M2-P1 设计 §3.6）：按登录名排序，after 是上一页最后一条的登录名 */
export interface AccountFilter {
  readonly query?: string
  readonly status?: UserStatus
  readonly afterUsername?: string
  readonly limit: number
}

/** 显示名或登录名里包含关键词（不区分大小写，关键词按字面匹配） */
function nameContains(keyword: string | undefined) {
  if (keyword === undefined || keyword === '')
    return undefined
  const pattern = containsPattern(keyword)
  return or(ilike(users.displayName, pattern), ilike(users.username, pattern))
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

  async existsWithUsername(username: string, transaction?: Transaction): Promise<boolean> {
    const [row] = await executorOf(this.db, transaction).select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1)
    return row !== undefined
  }

  async existsWithRole(systemRole: UserSystemRole, transaction?: Transaction): Promise<boolean> {
    const [row] = await executorOf(this.db, transaction).select({ id: users.id }).from(users).where(eq(users.systemRole, systemRole)).limit(1)
    return row !== undefined
  }

  /** 事务级的 advisory lock：两个并发的初始化排队执行，后一个能看到前一个创建的管理员 */
  async lockAdminInitialization(transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('nerve-office:admin-initialization', 0))`)
  }

  async updatePasswordHash(id: string, passwordHash: string, transaction?: Transaction): Promise<void> {
    await executorOf(this.db, transaction).update(users).set({ passwordHash, updatedAt: sql`now()` }).where(eq(users.id, id))
  }

  async findCredentialsById(id: string): Promise<UserCredentials | undefined> {
    const [row] = await this.db.select({ ...USER_COLUMNS, passwordHash: users.passwordHash }).from(users).where(eq(users.id, id))
    if (row === undefined)
      return undefined
    const { passwordHash, ...user } = row
    return { user, passwordHash }
  }

  /** 按 id 批量取账户（含停用的）：审计查询补名字用 */
  async findByIds(ids: readonly string[]): Promise<User[]> {
    if (ids.length === 0)
      return []
    return this.db.select(USER_COLUMNS).from(users).where(inArray(users.id, [...ids]))
  }

  /** 锁住这个账户的行再读：状态与系统角色的变更在事务里串行 */
  async findRecordForUpdate(id: string, transaction: Transaction): Promise<AccountRecord | undefined> {
    const [row] = await executorOf(this.db, transaction).select(RECORD_COLUMNS).from(users).where(eq(users.id, id)).for('update')
    return row
  }

  async setStatus(id: string, status: UserStatus, transaction: Transaction): Promise<AccountRecord> {
    const [row] = await executorOf(this.db, transaction).update(users).set({ status, updatedAt: sql`now()` }).where(eq(users.id, id)).returning(RECORD_COLUMNS)
    if (row === undefined)
      throw new Error(`更新账户状态时账户不在了：${id}`)
    return row
  }

  async setSystemRole(id: string, systemRole: UserSystemRole, transaction: Transaction): Promise<AccountRecord> {
    const [row] = await executorOf(this.db, transaction).update(users).set({ systemRole, updatedAt: sql`now()` }).where(eq(users.id, id)).returning(RECORD_COLUMNS)
    if (row === undefined)
      throw new Error(`更新系统角色时账户不在了：${id}`)
    return row
  }

  /**
   * 事务级的 advisory lock（M2-P1 设计 §3.5）："至少保留一个有效的系统管理员"的检查与变更串行执行：
   * 两个管理员同时互相取消或停用，后一个能看到前一个的结果。与初始化管理员的锁分开
   */
  async lockSystemAdmins(transaction: Transaction): Promise<void> {
    await executorOf(this.db, transaction).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('nerve-office:system-admins', 0))`)
  }

  /** 除这个账户以外的有效系统管理员的数量 */
  async countActiveAdminsExcept(id: string, transaction: Transaction): Promise<number> {
    const [row] = await executorOf(this.db, transaction)
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.systemRole, 'admin'), eq(users.status, 'active'), ne(users.id, id)))
    return row?.count ?? 0
  }

  /** 管理界面的账户列表（含停用的），按登录名排序，多取的一条由调用方判断有没有下一页 */
  async listRecords(filter: AccountFilter): Promise<AccountRecord[]> {
    return this.db
      .select(RECORD_COLUMNS)
      .from(users)
      .where(and(
        nameContains(filter.query),
        filter.status === undefined ? undefined : eq(users.status, filter.status),
        filter.afterUsername === undefined ? undefined : gt(users.username, filter.afterUsername),
      ))
      .orderBy(asc(users.username))
      .limit(filter.limit)
  }

  /** 同事目录：有效账户，按显示名（同名再按登录名）排序 */
  async searchActive(keyword: string | undefined, limit: number): Promise<User[]> {
    return this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(and(eq(users.status, 'active'), nameContains(keyword)))
      .orderBy(asc(users.displayName), asc(users.username))
      .limit(limit)
  }

  /**
   * 现存密码哈希用到的参数：PHC 字符串（$argon2id$v=19$m=…,t=…,p=…$盐$哈希）的第 4 段，去重之后返回。
   * 只取参数段，不把哈希本身读出来（Codex 评审 CX4）
   */
  async passwordHashParameters(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ parameters: sql<string>`split_part(${users.passwordHash}, '$', 4)` }).from(users)
    return rows.map(row => row.parameters)
  }
}

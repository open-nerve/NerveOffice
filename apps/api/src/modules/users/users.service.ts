import type { AdminUserListQuery, UserDirectoryQuery, UserSystemRole } from '@nerve-office/contracts'
import type { OnModuleInit } from '@nestjs/common'
import type { Transaction } from '../database/index.ts'
import type { AccountChange, AccountRecord, User } from './user.ts'
import { randomBytes } from 'node:crypto'
import { ADMIN_PAGE_SIZE, USER_DIRECTORY_LIMIT, usernameSchema } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger } from '../logging/index.ts'
import { decodeAccountCursor, encodeAccountCursor } from './account-cursor.ts'
import { PasswordHasher } from './password-hasher.ts'
import { UsersRepository } from './users.repository.ts'

/** 用户名与密码的验证结果。失败时如果用户名对应的账户存在，带上它（审计的对象）；不区分"不存在"与"密码错误"。 */
export type CredentialCheck
  = | { readonly valid: true, readonly user: User }
    | { readonly valid: false, readonly user?: User }

/** 账户（P3 设计 §3.4）。 */
@Injectable()
export class UsersService implements OnModuleInit {
  readonly #logger: AppLogger
  /** 用户名不存在时拿来算一次哈希的假哈希：响应时间与"密码错误"相近，不暴露账户是否存在 */
  #dummyHash: Promise<string> | undefined
  /** 读出库里现存哈希的参数、交给哈希器（Codex 评审 CX4）：成功一次即可 */
  #storedParameters: Promise<void> | undefined

  constructor(
    private readonly repository: UsersRepository,
    private readonly hasher: PasswordHasher,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'users' })
  }

  /**
   * 启动时就生成假哈希：否则第一个不存在的用户名要多算一次哈希，响应时间暴露账户不存在（P3 审查 A13）。
   * 同时读出库里现存哈希的参数，但不等它：数据库暂时连不上时照常启动（就绪探针另有报告），验证时再读。
   */
  async onModuleInit(): Promise<void> {
    void this.observeStoredParameters()
    await this.dummyHash()
  }

  /** 状态为 active 的账户；停用（M2）或不存在时返回 undefined */
  async findActiveById(id: string): Promise<User | undefined> {
    const user = await this.repository.findById(id)
    return user?.status === 'active' ? user : undefined
  }

  /**
   * 按用户名（不区分大小写）与密码验证。不论账户是否存在、是否可用，都做一次哈希计算；验证失败的计算量由哈希器补齐，
   * 账户的哈希参数与当前配置不同时，失败的耗时也与"用户名不存在"相同（Codex 评审 CX4）。
   * 验证通过且哈希的参数已经过时，顺带用当前的参数重新哈希（失败只记日志，不影响这次登录）。
   */
  async verifyCredentials(usernameInput: string, password: string): Promise<CredentialCheck> {
    // 先让哈希器知道库里现存的参数（参数调低之后，旧哈希的计算量更大，失败都要补到它）；读过一次之后不再读
    await this.observeStoredParameters()
    const username = usernameSchema.safeParse(usernameInput)
    const credentials = username.success ? await this.repository.findCredentialsByUsername(username.data) : undefined
    if (credentials === undefined) {
      await this.hasher.verify(await this.dummyHash(), password)
      return { valid: false }
    }
    const matches = await this.hasher.verify(credentials.passwordHash, password)
    if (!matches || credentials.user.status !== 'active')
      return { valid: false, user: credentials.user }
    if (this.hasher.needsRehash(credentials.passwordHash))
      await this.rehash(credentials.user, password)
    return { valid: true, user: credentials.user }
  }

  /** 新密码的哈希（修改、重置、接受邀请）：计算密集，调用方放在事务之外。等待哈希的请求太多时抛 PasswordHashingBusyError */
  async hashPassword(password: string): Promise<string> {
    return this.hasher.hash(password)
  }

  /**
   * 按 id 验证密码（修改密码时的旧密码，M2-P1 设计 §3.5）。账户不存在或不可用时同样算一次哈希，
   * 失败的耗时由哈希器补齐，与登录相同（ADR-007）
   */
  async verifyPasswordOf(userId: string, password: string): Promise<boolean> {
    await this.observeStoredParameters()
    const credentials = await this.repository.findCredentialsById(userId)
    if (credentials === undefined || credentials.user.status !== 'active') {
      await this.hasher.verify(await this.dummyHash(), password)
      return false
    }
    return this.hasher.verify(credentials.passwordHash, password)
  }

  async setPasswordHash(userId: string, passwordHash: string, transaction: Transaction): Promise<void> {
    await this.repository.updatePasswordHash(userId, passwordHash, transaction)
  }

  /**
   * 停用（M2-P1 设计 §3.5）。已经停用的原样返回（changed 为假）。
   * 停用有效的系统管理员时，要求还有别的有效系统管理员（LAST_ADMIN）。
   * 锁的顺序固定为先 advisory lock、再账户的行锁，与系统角色的变更相同，互相等待时不成环
   */
  async disable(userId: string, transaction: Transaction): Promise<AccountChange> {
    await this.repository.lockSystemAdmins(transaction)
    const account = await this.lockedAccount(userId, transaction)
    if (account.status === 'disabled')
      return { account, changed: false }
    if (account.systemRole === 'admin')
      await this.requireAnotherActiveAdmin(account.id, transaction)
    return { account: await this.repository.setStatus(account.id, 'disabled', transaction), changed: true }
  }

  /** 启用：只会让有效的账户变多，不需要"至少保留一个管理员"的锁 */
  async enable(userId: string, transaction: Transaction): Promise<AccountChange> {
    const account = await this.lockedAccount(userId, transaction)
    if (account.status === 'active')
      return { account, changed: false }
    return { account: await this.repository.setStatus(account.id, 'active', transaction), changed: true }
  }

  /**
   * 授予或取消系统管理员（M2-P1 设计 §3.5）：只有有效的账户能被授予（ACCOUNT_DISABLED）；
   * 取消有效的系统管理员时，要求还有别的有效系统管理员（LAST_ADMIN）
   */
  async changeSystemRole(userId: string, systemRole: UserSystemRole, transaction: Transaction): Promise<AccountChange> {
    await this.repository.lockSystemAdmins(transaction)
    const account = await this.lockedAccount(userId, transaction)
    if (account.systemRole === systemRole)
      return { account, changed: false }
    if (systemRole === 'admin' && account.status !== 'active')
      throw new AppError('ACCOUNT_DISABLED')
    if (systemRole === 'member' && account.status === 'active')
      await this.requireAnotherActiveAdmin(account.id, transaction)
    return { account: await this.repository.setSystemRole(account.id, systemRole, transaction), changed: true }
  }

  /** 管理界面的账户列表（含停用的）：按登录名排序分页 */
  async listAccounts(query: AdminUserListQuery): Promise<{ readonly items: AccountRecord[], readonly nextCursor: string | null }> {
    const afterUsername = query.cursor === undefined ? undefined : decodeAccountCursor(query.cursor)
    if (query.cursor !== undefined && afterUsername === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    // 多取一条，判断还有没有下一页
    const rows = await this.repository.listRecords({ query: query.query, status: query.status, afterUsername, limit: ADMIN_PAGE_SIZE + 1 })
    const items = rows.slice(0, ADMIN_PAGE_SIZE)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > ADMIN_PAGE_SIZE && last !== undefined ? encodeAccountCursor(last.username) : null }
  }

  /** 同事目录（M2-P1 设计 §3.6）：有效账户，显示名或登录名包含关键词 */
  async directory(query: UserDirectoryQuery): Promise<User[]> {
    return this.repository.searchActive(query.query, USER_DIRECTORY_LIMIT)
  }

  /** 按 id 批量取账户（含停用的）：审计查询补名字 */
  async findByIds(ids: readonly string[]): Promise<ReadonlyMap<string, User>> {
    const found = await this.repository.findByIds([...new Set(ids)])
    return new Map(found.map(user => [user.id, user]))
  }

  private async lockedAccount(userId: string, transaction: Transaction): Promise<AccountRecord> {
    const account = await this.repository.findRecordForUpdate(userId, transaction)
    if (account === undefined)
      throw new AppError('NOT_FOUND')
    return account
  }

  private async requireAnotherActiveAdmin(userId: string, transaction: Transaction): Promise<void> {
    if (await this.repository.countActiveAdminsExcept(userId, transaction) === 0)
      throw new AppError('LAST_ADMIN')
  }

  private async rehash(user: User, password: string): Promise<void> {
    try {
      await this.repository.updatePasswordHash(user.id, await this.hasher.hash(password))
    }
    catch (error) {
      this.#logger.warn('用新参数重新哈希密码失败，下次登录时再试', { err: error, userId: user.id })
    }
  }

  /**
   * 库里现存哈希的参数交给哈希器，它把没见过的各组参数算几次（Codex 评审 CX4）。不会失败：读不出来或校准不了时只记警告，
   * 下次验证时再做；在那之前，哈希器仍从验证过的哈希里记下各组参数的耗时
   */
  private async observeStoredParameters(): Promise<void> {
    // 读参数与校准（各组参数算几次）都可能失败（数据库暂时不可用、等待哈希的请求太多）：都只记警告，下次验证时再做
    this.#storedParameters ??= this.repository.passwordHashParameters()
      .then(async segments => this.hasher.observe(segments))
      .catch((error: unknown) => {
        this.#storedParameters = undefined
        this.#logger.warn('没能读出或校准现存密码哈希的参数，下次验证时再做', { err: error })
      })
    return this.#storedParameters
  }

  /** 生成失败（例如等待哈希的请求太多）时不缓存失败：下次再生成，否则之后不存在的用户名都会一直出错 */
  private async dummyHash(): Promise<string> {
    if (this.#dummyHash === undefined) {
      const pending = this.hasher.hash(randomBytes(32).toString('base64url'))
      this.#dummyHash = pending
      pending.catch(() => {
        if (this.#dummyHash === pending)
          this.#dummyHash = undefined
      })
    }
    return this.#dummyHash
  }
}

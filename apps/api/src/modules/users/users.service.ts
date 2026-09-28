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

/**
 * 验证通过的凭据：账户，以及验证所用的哈希。验证在事务之外，事务里据此复核：验证之后改过密码、签发或完成了重置、
 * 停用了，复核就不通过（M2-P1 审查 A1）。哈希只在这次请求的内存里，不写日志、不出现在响应里
 */
export interface VerifiedCredentials {
  readonly user: User
  readonly passwordHash: string
}

/** 用户名与密码的验证结果。失败时如果用户名对应的账户存在，带上它（审计的对象）；不区分"不存在"与"密码错误"。 */
export type CredentialCheck
  = | { readonly valid: true, readonly credentials: VerifiedCredentials }
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

  /** 按 id 取账户（含停用的） */
  async findById(id: string): Promise<User | undefined> {
    return this.repository.findById(id)
  }

  /**
   * 锁住账户的行再读（M2-P1 审查 A2）：改动这个账户的凭据、状态、重置与会话的事务，第一步都调它（停用与系统角色的变更
   * 之前另有 advisory lock），在锁里复核状态，再动重置与会话的行。账户不存在时返回 undefined
   */
  async lockAccount(userId: string, transaction: Transaction): Promise<AccountRecord | undefined> {
    return this.repository.lockRecord(userId, transaction)
  }

  /** 按登录名（不区分大小写）取账户（含停用的）：运维命令用 */
  async findByUsername(usernameInput: string): Promise<User | undefined> {
    const username = usernameSchema.safeParse(usernameInput)
    return username.success ? (await this.repository.findCredentialsByUsername(username.data))?.user : undefined
  }

  /** 状态为 active 的账户；停用（M2）或不存在时返回 undefined */
  async findActiveById(id: string): Promise<User | undefined> {
    const user = await this.repository.findById(id)
    return user?.status === 'active' ? user : undefined
  }

  /**
   * 按用户名（不区分大小写）与密码验证。不论账户是否存在、是否可用，都做一次哈希计算；验证失败的计算量由哈希器补齐，
   * 账户的哈希参数与当前配置不同时，失败的耗时也与"用户名不存在"相同（Codex 评审 CX4）。
   * 停用的账户对假哈希验证：密码对不对，耗时都一样，不暴露账户已停用（M2-P1 审查 A8）。
   * 验证通过且哈希的参数已经过时，顺带用当前的参数重新哈希（失败只记日志，不影响这次登录）。
   */
  async verifyCredentials(usernameInput: string, password: string): Promise<CredentialCheck> {
    // 先让哈希器知道库里现存的参数（参数调低之后，旧哈希的计算量更大，失败都要补到它）；读过一次之后不再读
    await this.observeStoredParameters()
    const username = usernameSchema.safeParse(usernameInput)
    const credentials = username.success ? await this.repository.findCredentialsByUsername(username.data) : undefined
    if (credentials === undefined || credentials.user.status !== 'active') {
      await this.hasher.verify(await this.dummyHash(), password)
      return credentials === undefined ? { valid: false } : { valid: false, user: credentials.user }
    }
    if (!await this.hasher.verify(credentials.passwordHash, password))
      return { valid: false, user: credentials.user }
    return { valid: true, credentials: this.hasher.needsRehash(credentials.passwordHash) ? await this.rehash(credentials, password) : credentials }
  }

  /**
   * 登录的事务里复核验证过的凭据（M2-P1 审查 A1）：锁住账户行（FOR SHARE，到提交为止），要求账户仍然有效、
   * 哈希还是验证时的那个。修改密码、签发与完成重置、停用都先锁这一行：它们先提交，这里复核就不通过；
   * 这里先提交，它们随后撤销的会话就包括这次新建的
   */
  async holdCredentials(credentials: VerifiedCredentials, transaction: Transaction): Promise<boolean> {
    const locked = await this.repository.lockCredentials(credentials.user.id, 'share', transaction)
    return locked?.status === 'active' && locked.passwordHash === credentials.passwordHash
  }

  /** 新密码的哈希（修改、重置、接受邀请）：计算密集，调用方放在事务之外。等待哈希的请求太多时抛 PasswordHashingBusyError */
  async hashPassword(password: string): Promise<string> {
    return this.hasher.hash(password)
  }

  /**
   * 让当前密码失效用的哈希（签发重置时，M2-P1 审查 A7）：随机的秘密算出的 Argon2id 哈希，秘密随即丢弃，
   * 谁也不知道对应的密码；格式仍满足表上的 CHECK。计算密集，调用方放在事务之外
   */
  async unusablePasswordHash(): Promise<string> {
    return this.hasher.hash(randomBytes(32).toString('base64url'))
  }

  /**
   * 按 id 验证密码（修改密码时的旧密码，M2-P1 设计 §3.5）。账户不存在或不可用时同样算一次哈希，
   * 失败的耗时由哈希器补齐，与登录相同（ADR-007）。通过时返回验证过的凭据，事务里交给 replacePassword 复核
   */
  async verifyPasswordOf(userId: string, password: string): Promise<VerifiedCredentials | undefined> {
    await this.observeStoredParameters()
    const credentials = await this.repository.findCredentialsById(userId)
    if (credentials === undefined || credentials.user.status !== 'active') {
      await this.hasher.verify(await this.dummyHash(), password)
      return undefined
    }
    return await this.hasher.verify(credentials.passwordHash, password) ? credentials : undefined
  }

  /**
   * 修改密码（M2-P1 审查 A1、A2）：锁住账户行，复核账户仍然有效、哈希还是验证旧密码时的那个，再换成新的哈希。
   * 验证之后改过密码、签发或完成了重置、停用了，返回 false，什么都不改
   */
  async replacePassword(credentials: VerifiedCredentials, passwordHash: string, transaction: Transaction): Promise<boolean> {
    const locked = await this.repository.lockCredentials(credentials.user.id, 'no key update', transaction)
    if (locked?.status !== 'active' || locked.passwordHash !== credentials.passwordHash)
      return false
    await this.repository.updatePasswordHash(credentials.user.id, passwordHash, transaction)
    return true
  }

  /** 设置密码的哈希（完成重置；签发重置时让当前密码失效）。调用方已用 lockAccount 锁住这个账户的行 */
  async setPasswordHash(userId: string, passwordHash: string, transaction: Transaction): Promise<void> {
    await this.repository.updatePasswordHash(userId, passwordHash, transaction)
  }

  /**
   * 停用（M2-P1 设计 §3.5）。已经停用的原样返回（changed 为假）。
   * 停用有效的系统管理员时，要求还有别的有效系统管理员（LAST_ADMIN）。
   * 锁的顺序固定为先 advisory lock、再账户的行锁，与系统角色的变更相同，互相等待时不成环。
   * 操作者在锁里复核仍是有效的系统管理员（审查 A12）：会话守卫检查之后、取到锁之前，他可能刚被取消或停用
   */
  async disable(userId: string, actorId: string, transaction: Transaction): Promise<AccountChange> {
    await this.repository.lockSystemAdmins(transaction)
    await this.requireActingAdmin(actorId, transaction)
    const account = await this.lockedAccount(userId, transaction)
    if (account.status === 'disabled')
      return { account, changed: false }
    if (account.systemRole === 'admin')
      await this.requireAnotherActiveAdmin(account.id, transaction)
    return { account: await this.repository.setStatus(account.id, 'disabled', transaction), changed: true }
  }

  /** 启用：只会让有效的账户变多，"至少保留一个管理员"的检查不必排他；操作者照样在锁里复核（复验 N3） */
  async enable(userId: string, actorId: string, transaction: Transaction): Promise<AccountChange> {
    await this.lockActingAdmin(actorId, transaction)
    const account = await this.lockedAccount(userId, transaction)
    if (account.status === 'active')
      return { account, changed: false }
    return { account: await this.repository.setStatus(account.id, 'active', transaction), changed: true }
  }

  /**
   * 授予或取消系统管理员（M2-P1 设计 §3.5）：只有有效的账户能被授予（ACCOUNT_DISABLED）；
   * 取消有效的系统管理员时，要求还有别的有效系统管理员（LAST_ADMIN）。操作者在锁里复核，同停用
   */
  async changeSystemRole(userId: string, systemRole: UserSystemRole, actorId: string, transaction: Transaction): Promise<AccountChange> {
    await this.repository.lockSystemAdmins(transaction)
    await this.requireActingAdmin(actorId, transaction)
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
    const account = await this.repository.lockRecord(userId, transaction)
    if (account === undefined)
      throw new AppError('NOT_FOUND')
    return account
  }

  /**
   * 管理操作（签发重置、启用、邀请的签发、作废与重发）的事务第一步（复验 N3）：取 system-admins 的共享锁，复核操作者
   * 仍是有效的系统管理员。会话守卫检查之后、事务开始之前（例如签发重置时等待哈希的几秒里）操作者可能刚被取消或停用；
   * 取消与停用取的是排他锁，复核之后到提交之前不会变。锁的顺序：system-admins 的锁在最前面，与停用、系统角色相同
   */
  async lockActingAdmin(actorId: string, transaction: Transaction): Promise<void> {
    await this.repository.lockSystemAdminsShared(transaction)
    await this.requireActingAdmin(actorId, transaction)
  }

  /**
   * 调用方已取 system-admins 的锁（排他或共享）：取消与停用系统管理员都要排他锁，复核之后操作者不会被取消或停用；
   * 启用取共享锁，只会让操作者从无效变有效，不影响"已经通过"的复核。所以不用再锁操作者的行
   */
  private async requireActingAdmin(actorId: string, transaction: Transaction): Promise<void> {
    const actor = await this.repository.findById(actorId, transaction)
    if (actor?.status !== 'active' || actor.systemRole !== 'admin')
      throw new AppError('PERMISSION_DENIED')
  }

  private async requireAnotherActiveAdmin(userId: string, transaction: Transaction): Promise<void> {
    if (await this.repository.countActiveAdminsExcept(userId, transaction) === 0)
      throw new AppError('LAST_ADMIN')
  }

  /**
   * 按当前参数重新哈希，哈希还是验证时的那个才换（审查 A3）。换了就返回带新哈希的凭据，事务里按它复核。
   * 没换，说明期间别处改了哈希：可能是同一个人的另一次登录先重新哈希了（两次正确的登录同时进行），库里的新哈希对这个密码
   * 仍然成立，再验证一次，成立就按它复核，免得把正确的登录算成失败（复验 N1）；改了密码、签发了重置时验证不过，
   * 照原来的凭据去复核（不通过）。失败只记日志，返回原来的凭据，下次登录时再试
   */
  private async rehash(credentials: VerifiedCredentials, password: string): Promise<VerifiedCredentials> {
    try {
      const passwordHash = await this.hasher.hash(password)
      if (await this.repository.replacePasswordHash(credentials.user.id, credentials.passwordHash, passwordHash))
        return { ...credentials, passwordHash }
      const current = await this.repository.findCredentialsById(credentials.user.id)
      return current?.user.status === 'active' && await this.hasher.verify(current.passwordHash, password) ? current : credentials
    }
    catch (error) {
      this.#logger.warn('用新参数重新哈希密码失败，下次登录时再试', { err: error, userId: credentials.user.id })
      return credentials
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

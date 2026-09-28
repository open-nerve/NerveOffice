import type { OnModuleInit } from '@nestjs/common'
import type { User } from './user.ts'
import { randomBytes } from 'node:crypto'
import { usernameSchema } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppLogger } from '../logging/index.ts'
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

  private async rehash(user: User, password: string): Promise<void> {
    try {
      await this.repository.updatePasswordHash(user.id, await this.hasher.hash(password))
    }
    catch (error) {
      this.#logger.warn('用新参数重新哈希密码失败，下次登录时再试', { err: error, userId: user.id })
    }
  }

  /**
   * 库里现存哈希的参数交给哈希器（Codex 评审 CX4）。不会失败：读不出来（例如数据库暂时不可用）时只记警告，
   * 下次验证时再读；在那之前，哈希器仍从验证过的哈希里学到更大的计算量
   */
  private async observeStoredParameters(): Promise<void> {
    this.#storedParameters ??= this.repository.passwordHashParameters().then(
      (segments) => {
        this.hasher.observe(segments)
      },
      (error: unknown) => {
        this.#storedParameters = undefined
        this.#logger.warn('没能读出现存密码哈希的参数，下次验证时再读', { err: error })
      },
    )
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

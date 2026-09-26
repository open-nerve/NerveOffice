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
export class UsersService {
  readonly #logger: AppLogger
  /** 用户名不存在时拿来算一次哈希的假哈希：响应时间与"密码错误"相近，不暴露账户是否存在 */
  #dummyHash: Promise<string> | undefined

  constructor(
    private readonly repository: UsersRepository,
    private readonly hasher: PasswordHasher,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'users' })
  }

  /** 状态为 active 的账户；停用（M2）或不存在时返回 undefined */
  async findActiveById(id: string): Promise<User | undefined> {
    const user = await this.repository.findById(id)
    return user?.status === 'active' ? user : undefined
  }

  /**
   * 按用户名（不区分大小写）与密码验证。不论账户是否存在、是否可用，都做一次哈希计算。
   * 验证通过且哈希的参数已经过时，顺带用当前的参数重新哈希（失败只记日志，不影响这次登录）。
   */
  async verifyCredentials(usernameInput: string, password: string): Promise<CredentialCheck> {
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

  private async dummyHash(): Promise<string> {
    this.#dummyHash ??= this.hasher.hash(randomBytes(32).toString('base64url'))
    return this.#dummyHash
  }
}

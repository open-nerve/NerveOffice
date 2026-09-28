import type { UserSystemRole } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { User } from './user.ts'
import { Injectable } from '@nestjs/common'
import { SpacesService } from '../spaces/index.ts'
import { UsersRepository } from './users.repository.ts'

export interface NewAccount {
  /** 规范写法（小写） */
  readonly username: string
  readonly displayName: string
  readonly passwordHash: string
  readonly systemRole: UserSystemRole
}

export interface CreatedAccount {
  readonly user: User
  readonly personalSpaceId: string
}

/**
 * 建账户（初始化管理员、接受邀请共用，M2-P1 设计 §3.4）：账户与它的个人空间在调用方的同一个事务里建成。
 * 登录名是否可用由调用方先检查：先取这个登录名的锁（lockUsername），再查 isUsernameTaken，再建。
 */
@Injectable()
export class AccountCreationService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly spaces: SpacesService,
  ) {}

  async lockUsername(username: string, transaction: Transaction): Promise<void> {
    await this.repository.lockUsername(username, transaction)
  }

  async isUsernameTaken(username: string, transaction: Transaction): Promise<boolean> {
    return this.repository.existsWithUsername(username, transaction)
  }

  async create(account: NewAccount, transaction: Transaction): Promise<CreatedAccount> {
    const user = await this.repository.insert(account, transaction)
    const space = await this.spaces.createPersonalSpace(user.id, user.displayName, { transaction })
    return { user, personalSpaceId: space.id }
  }
}

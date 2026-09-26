import type { z } from 'zod'
import { displayNameSchema, newPasswordSchema, usernameSchema } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { PasswordHasher } from './password-hasher.ts'
import { UsersRepository } from './users.repository.ts'

export interface AdminInitializationInput {
  readonly username: string
  /** 不填时用用户名 */
  readonly displayName?: string
  readonly password: string
}

export interface InitializedAdmin {
  readonly userId: string
  readonly username: string
  readonly personalSpaceId: string
}

/** 不合法的输入：说明取自 contracts 的规则（面向运维人员，不含取值）。 */
function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new AppError('REQUEST_INVALID', result.error.issues[0]?.message)
  return result.data
}

/**
 * 初始化首个系统管理员（P3 设计 §3.4，US-M1-01）。
 * 已有系统管理员时拒绝，数据不变；两个并发的初始化只有一个成功（事务里的 advisory lock）。
 * 用户名已被普通账户占用时明确报错，而不是让唯一约束报出笼统的数据库错误。
 */
@Injectable()
export class AdminInitializationService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly spaces: SpacesService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {}

  async initialize(input: AdminInitializationInput): Promise<InitializedAdmin> {
    const username = parseInput(usernameSchema, input.username)
    const displayName = parseInput(displayNameSchema, input.displayName ?? username)
    const password = parseInput(newPasswordSchema, input.password)
    // 哈希是计算密集的操作，放在事务之外：事务要尽量短（规范 §5）
    const passwordHash = await this.hasher.hash(password)
    return this.transactions.run(async (transaction) => {
      await this.repository.lockAdminInitialization(transaction)
      if (await this.repository.existsWithRole('admin', transaction))
        throw new AppError('ADMIN_ALREADY_INITIALIZED')
      if (await this.repository.existsWithUsername(username, transaction))
        throw new AppError('USERNAME_TAKEN')
      const user = await this.repository.insert({ username, displayName, passwordHash, systemRole: 'admin' }, transaction)
      const space = await this.spaces.createPersonalSpace(user.id, user.displayName, { transaction })
      await this.audit.record({
        action: 'users.admin_initialized',
        actor: { type: 'system' },
        target: { type: 'user', id: user.id },
        origin: { source: 'cli' },
        details: { username },
      }, { transaction })
      return { userId: user.id, username, personalSpaceId: space.id }
    })
  }
}

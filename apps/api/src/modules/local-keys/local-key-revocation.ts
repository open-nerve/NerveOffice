import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { LocalKeysRepository } from './local-keys.repository.ts'
import { generateLocalKey, MasterKeyring } from './master-keyring.ts'

/** 吊销这一次的结果：被吊销的那一版与随即生成的下一版（admin 原样交给管理员，Codex 评审 CX3：响应里的"这一次的结果"就是它） */
export interface RevokedLocalKey {
  readonly revokedVersion: number
  readonly nextVersion: number
}

/**
 * 吊销某人的本机密钥（M3-P6 设计 §3.5）：当前的那一把记下吊销的时刻、擦掉密钥材料（库里不再留能解开旧草稿的东西），
 * 在同一个事务里生成下一版、用现在的主密钥包装（吊销不需要旧的主密钥：主密钥丢了也能这样恢复）；下一版的生成时刻就是上一版被吊销的那一刻
 * （时间线单调，审查 A1；仓储在 SQL 里取，时刻不经这里，复验 C2）。下一版的原始密钥不交给任何人，本人下一次取用时解包。
 * 这里不判断调用者是谁、有没有权限：只由 admin 调用（lint 拦下别的模块的引用，M3-P6 设计 §3.7），admin 在调用之前在锁里复核操作者
 * （system-admins 的共享锁）、锁住这个账户的行——两个并发的吊销由账户行串起来，后一个吊销前一个生成的那一版。
 * 锁的顺序：账户行 → 本机密钥行 → 审计（admin 在同一个事务里记）
 */
@Injectable()
export class LocalKeyRevocation {
  constructor(
    private readonly repository: LocalKeysRepository,
    private readonly keyring: MasterKeyring,
  ) {}

  /** 返回被吊销的版本与下一版；这个人没有当前的密钥（从没取过）时返回 undefined，什么也没写 */
  async revoke(userId: string, transaction: Transaction): Promise<RevokedLocalKey | undefined> {
    const revokedVersion = await this.repository.revokeCurrent(userId, transaction)
    if (revokedVersion === undefined)
      return undefined
    const nextVersion = revokedVersion + 1
    const rawKey = generateLocalKey()
    try {
      await this.repository.insertNext(userId, nextVersion, this.keyring.wrap(rawKey, { userId, version: nextVersion }), transaction)
    }
    finally {
      rawKey.fill(0)
    }
    return { revokedVersion, nextVersion }
  }
}

import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { LoginThrottleRepository } from './login-throttle.repository.ts'
import { accountDigest } from './throttle-keys.ts'

/**
 * 一个账户的登录锁定：最晚锁到什么时候；allSources 为真时只按用户名的上限到了，这个账户在所有来源上都登录不了，
 * 为假时只锁了某些来源（按用户名与来源的组合），本人从别的来源照常登录
 */
export interface LoginLock {
  readonly until: Date
  readonly allSources: boolean
}

/**
 * 按账户看登录限流（M2-P6 复核 A1）：一个账户的计数行有只按用户名的一行、按用户名与各个来源的若干行，行上都记着所属账户。
 * - 查询：管理界面的账户行说明锁到什么时候，是全部来源还是部分来源；
 * - 清除：系统管理员解除锁定、本人完成重置密码或接受邀请（用链接证明了控制着这个账户）时，在调用方的事务里一次删掉。
 * 只按来源的地址维度不属于任何账户，不在这里查，也不在这里清。
 * 用户名是规范写法（账户表里存的就是）：与登录时规范化之后的用户名算出同一个摘要。
 */
@Injectable()
export class LoginLockouts {
  constructor(private readonly repository: LoginThrottleRepository) {}

  /**
   * 这些账户里登录仍被锁定的，各自的锁定；没有锁定的不在结果里。管理员改动账户之后的响应传入那个事务，在提交之前读
   * （M2-P6 第 3 片复验：提交之后不再访问数据库），读到的包括这个事务自己的改动（例如刚解除的锁定）
   */
  async locksOf(usernames: readonly string[], transaction?: Transaction): Promise<ReadonlyMap<string, LoginLock>> {
    const byDigest = new Map(usernames.map(username => [accountDigest(username).toString('hex'), username]))
    const rows = await this.repository.locksOfAccounts([...usernames].map(accountDigest), transaction)
    const locks = new Map<string, LoginLock>()
    for (const row of rows) {
      const username = byDigest.get(row.accountHash.toString('hex'))
      if (username !== undefined)
        locks.set(username, { until: row.lockedUntil, allSources: row.allSources })
    }
    return locks
  }

  /**
   * 清掉这个账户在所有来源上的计数；返回清掉了没有（没有计数时为假）。
   * 调用方先锁了这个账户的行（ADR-007 的锁顺序：账户行 → 重置行或邀请行 → 限流计数 → 会话行），
   * 与这个账户的登录、修改密码的成功排队，一次删多行也不会与它们互相等待
   */
  async clear(username: string, transaction: Transaction): Promise<boolean> {
    return await this.repository.resetAccount(accountDigest(username), transaction) > 0
  }
}

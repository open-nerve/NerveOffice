import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { LockedForSeconds, Reservation, ThrottlePolicy } from './login-throttle.repository.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { LoginThrottleRepository } from './login-throttle.repository.ts'
import { addressKey, keyDigest, usernameKey } from './throttle-keys.ts'

/** 一次登录尝试的来源：规范化之后的用户名与客户端地址。 */
export interface LoginAttempt {
  readonly username: string
  readonly clientIp?: string
}

/** 放行的尝试占到的名额（每个维度一个）。验证失败时不用交回，计为一次失败。 */
export interface LoginTicket {
  /** 这次占用使计数达到上限而锁定时，离解锁的秒数（取两个维度里较长的）：验证失败时据此返回 429 */
  readonly lockedForSeconds: LockedForSeconds
  /** 验证成功：清除用户名的计数，退回地址维度的名额。与新建会话放在同一个事务里 */
  readonly succeeded: (transaction?: Transaction) => Promise<void>
}

export type Admission
  = | { readonly admitted: true, readonly ticket: LoginTicket }
    | { readonly admitted: false, readonly retryAfterSeconds: number }

interface Dimension {
  readonly name: 'username' | 'address'
  readonly keyHash: Buffer
  readonly policy: ThrottlePolicy
}

interface Hold extends Reservation {
  readonly dimension: Dimension
}

/**
 * 登录限流（P3 设计 §3.5）：按用户名与按客户端地址两个维度，各自一个窗口内的失败次数，达到上限就锁定。
 * 计数存在数据库里：重启不丢，将来多实例也共用。
 *
 * 先占用、再验证：验证密码之前就把这次尝试记进计数，并发的请求不会都在锁定之前通过检查
 * （先查、验证、再记失败时，一波并发请求能全部验证，P3 审查 A1）。
 */
@Injectable()
export class LoginThrottle {
  constructor(
    private readonly repository: LoginThrottleRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 放行或拒绝一次尝试：
   * 1. 预检：任一维度锁定中直接拒绝。只读的一次查询，锁定期间的洪水不写库；正确性不靠它，靠第 2 步；
   * 2. 依次占用两个维度的名额。后一个维度被拒绝时，退回已经占到的名额：这次没有验证，不算失败。
   */
  async admit(attempt: LoginAttempt): Promise<Admission> {
    const dimensions = this.dimensionsOf(attempt)
    const locked = await this.repository.lockedFor(dimensions.map(dimension => dimension.keyHash))
    if (locked !== undefined)
      return { admitted: false, retryAfterSeconds: locked }

    const holds: Hold[] = []
    for (const dimension of dimensions) {
      const reservation = await this.repository.reserve(dimension.keyHash, dimension.policy)
      if (reservation === undefined) {
        for (const hold of holds)
          await this.repository.release(hold.dimension.keyHash, hold.window)
        // 预检之后刚被别的请求锁定；查到时锁定可能恰好结束，至少让客户端等 1 秒
        return { admitted: false, retryAfterSeconds: (await this.repository.lockedFor([dimension.keyHash])) ?? 1 }
      }
      holds.push({ ...reservation, dimension })
    }
    return { admitted: true, ticket: this.ticketFor(holds) }
  }

  /** 删除一小批过期的计数。在事务之外调用。 */
  async purgeExpired(): Promise<void> {
    await this.repository.purgeExpired(this.config.login.windowMinutes)
  }

  private ticketFor(holds: readonly Hold[]): LoginTicket {
    const locks = holds.flatMap(hold => (hold.lockedForSeconds === undefined ? [] : [hold.lockedForSeconds]))
    return {
      lockedForSeconds: locks.length === 0 ? undefined : Math.max(...locks),
      succeeded: async (transaction) => {
        for (const hold of holds) {
          // 用户名：成功之前的失败一笔勾销。地址：只退回这次的名额，之前的失败照算，
          // 免得攻击者夹着自己账户的成功登录，继续尝试别的账户
          if (hold.dimension.name === 'username')
            await this.repository.reset(hold.dimension.keyHash, transaction)
          else
            await this.repository.release(hold.dimension.keyHash, hold.window, transaction)
        }
      },
    }
  }

  /** 先用户名、再地址：成功时的事务按同一顺序锁这两行，互相等待时不会成环。 */
  private dimensionsOf(attempt: LoginAttempt): Dimension[] {
    const { maxFailures, ipMaxFailures, windowMinutes, lockoutMinutes } = this.config.login
    return [
      { name: 'username', keyHash: keyDigest(usernameKey(attempt.username)), policy: { maxFailures, windowMinutes, lockoutMinutes } },
      { name: 'address', keyHash: keyDigest(addressKey(attempt.clientIp)), policy: { maxFailures: ipMaxFailures, windowMinutes, lockoutMinutes } },
    ]
  }
}

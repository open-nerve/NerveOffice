import type { Buffer } from 'node:buffer'
import type { Transaction } from '../database/index.ts'
import type { LockedForSeconds, LoginThrottleRepository, Reservation, ThrottlePolicy } from './login-throttle.repository.ts'

/** 限流的一个维度：计数的键（只存摘要）、上限，以及成功时怎么处理这个维度的计数。 */
export interface ThrottleDimension {
  readonly name: string
  readonly keyHash: Buffer
  /**
   * 所属账户的摘要（M2-P6 复核 A1）：登录的两个账户相关的维度（只按用户名、按用户名与来源）才有，记在计数行上，
   * 完成重置、管理员解除锁定时按它一次清掉这个账户在所有来源上的计数
   */
  readonly account?: Buffer
  readonly policy: ThrottlePolicy
  /**
   * 成功时：reset 清除这个键的计数（之前的失败一笔勾销，例如登录的用户名）；
   * release 只退回这次占的名额，之前的失败照算（例如客户端地址：免得攻击者夹着自己的成功继续尝试别的）
   */
  readonly onSuccess: 'reset' | 'release'
}

/** 放行的尝试占到的名额（每个维度一个）。失败时不用交回，计为一次失败。 */
export interface AttemptTicket {
  /** 这次占用使计数达到上限而锁定时，离解锁的秒数（取各维度里较长的）：失败时据此返回 429 */
  readonly lockedForSeconds: LockedForSeconds
  /** 成功：按各维度的 onSuccess 处理。与成功的写入放在同一个事务里 */
  readonly succeeded: (transaction?: Transaction) => Promise<void>
  /**
   * 退回全部名额，不算失败：没有真正尝试就放弃了（例如等待哈希的请求太多，DEF-015），
   * 或者这次失败不是在猜（一次性链接找到了记录、只是过期或用过了，M2-P6 复核 B3）
   */
  readonly abandoned: () => Promise<void>
}

export type AttemptAdmission
  = | { readonly admitted: true, readonly ticket: AttemptTicket }
    | { readonly admitted: false, readonly retryAfterSeconds: number }

interface Hold extends Reservation {
  readonly dimension: ThrottleDimension
}

/**
 * 先占用、再尝试的限流（P3 设计 §3.5；M2-P1 起登录与一次性链接共用）：尝试之前就把这次记进计数，
 * 并发的请求不会都在锁定之前通过检查（先查、尝试、再记失败时，一波并发请求能全部尝试，P3 审查 A1）。
 * 计数存在数据库里（LoginThrottleRepository）：重启不丢，将来多实例也共用。
 */
export class AttemptThrottle {
  constructor(private readonly repository: LoginThrottleRepository) {}

  /**
   * 放行或拒绝一次尝试：
   * 1. 预检：任一维度锁定中直接拒绝。只读的一次查询，锁定期间的洪水不写库；正确性不靠它，靠第 2 步；
   * 2. 按给出的顺序依次占用各维度的名额。后一个维度被拒绝时，退回已经占到的名额：这次没有尝试，不算失败。
   *    各处按同一个顺序给出维度，成功时的事务按同一顺序锁这些行，互相等待时不会成环。
   */
  async admit(dimensions: readonly ThrottleDimension[]): Promise<AttemptAdmission> {
    const locked = await this.repository.lockedFor(dimensions.map(dimension => dimension.keyHash))
    if (locked !== undefined)
      return { admitted: false, retryAfterSeconds: locked }

    const holds: Hold[] = []
    for (const dimension of dimensions) {
      const reservation = await this.repository.reserve(dimension.keyHash, dimension.policy, dimension.account)
      if (reservation === undefined) {
        await this.release(holds)
        // 预检之后刚被别的请求锁定；查到时锁定可能恰好结束，至少让客户端等 1 秒
        return { admitted: false, retryAfterSeconds: (await this.repository.lockedFor([dimension.keyHash])) ?? 1 }
      }
      holds.push({ ...reservation, dimension })
    }
    return { admitted: true, ticket: this.ticketFor(holds) }
  }

  private ticketFor(holds: readonly Hold[]): AttemptTicket {
    const locks = holds.flatMap(hold => (hold.lockedForSeconds === undefined ? [] : [hold.lockedForSeconds]))
    return {
      lockedForSeconds: locks.length === 0 ? undefined : Math.max(...locks),
      succeeded: async (transaction) => {
        for (const hold of holds) {
          if (hold.dimension.onSuccess === 'reset')
            await this.repository.reset(hold.dimension.keyHash, transaction)
          else
            await this.repository.release(hold.dimension.keyHash, hold.window, transaction)
        }
      },
      abandoned: async () => this.release(holds),
    }
  }

  /** 退回占到的名额：这次没有尝试，不算失败。 */
  private async release(holds: readonly Hold[]): Promise<void> {
    for (const hold of holds)
      await this.repository.release(hold.dimension.keyHash, hold.window)
  }
}

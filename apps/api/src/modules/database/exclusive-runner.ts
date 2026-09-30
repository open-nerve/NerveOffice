import { Inject, Injectable } from '@nestjs/common'
import pg from 'pg'
import { PG_POOL } from './database.ts'

/** 一次独占执行的结果：拿到锁就有结果，没拿到说明别处正在做同一件事。 */
export type ExclusiveOutcome<T>
  = | { readonly ran: true, readonly result: T }
    | { readonly ran: false }

/** 借来的连接上取会话级 advisory lock，不等待：别处持有时立即返回 false。 */
const TRY_LOCK = 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked'
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'

/**
 * 同一时刻只让一个实例做某件事（M2-P4 设计 §3.4 第 6 条，DEF-024 的多实例）：
 * 借一个连接，在它上面取**会话级**的 advisory lock，拿到才执行 work，结束时释放并归还连接。
 *
 * 为什么是会话级而不是事务级：调用方（jobs 的一轮清理）要把每一项放进各自的短事务里做，
 * 锁必须跨这些事务一直持有；事务级的锁在第一个事务提交时就没了。会话级的锁绑在连接上，
 * 所以这里自己借一个连接、按顺序发出取锁与释放的语句，不能用连接池上的 Drizzle 实例（每条语句可能落在不同的连接上）。
 *
 * 释放失败、work 抛出（这时锁还在这个连接上）时丢弃连接：会话结束，数据库随即释放它持有的 advisory lock，
 * 不会因为一次异常把锁永远留在池子里的某个连接上。
 */
@Injectable()
export class ExclusiveRunner {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * name 是锁的名字（例如 `nerve-office:trash-purge`），与别处的 advisory lock 一样由它算出锁键。
   * 拿不到锁时不执行 work，返回 `{ ran: false }`；work 抛出的错误原样抛给调用方。
   */
  async run<T>(name: string, work: () => Promise<T>): Promise<ExclusiveOutcome<T>> {
    const client = await this.pool.connect()
    let discard = false
    try {
      const locked = (await client.query<{ locked: boolean }>(TRY_LOCK, [name])).rows[0]?.locked === true
      if (!locked)
        return { ran: false }
      try {
        return { ran: true, result: await work() }
      }
      finally {
        // 释放不成功（报错，或者数据库说这个会话没有持有它）时丢弃连接：会话结束即释放锁
        const unlocked = await client.query<{ unlocked: boolean }>(UNLOCK, [name]).then(
          result => result.rows[0]?.unlocked === true,
          () => false,
        )
        discard ||= !unlocked
      }
    }
    catch (error) {
      discard = true
      throw error
    }
    finally {
      // 连接不是空闲状态（work 里出了岔子、状态未知）时同样丢弃，与 TransactionRunner 一致
      client.release(discard || client.getTransactionStatus() !== 'I')
    }
  }
}

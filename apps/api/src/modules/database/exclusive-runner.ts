import type { Database, Transaction } from './database.ts'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { DATABASE, executorOf, PG_POOL } from './database.ts'
import { TransactionRunner } from './transaction-runner.ts'

/** 一次独占执行的结果：拿到锁就有结果，没拿到说明别处正在做同一件事。 */
export type ExclusiveOutcome<T>
  = | { readonly ran: true, readonly result: T }
    | { readonly ran: false }

/** 借来的连接上取会话级 advisory lock，不等待：别处持有时立即返回 false。 */
const TRY_LOCK = 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked'
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'

/**
 * 同一时刻只让一个实例做某件事（M2-P4 设计 §3.4 第 6 条，DEF-024 的多实例），两种粒度，锁名相同就互斥（同一套锁键）：
 *
 * - run：一件跨几个事务的事。借一个连接，在它上面取**会话级**的 advisory lock，拿到才执行 work，结束时释放并归还连接。
 *   调用方（回收站的清理）要把每一项放进各自的短事务里做，锁必须跨这些事务一直持有；事务级的锁在第一个事务提交时就没了。
 *   会话级的锁绑在连接上，所以这里自己借一个连接、按顺序发出取锁与释放的语句，不能用连接池上的 Drizzle 实例（每条语句可能落在
 *   不同的连接上）。代价是一轮期间占着这个连接，work 里的事务还要另一个（连接池的下限，config.ts 的 TRASH_PURGE_MIN_POOL）。
 *   释放失败、work 抛出（这时锁还在这个连接上）时丢弃连接：会话结束，数据库随即释放它持有的 advisory lock，
 *   不会因为一次异常把锁永远留在池子里的某个连接上。
 * - runTransaction：一件本身就是一个短事务的事（修订记录与回执的保留期清理的一批，M3-P3 设计 §3.9）。开一个事务，在里面取
 *   **事务级**的锁（pg_try_advisory_xact_lock），拿到才在同一个事务里执行 work；事务提交或回滚时数据库自动释放，没有释放的语句，
 *   也没有"锁留在连接上"的情形。只占一个连接，不拿着它去等另一个
 */
@Injectable()
export class ExclusiveRunner {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(DATABASE) private readonly db: Database,
    private readonly transactions: TransactionRunner,
  ) {}

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

  /**
   * 在一个新事务里取名为 name 的事务级锁，不等待：拿到就在这个事务里执行 work，work 正常返回时提交；拿不到时什么也不执行，
   * 返回 `{ ran: false }`（空事务照常结束）。work 抛出时事务回滚、错误原样抛给调用方。锁随事务结束释放
   */
  async runTransaction<T>(name: string, work: (transaction: Transaction) => Promise<T>): Promise<ExclusiveOutcome<T>> {
    return this.transactions.run(async (transaction): Promise<ExclusiveOutcome<T>> => {
      const { rows } = await executorOf(this.db, transaction).execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) AS locked`)
      if (rows[0]?.locked !== true)
        return { ran: false }
      return { ran: true, result: await work(transaction) }
    })
  }
}

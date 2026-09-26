import type { Transaction } from './database.ts'
import { Inject, Injectable } from '@nestjs/common'
import pg from 'pg'
import { AppError } from '../../shared/errors/app-error.ts'
import { createDatabase, PG_POOL } from './database.ts'

/** work 吞掉了失败的语句却正常返回时的说明。 */
export const TRANSACTION_ABORTED_MESSAGE = '事务里有语句失败，事务已中止，不能当作成功提交：预期会失败的语句由仓储放进保存点（transaction()），或者改用 ON CONFLICT'

/**
 * 服务用它开启事务：需要把几次写入（可能跨模块，例如新建文档加审计）放进同一个事务时，
 * 在 run() 里调用各仓储的方法并把事务传下去；work 抛出时回滚，否则提交（P2 设计 §3.7）。
 *
 * 连接由这里借出、归还，不让 drizzle 的 transaction() 在连接池上自己取（复验 N8）：
 * - drizzle 0.45.3 在 BEGIN 失败时不归还连接：几次网络故障就能耗尽连接池，而且不会自己恢复；
 * - drizzle 归还连接时不说明是否出错：查询超时后，没能发出 ROLLBACK 的连接会带着未结束的事务回到池里，
 *   下一个借到它的事务提交时，会把失败事务的写入一起提交。
 * 归还的规则：事务以业务错误（AppError）结束时，回滚已经成功（drizzle 只在回滚成功时抛出 work 原来的错误），连接照常放回；
 * 其他失败一律丢弃这个连接，与连接池自己的 query() 一致；连接不是空闲状态（还在事务里、状态未知）时同样丢弃。
 */
@Injectable()
export class TransactionRunner {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let discard = false
    try {
      return await createDatabase(client).transaction(async (tx) => {
        const result = await work(tx as unknown as Transaction)
        // 事务里有语句失败、work 却把错误吞掉正常返回时，事务已经中止，COMMIT 会被数据库静默当作回滚：
        // 不能报告成功。抛出之后 drizzle 回滚（复验：中止的事务）
        if (client.getTransactionStatus() === 'E')
          throw new Error(TRANSACTION_ABORTED_MESSAGE)
        return result
      })
    }
    catch (error) {
      discard = !(error instanceof AppError)
      throw error
    }
    finally {
      // 只有空闲的连接放回池里：不依赖 drizzle 在各种失败下是否发出了 ROLLBACK
      client.release(discard || client.getTransactionStatus() !== 'I')
    }
  }
}

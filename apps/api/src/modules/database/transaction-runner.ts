import type { Transaction } from './database.ts'
import { Inject, Injectable } from '@nestjs/common'
import pg from 'pg'
import { AppError } from '../../shared/errors/app-error.ts'
import { createDatabase, PG_POOL } from './database.ts'

/**
 * 服务用它开启事务：需要把几次写入（可能跨模块，例如新建文档加审计）放进同一个事务时，
 * 在 run() 里调用各仓储的方法并把事务传下去；work 抛出时回滚，否则提交（P2 设计 §3.7）。
 *
 * 连接由这里借出、归还，不让 drizzle 的 transaction() 在连接池上自己取（复验时发现）：
 * - drizzle 0.45.3 在 BEGIN 失败时不归还连接：几次网络故障就能耗尽连接池，而且不会自己恢复；
 * - drizzle 归还连接时不说明是否出错：查询超时后可能已经半开的连接会回到池里，被下一个请求借走。
 * 事务以业务错误（AppError）结束时，回滚已经成功（drizzle 只在回滚成功时抛出 work 原来的错误），连接照常放回；
 * 其他失败一律丢弃这个连接，与连接池自己的 query() 一致。
 */
@Injectable()
export class TransactionRunner {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let discard = false
    try {
      return await createDatabase(client).transaction(async tx => work(tx as unknown as Transaction))
    }
    catch (error) {
      discard = !(error instanceof AppError)
      throw error
    }
    finally {
      client.release(discard)
    }
  }
}

import type { Database, Transaction } from './database.ts'
import { Inject, Injectable } from '@nestjs/common'
import { DATABASE } from './database.ts'

/**
 * 服务用它开启事务：需要把几次写入（可能跨模块，例如新建文档加审计）放进同一个事务时，
 * 在 run() 里调用各仓储的方法并把事务传下去；work 抛出时回滚，否则提交（P2 设计 §3.7）。
 */
@Injectable()
export class TransactionRunner {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => work(tx as unknown as Transaction))
  }
}

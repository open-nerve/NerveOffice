import type { DbTransaction, Transaction } from './database.ts'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { AppError } from '../../shared/errors/app-error.ts'
import { createDatabase, PG_POOL } from './database.ts'

/** work 吞掉了失败的语句却正常返回时的说明。 */
export const TRANSACTION_ABORTED_MESSAGE = '事务里有语句失败，事务已中止，不能当作成功提交：预期会失败的语句由仓储放进保存点（transaction()），或者改用 ON CONFLICT'

/** PostgreSQL 的 SQLSTATE 25P02：事务已中止，之后的语句都被拒绝，直到结束事务。 */
const IN_FAILED_SQL_TRANSACTION = '25P02'

function isAbortedTransaction(error: unknown): boolean {
  // drizzle 把驱动的错误包在 cause 里
  const cause: unknown = error instanceof Error ? error.cause : undefined
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === IN_FAILED_SQL_TRANSACTION
}

/**
 * work 返回之后确认事务仍然可用：work 吞掉了失败的语句时，事务已经中止，COMMIT 会被数据库静默当作回滚，不能报告成功。
 * 用一条语句确认，而不是读连接上记下的事务状态：驱动在收到错误时就让那条语句失败返回，
 * 事务状态要等随后的 ReadyForQuery 才更新，两条消息分开到达时读到的还是旧状态（P3 的集成测试在负载下复现）。
 * 事务中止时这条语句必然报 25P02。
 */
async function assertTransactionUsable(tx: DbTransaction): Promise<void> {
  try {
    await tx.execute(sql`SELECT 1`)
  }
  catch (error) {
    if (isAbortedTransaction(error))
      throw new Error(TRANSACTION_ABORTED_MESSAGE, { cause: error })
    throw error
  }
}

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
        // 抛出之后 drizzle 回滚（P2 复验 G3）
        await assertTransactionUsable(tx)
        return result
      })
    }
    catch (error) {
      discard = !(error instanceof AppError)
      throw error
    }
    finally {
      // 只有空闲的连接放回池里：不依赖 drizzle 在各种失败下是否发出了 ROLLBACK。
      // 走到这里时，最后一条语句（COMMIT 或 ROLLBACK）成功返回的话，驱动已经收到它的 ReadyForQuery，状态是准的；
      // 最后一条语句失败的话，错误不是 AppError，本来就要丢弃
      client.release(discard || client.getTransactionStatus() !== 'I')
    }
  }
}

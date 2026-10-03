import type { DbTransaction, Transaction } from './database.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { AppError } from '../../shared/errors/app-error.ts'
import { CommitLedger } from './commit-ledger.ts'
import { createDatabase, PG_POOL } from './database.ts'

/** work 吞掉了失败的语句却正常返回时的说明。 */
export const TRANSACTION_ABORTED_MESSAGE = '事务里有语句失败，事务已中止，不能当作成功提交：预期会失败的语句由仓储放进保存点（transaction()），或者改用 ON CONFLICT'

/**
 * 只读快照的开场核对（M2 Codex 评审 CX1）：快照里的第一条语句，同时确定快照的时刻（REPEATABLE READ 的快照取在第一条语句上）。
 * 由 auth 模块登记（registerSnapshotOpening）：database 不依赖 auth、users，核对什么由登记的一方决定。
 * 不通过时抛出（AppError，例如登录已过期、没有权限），快照随即结束，处理器读不到任何数据
 */
export type SnapshotOpening = (transaction: Transaction) => Promise<void>

/** 只读快照的事务：REPEATABLE READ 与 READ ONLY（drizzle 发出 begin isolation level repeatable read read only） */
const READ_SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

/** 已经在只读快照里时再开事务（快照或写事务）的说明：会另借一个连接，连接池满时与外层互相等待 */
export const NESTED_IN_SNAPSHOT_MESSAGE = '只读快照里不能再开事务：内层的方法接受外层快照的事务参数，一个请求只开一个快照（另借连接会在连接池满时与外层互相等待）'

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
 * 登录之后的读请求用 readSnapshot()：判断权限与读数据在同一个只读快照里（M2 Codex 评审 CX1）。
 *
 * 连接由这里借出、归还，不让 drizzle 的 transaction() 在连接池上自己取（复验 N8）：
 * - drizzle 0.45.3 在 BEGIN 失败时不归还连接：几次网络故障就能耗尽连接池，而且不会自己恢复；
 * - drizzle 归还连接时不说明是否出错：查询超时后，没能发出 ROLLBACK 的连接会带着未结束的事务回到池里，
 *   下一个借到它的事务提交时，会把失败事务的写入一起提交。
 * 归还的规则：事务以业务错误（AppError）结束时，回滚已经成功（drizzle 只在回滚成功时抛出 work 原来的错误），连接照常放回；
 * 其他失败一律丢弃这个连接，与连接池自己的 query() 一致；连接不是空闲状态（还在事务里、状态未知）时同样丢弃。
 *
 * COMMIT 成功之后在这个请求的记录上记一笔（CommitLedger，M2-P6 第 3 片复验）：之后这个请求再遇到数据库繁忙，
 * 写入已经生效，异常过滤器不再回答"确定没有生效"的 503。回滚、COMMIT 本身失败都不记
 */
@Injectable()
export class TransactionRunner {
  /** 只读快照的开场核对（auth 模块登记）；没有登记时快照不做核对（单元测试、只组装了部分模块的命令行） */
  #opening: SnapshotOpening | undefined
  /**
   * 正在只读快照里：快照里再开事务就报错（NESTED_IN_SNAPSHOT_MESSAGE）。标记跟着快照里发起的异步操作一直走，
   * 快照结束时记为已结束（open 改为 false）：快照里排下、快照结束之后才执行的事务不是嵌套，照常执行
   */
  readonly #inSnapshot = new AsyncLocalStorage<{ open: boolean }>()

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly commits: CommitLedger,
  ) {}

  async run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.#refuseInsideSnapshot()
    const client = await this.pool.connect()
    let discard = false
    try {
      const result = await createDatabase(client).transaction(async (tx) => {
        const value = await work(tx as unknown as Transaction)
        // 抛出之后 drizzle 回滚（P2 复验 G3）
        await assertTransactionUsable(tx)
        return value
      })
      // drizzle 在 COMMIT 返回之后才交回结果：走到这里就是已经提交
      this.commits.recordCommit()
      return result
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

  /**
   * 登记只读快照的开场核对（控制反转：auth 模块在初始化时登记，database 不依赖 auth、users）。
   * 只能登记一次：登记两次是接线错误，直接报错，不让后登记的悄悄盖掉先登记的
   */
  registerSnapshotOpening(opening: SnapshotOpening): void {
    if (this.#opening !== undefined)
      throw new Error('只读快照的开场核对已经登记过')
    this.#opening = opening
  }

  /**
   * 只读快照（M2 Codex 评审 CX1）：登录之后的读请求（全部 GET 接口）在它里面判断权限、读数据，响应是数据库某一时刻的一致视图，
   * 而且在那一时刻这个人有权看到其中的全部内容。原来权限判断与读数据是连接池上各自自动提交的语句，READ COMMITTED 下每条语句
   * 看到的是它执行那一刻的数据：判断完权限、读数据之前撤权并写入的新数据，会被这个在途的请求带出去。
   * 借一个连接，BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY，先执行登记的开场核对（第一条语句，同时确定快照的时刻：
   * 会话守卫在快照之前判断过的事实——账户仍然有效、系统角色——在这一刻再查一次，见 auth 的 SnapshotIdentityCheck），
   * 再执行 work，COMMIT。
   * - 只读：不往 CommitLedger 记提交（没有写入生效这回事），也不另发确认事务可用的语句——work 吞掉了失败的语句时
   *   COMMIT 按回滚处理，读到的仍是同一个快照里的数据；
   * - 连接归还的规则与 run() 一致：业务错误（AppError，包括开场核对不通过）回滚后放回，其他失败丢弃；
   * - 快照里的语句逐条执行，不在同一个事务上并发（pg 在一个连接上排队执行的做法已经弃用）；
   * - 一个请求只开一个快照：内层的方法接受事务参数。快照里再开快照或写事务直接报错（另借连接，连接池满时与外层互相等待）
   */
  async readSnapshot<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.#refuseInsideSnapshot()
    const client = await this.pool.connect()
    const snapshot = { open: true }
    let discard = false
    try {
      return await createDatabase(client).transaction(async (tx) => {
        const transaction = tx as unknown as Transaction
        return this.#inSnapshot.run(snapshot, async () => {
          await this.#opening?.(transaction)
          return work(transaction)
        })
      }, READ_SNAPSHOT)
    }
    catch (error) {
      discard = !(error instanceof AppError)
      throw error
    }
    finally {
      snapshot.open = false
      // 与 run() 相同：只有空闲的连接放回池里
      client.release(discard || client.getTransactionStatus() !== 'I')
    }
  }

  #refuseInsideSnapshot(): void {
    if (this.#inSnapshot.getStore()?.open === true)
      throw new Error(NESTED_IN_SNAPSHOT_MESSAGE)
  }
}

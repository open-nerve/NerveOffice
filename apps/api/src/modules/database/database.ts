import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

/** Drizzle 实例（连接池上）。只有仓储与 database 模块使用（lint 限制）。 */
export type Database = NodePgDatabase

/** Drizzle 的事务执行器。 */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** 仓储用来执行语句的对象：数据库或事务。 */
export type DbExecutor = Database | DbTransaction

declare const TRANSACTION: unique symbol

/**
 * 服务开启的事务（TransactionRunner.run）：服务只能把它原样传给仓储，本身拿它查询不了数据库，
 * "只有仓储访问数据库"（规范 §1.2）因此在类型上成立（审查 B2）。
 */
export interface Transaction {
  readonly [TRANSACTION]: true
}

/** 仓储把服务传来的事务换回执行器；没有事务时用连接池。只有仓储能引用它（lint 限制）。 */
export function executorOf(db: Database, transaction?: Transaction): DbExecutor {
  return transaction === undefined ? db : transaction as unknown as DbTransaction
}

/** 注入标记：Drizzle 实例（`@Inject(DATABASE) db: Database`），只在仓储里注入。 */
export const DATABASE = Symbol('DATABASE')

/** 注入标记：pg 连接池，只在 database 模块内部使用。 */
export const PG_POOL = Symbol('PG_POOL')

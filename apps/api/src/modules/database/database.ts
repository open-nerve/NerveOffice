import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

/** Drizzle 实例（连接池上）。 */
export type Database = NodePgDatabase

/** 事务里的执行器。 */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * 仓储方法接受的执行器：数据库或事务。需要跨模块放进同一个事务的写入，
 * 由调用方开启事务并把事务传下去，显式传递，不靠隐式的上下文（P2 设计 §3.7）。
 */
export type DbExecutor = Database | DbTransaction

/** 注入标记：Drizzle 实例（`@Inject(DATABASE) db: Database`）。 */
export const DATABASE = Symbol('DATABASE')

/** 注入标记：pg 连接池，只在 database 模块内部使用。 */
export const PG_POOL = Symbol('PG_POOL')

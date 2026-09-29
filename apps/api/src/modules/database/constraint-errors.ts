import type { DbExecutor, DbTransaction, Transaction } from './database.ts'

/** PostgreSQL 的 SQLSTATE 23505：违反唯一约束。 */
const UNIQUE_VIOLATION = '23505'

/** 这个错误是不是违反了指定的唯一约束（drizzle 把驱动的错误包在 cause 里）。 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  return typeof cause === 'object' && cause !== null
    && 'code' in cause && cause.code === UNIQUE_VIOLATION
    && 'constraint' in cause && cause.constraint === constraint
}

/**
 * 在保存点里执行预期可能失败的语句（例如撞上唯一约束，由约束兜住并发）：失败时只回滚到保存点，事务仍可继续。
 * 事务里直接失败的语句会让整个事务中止，之后的语句都被拒绝（见 TransactionRunner）。只有仓储调用它。
 */
export async function inSavepoint<T>(transaction: Transaction, work: (executor: DbExecutor) => Promise<T>): Promise<T> {
  return (transaction as unknown as DbTransaction).transaction(async savepoint => work(savepoint))
}

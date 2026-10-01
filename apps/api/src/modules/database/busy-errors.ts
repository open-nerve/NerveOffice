/**
 * 数据库繁忙的三种情形（M2-P6 复核 A 的 G-2）：
 * - lock_timeout：等锁超过 lock_timeout（SQLSTATE 55P03）——别的事务正占着同一把锁，例如同一个空间里正在进行的结构改动；
 * - statement_timeout：语句被取消（SQLSTATE 57014）——超过 statement_timeout（等锁的时间也算在内），或者被管理员取消；
 * - pool_timeout：连接池满了，等空闲的连接超过 connectionTimeoutMillis。
 * 三种都发生在写入生效之前：出错的语句连同它所在的事务整体回滚（TransactionRunner），取连接超时则还没开始。
 * 所以客户端得到的是确定的"没有生效"，稍后重试即可——与"结果未知"的意外错误不同，不按 500 回答、不记成错误日志。
 * 死锁（40P01）不在其中：按锁的顺序取锁不会成环，出现了就是缺陷，照旧按意外错误处理
 */
export type DatabaseBusyReason = 'lock_timeout' | 'statement_timeout' | 'pool_timeout'

/** PostgreSQL 的 SQLSTATE：等锁超时（lock_not_available）与语句被取消（query_canceled） */
const BUSY_SQLSTATES: ReadonlyMap<string, DatabaseBusyReason> = new Map([
  ['55P03', 'lock_timeout'],
  ['57014', 'statement_timeout'],
])

/**
 * 连接池等空闲连接超时的错误说明：pg-pool 3.14（随 pg 8.23 锁定的版本）只给这一句，没有错误码。
 * 升级 pg 时如果改了说明，集成测试 api/database-busy.test.ts 的"取不到连接"那一条会失败
 */
export const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect'

/** 原因链最多看几层：drizzle 把驱动的错误包一层（DrizzleQueryError 的 cause），事务运行器再包一层也够 */
const MAX_CAUSE_DEPTH = 5

/** pg 的 DatabaseError：带五位的 SQLSTATE 与 severity（与 logging 的识别方式一致） */
function sqlStateOf(error: object): string | undefined {
  return 'code' in error && typeof error.code === 'string' && /^[\dA-Z]{5}$/.test(error.code) && 'severity' in error ? error.code : undefined
}

/**
 * 这个异常是不是数据库繁忙（沿着 cause 逐层看），是的话是哪一种。只认数据库与连接池自己报的错误，
 * 应用代码里自己抛的 AppError 等不在此列（由异常过滤器先按它们自己的错误码处理）
 */
export function databaseBusyReasonOf(error: unknown): DatabaseBusyReason | undefined {
  let current: unknown = error
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    const sqlState = sqlStateOf(current)
    if (sqlState !== undefined)
      return BUSY_SQLSTATES.get(sqlState)
    if (current instanceof Error && current.message === POOL_TIMEOUT_MESSAGE && !('code' in current))
      return 'pool_timeout'
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}

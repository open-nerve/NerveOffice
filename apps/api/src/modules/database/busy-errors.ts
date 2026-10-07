/**
 * 数据库繁忙的四种情形（M2-P6 复核 A 的 G-2；transaction_timeout 是 M3-P5 复验 C1 加的）：
 * - lock_timeout：等锁超过 lock_timeout（SQLSTATE 55P03）——别的事务正占着同一把锁，例如同一个空间里正在进行的结构改动；
 * - statement_timeout：语句被取消（SQLSTATE 57014）——超过 statement_timeout（等锁的时间也算在内），或者被管理员取消；
 * - transaction_timeout：限时的事务（TransactionRunner.run 的 limit，保存的事务）超过了时限——设下时限之后到点（SQLSTATE 25P04，
 *   PostgreSQL 17 起：数据库结束整个会话，严重级别 FATAL，事务随之回滚，连接已断开、由事务运行器丢弃），或者 BEGIN 之后迟迟没能设下时限
 *   （LateTransactionStartError：事务运行器自己判断，不开始、回滚；M3-P5 再复核 D1）；
 * - pool_timeout：连接池满了，等空闲的连接超过 connectionTimeoutMillis。
 * 四种都不让出错的那一步生效：出错的语句连同它所在的事务整体回滚（TransactionRunner；超过事务的时限时由数据库随会话一起回滚），
 * 取连接超时则还没开始。
 * 这个请求里还没有事务提交过时（CommitLedger），客户端得到的就是确定的"没有生效"，稍后重试即可——与"结果未知"的意外错误不同，
 * 不按 500 回答、不记成错误日志。同一个请求里先前已经有事务提交过时就不是这样了：写入已经生效，异常过滤器按意外错误回 500
 * （M2-P6 第 3 片复验）；写接口因此在业务事务里拼好响应，提交之后不再访问数据库。
 * 死锁（40P01）不在其中：按锁的顺序取锁不会成环，出现了就是缺陷，照旧按意外错误处理
 */
export type DatabaseBusyReason = 'lock_timeout' | 'statement_timeout' | 'transaction_timeout' | 'pool_timeout'

/** PostgreSQL 的 SQLSTATE：等锁超时（lock_not_available）、语句被取消（query_canceled）与超过事务的时限（transaction_timeout） */
const BUSY_SQLSTATES: ReadonlyMap<string, DatabaseBusyReason> = new Map([
  ['55P03', 'lock_timeout'],
  ['57014', 'statement_timeout'],
  ['25P04', 'transaction_timeout'],
])

/**
 * 连接池等空闲连接超时的错误说明：pg-pool 3.14（随 pg 8.23 锁定的版本）只给这一句，没有错误码。
 * 升级 pg 时如果改了说明，集成测试 api/database-busy.test.ts 的"取不到连接"那一条会失败
 */
export const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect'

/**
 * 限时的事务在 BEGIN 之后迟迟没能设下时限（M3-P5 再复核 D1）：事务运行器在设下时限的那一条语句里读出 BEGIN 之后过了多久，超过上限
 * （TransactionLimit 的 startWithinMs）就不开始——抛出它，事务回滚，什么也没写。这时应用在 BEGIN 与第一条语句之间停住了（事件循环卡死、
 * 进程或虚拟机被暂停），整个事务从 BEGIN 起的时限已经守不住，按超过事务的时限（数据库繁忙，503）回答，客户端稍后重试
 */
export class LateTransactionStartError extends Error {
  constructor(readonly elapsedMs: number, readonly startWithinMs: number) {
    super(`限时的事务在 BEGIN 之后 ${Math.round(elapsedMs)} 毫秒才设下时限，超过了上限 ${startWithinMs} 毫秒：不开始，回滚`)
    this.name = 'LateTransactionStartError'
  }
}

/** 原因链最多看几层：drizzle 把驱动的错误包一层（DrizzleQueryError 的 cause），事务运行器再包一层也够 */
const MAX_CAUSE_DEPTH = 5

/** pg 的 DatabaseError：带五位的 SQLSTATE 与 severity（与 logging 的识别方式一致） */
function sqlStateOf(error: object): string | undefined {
  return 'code' in error && typeof error.code === 'string' && /^[\dA-Z]{5}$/.test(error.code) && 'severity' in error ? error.code : undefined
}

/**
 * 这个异常是不是数据库繁忙（沿着 cause 逐层看），是的话是哪一种。只认数据库与连接池自己报的错误，以及事务运行器判断的"限时的事务开始得
 * 太晚"（LateTransactionStartError，与超过事务的时限是同一回事）；应用代码里别的错误（AppError 等）不在此列（由异常过滤器先按它们自己的
 * 错误码处理）
 */
export function databaseBusyReasonOf(error: unknown): DatabaseBusyReason | undefined {
  let current: unknown = error
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    const sqlState = sqlStateOf(current)
    if (sqlState !== undefined)
      return BUSY_SQLSTATES.get(sqlState)
    if (current instanceof LateTransactionStartError)
      return 'transaction_timeout'
    if (current instanceof Error && current.message === POOL_TIMEOUT_MESSAGE && !('code' in current))
      return 'pool_timeout'
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}

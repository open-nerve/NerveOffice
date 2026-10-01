// 日志里的异常（审查 A2）：数据库错误的消息与属性带着绑定参数和行里的值
// （drizzle 的 DrizzleQueryError 把参数拼进消息，pg 的消息与 detail 带值），按键名的脱敏覆盖不到。
// 所以数据库错误只留类型、带占位符的 SQL、SQLSTATE 与约束、表、列名；其他异常保留消息与堆栈，原因（cause）逐层同样处理。
// 绑定参数从不写进日志（只记个数）：它们是行里的值。
const MAX_CAUSE_DEPTH = 5

/**
 * 日志里的 SQL 最多留多少个字符（M2-P6 复核 A 的 G-7）：语句的开头（动词、表与条件的开头）足以定位是哪一处。
 * 应用里最长的语句约 1400 个字符（整套集成测试实测），留出余量；只截断异常长的——一串 id 曾被展开成几万个参数，
 * 一条错误日志带着 51 万个字符的 SQL（M2-P6 复核 A 的 S-2，已改成数组参数，这里兜底）
 */
export const LOGGED_QUERY_MAX_LENGTH = 4_096

/** 超过上限的 SQL 只留开头，并注明截断了、原来有多长 */
export function truncatedQuery(query: string): string {
  return query.length <= LOGGED_QUERY_MAX_LENGTH ? query : `${query.slice(0, LOGGED_QUERY_MAX_LENGTH)}…（已截断，共 ${query.length} 个字符）`
}

type Fields = Record<string, unknown>

interface DrizzleQueryError extends Error {
  query: string
  params: unknown[]
}

interface PgDatabaseError extends Error {
  code: string
  severity?: string
  schema?: string
  table?: string
  column?: string
  dataType?: string
  constraint?: string
  routine?: string
}

function isDrizzleQueryError(error: Error): error is DrizzleQueryError {
  return 'query' in error && typeof error.query === 'string' && 'params' in error && Array.isArray(error.params)
}

function isPgDatabaseError(error: Error): error is PgDatabaseError {
  return 'code' in error && typeof error.code === 'string' && /^[\dA-Z]{5}$/.test(error.code) && 'severity' in error
}

/** 只留堆栈里的调用位置：堆栈开头是消息，而消息可能有好几行（drizzle 的消息第二行就是参数）。 */
export function framesOnly(stack: string | undefined): string | undefined {
  return stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n')
}

/** 可以写进日志的异常消息：数据库错误的消息带着值，换成不带值的说明；其他异常原样。 */
export function safeErrorMessage(error: Error): string {
  if (isDrizzleQueryError(error))
    return '数据库查询失败'
  if (isPgDatabaseError(error))
    return `数据库报错（SQLSTATE ${error.code}）`
  return error.message
}

function defined(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error))
    return error
  const cause = depth < MAX_CAUSE_DEPTH && error.cause !== undefined ? serializeError(error.cause, depth + 1) : undefined
  if (isDrizzleQueryError(error))
    return defined({ type: 'DrizzleQueryError', message: safeErrorMessage(error), query: truncatedQuery(error.query), paramCount: error.params.length, stack: framesOnly(error.stack), cause })
  if (isPgDatabaseError(error)) {
    return defined({
      type: 'DatabaseError',
      message: safeErrorMessage(error),
      sqlState: error.code,
      severity: error.severity,
      schema: error.schema,
      table: error.table,
      column: error.column,
      dataType: error.dataType,
      constraint: error.constraint,
      routine: error.routine,
      stack: framesOnly(error.stack),
      cause,
    })
  }
  // 其他异常：带上自己的可枚举属性（例如 code），敏感的键名由根日志统一脱敏
  const own: Fields = { ...(error as unknown as Fields) }
  delete own.cause
  return defined({ ...own, type: error.name, message: error.message, stack: error.stack, cause })
}

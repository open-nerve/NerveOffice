// 日志里的异常（审查 A2）：数据库错误的消息与属性带着绑定参数和行里的值
// （drizzle 的 DrizzleQueryError 把参数拼进消息，pg 的消息与 detail 带值），按键名的脱敏覆盖不到。
// 所以数据库错误只留类型、带占位符的 SQL、SQLSTATE 与约束、表、列名；其他异常保留消息与堆栈，原因（cause）逐层同样处理。
const MAX_CAUSE_DEPTH = 5

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
function framesOnly(stack: string | undefined): string | undefined {
  return stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n')
}

function defined(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error))
    return error
  const cause = depth < MAX_CAUSE_DEPTH && error.cause !== undefined ? serializeError(error.cause, depth + 1) : undefined
  if (isDrizzleQueryError(error))
    return defined({ type: 'DrizzleQueryError', message: '数据库查询失败', query: error.query, stack: framesOnly(error.stack), cause })
  if (isPgDatabaseError(error)) {
    return defined({
      type: 'DatabaseError',
      message: `数据库报错（SQLSTATE ${error.code}）`,
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

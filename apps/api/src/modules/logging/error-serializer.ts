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

/** 从调用者已选定的堆栈文本中只留调用位置；数据库错误须先剥离完整消息，不能凭 at 前缀判断敏感参数。 */
export function framesOnly(stack: string | undefined): string | undefined {
  return stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n')
}

/** 数据库消息可能包含换行伪帧。无法确认完整 header 时省略 stack，保留其他结构化数据库诊断。 */
function databaseFrames(error: Error): string | undefined {
  try {
    const { name, message, stack } = error
    if (typeof name !== 'string' || typeof message !== 'string' || typeof stack !== 'string')
      return undefined
    // Error 标准文本的两个空值分支也要一致，不能把空消息拼成多余的冒号。
    const header = name === '' ? message : message === '' ? name : `${name}: ${message}`
    const prefix = `${header}\n`
    if (!stack.startsWith(prefix))
      return undefined
    const frames = framesOnly(stack.slice(prefix.length))
    return frames === '' ? undefined : frames
  }
  catch {
    // 自定义 stack getter 不是查询失败的替代原因；不尝试回退扫描原串。
    return undefined
  }
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
    return defined({ type: 'DrizzleQueryError', message: safeErrorMessage(error), query: truncatedQuery(error.query), paramCount: error.params.length, stack: databaseFrames(error), cause })
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
      stack: databaseFrames(error),
      cause,
    })
  }
  // 其他异常：带上自己的可枚举属性（例如 code），敏感的键名由根日志统一脱敏
  const own: Fields = { ...(error as unknown as Fields) }
  delete own.cause
  return defined({ ...own, type: error.name, message: error.message, stack: error.stack, cause })
}

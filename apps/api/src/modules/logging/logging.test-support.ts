// 测试用：把 pino 的输出收进内存，按行解析成对象；带值的数据库错误样例。
import type { DestinationStream } from 'pino'

export interface LogCapture {
  destination: DestinationStream
  entries: () => Record<string, unknown>[]
}

export function captureLogs(): LogCapture {
  const lines: string[] = []
  return {
    destination: { write: (line: string) => void lines.push(line) },
    entries: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
  }
}

/** 样例里的"值"：任何日志里都不应出现。 */
export const SECRET_VALUE = 'SECRET-VALUE'

/** 模拟 pg 的 DatabaseError：消息与 detail 带着行里的值。 */
export function pgError(): Error {
  return Object.assign(new Error(`invalid input syntax for type uuid: "${SECRET_VALUE}"`), {
    code: '22P02',
    severity: 'ERROR',
    detail: `Failing row contains (${SECRET_VALUE})`,
    table: 'audit_events',
    constraint: undefined,
    routine: 'string_to_uuid',
  })
}

/** 模拟 drizzle 的 DrizzleQueryError：消息与 params 带着绑定参数，原因是 pg 的错误。 */
export function drizzleError(): Error {
  return Object.assign(new Error(`Failed query: select $1::uuid\nparams: ${SECRET_VALUE}`, { cause: pgError() }), {
    query: 'select $1::uuid',
    params: [SECRET_VALUE],
  })
}

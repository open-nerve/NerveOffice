// 测试用：把 pino 的输出收进内存，按行解析成对象；带值的数据库错误样例。
import type { DestinationStream } from 'pino'

export interface LogCapture {
  destination: DestinationStream
  entries: () => Record<string, unknown>[]
  /** 原始的行：检查重复的键等解析之后看不到的情况 */
  lines: () => string[]
}

export function captureLogs(): LogCapture {
  const lines: string[] = []
  return {
    destination: { write: (line: string) => void lines.push(line) },
    entries: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
    lines: () => [...lines],
  }
}

/** 样例里的"值"：任何日志里都不应出现。 */
export const SECRET_VALUE = 'SECRET-VALUE'
export const FRAME_SECRET_VALUE = 'DATABASE-FRAME-SECRET-5e26'

/** 沿用本文件的驱动/ORM 错误形态；控制值中的换行伪装成调用帧，仍然只是绑定参数。 */
export function multilineDatabaseError(): Error {
  const parameter = `${SECRET_VALUE}\n    at ${FRAME_SECRET_VALUE}\n结束`
  const cause = Object.assign(new Error(`invalid input syntax for type uuid: "${parameter}"`), {
    name: 'error',
    code: '22P02',
    severity: 'ERROR',
    detail: `Failing row contains (${parameter})`,
    table: 'audit_events',
    routine: 'string_to_uuid',
  })
  return Object.assign(new Error(`Failed query: select $1::uuid\nparams: ${parameter}`, { cause }), {
    query: 'select $1::uuid',
    params: [parameter],
  })
}

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

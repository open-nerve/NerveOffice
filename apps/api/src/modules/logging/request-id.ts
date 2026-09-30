import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'

/**
 * 请求标识（规范 §7；M2-P6 复核 C2）：每个请求都用服务端自己生成的 UUID，写进响应头、日志、错误响应与审计。
 * 客户端带来的 X-Request-Id 不当作请求标识：审计的 request_id 会摊给管理员看，任何人都能让自己的审计行
 * 与别人的请求标识重合，干扰追溯。它只在日志里另记一个字段 clientRequestId（见 clientRequestIdOf），用来对上客户端那边的记录。
 */
export function generateRequestId(): string {
  return randomUUID()
}

/** 采信的客户端请求标识：1–128 个字母、数字或 `_.:-`。其他取值（可能被用来伪造日志）不记。 */
const VALID_CLIENT_REQUEST_ID = /^[\w.:-]{1,128}$/

/** 客户端带来的 X-Request-Id：合法时原样给出（只进日志），没有、不合法或出现多个同名请求头时为 undefined */
export function clientRequestIdOf(incoming: string | readonly string[] | undefined): string | undefined {
  return typeof incoming === 'string' && VALID_CLIENT_REQUEST_ID.test(incoming) ? incoming : undefined
}

/** 请求日志中间件生成的请求标识（它排在管线的最前面，每个请求都有）。 */
export function requestIdOf(request: IncomingMessage): string {
  const id = request.id
  if (typeof id !== 'string')
    throw new TypeError('请求没有请求标识：请求日志中间件必须排在管线的最前面')
  return id
}

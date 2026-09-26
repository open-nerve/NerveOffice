import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'

/** 接受的请求标识：1–128 个字母、数字或 `_.:-`。其他取值（可能被用来伪造日志）一律换成新生成的 UUID。 */
const VALID_REQUEST_ID = /^[\w.:-]{1,128}$/

export function resolveRequestId(incoming: string | readonly string[] | undefined, generate: () => string = randomUUID): string {
  return typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : generate()
}

/** 请求日志中间件生成的请求标识（它排在管线的最前面，每个请求都有）。 */
export function requestIdOf(request: IncomingMessage): string {
  const id = request.id
  if (typeof id !== 'string')
    throw new TypeError('请求没有请求标识：请求日志中间件必须排在管线的最前面')
  return id
}

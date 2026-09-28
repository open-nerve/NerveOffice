// 一次性链接（M2-P1 设计 §3.4）的测试辅助：公开接口的请求（带与公开地址相同的 Origin），从链接里取令牌，按令牌算库里的摘要。
import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { errorResponseSchema, linkInvalidDetailsSchema } from '@nerve-office/contracts'
import { TEST_PUBLIC_ORIGIN } from './api-app.ts'
import { parseExact } from './contracts.ts'

/** 链接的 # 之后是令牌 */
export function tokenOf(url: string): string {
  const token = new URL(url).hash.slice(1)
  if (token === '')
    throw new Error(`链接里没有令牌：${url}`)
  return token
}

/** 库里存的是令牌的 SHA-256 摘要 */
export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export async function postPublic(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': TEST_PUBLIC_ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

/** LINK_INVALID 的原因；不是这个错误码时报错 */
export async function linkInvalidReasonOf(response: Response): Promise<string> {
  const { error } = parseExact(errorResponseSchema, await response.json())
  if (error.code !== 'LINK_INVALID')
    throw new Error(`期望 LINK_INVALID，得到 ${error.code}（HTTP ${response.status}）`)
  return linkInvalidDetailsSchema.parse(error.details).reason
}

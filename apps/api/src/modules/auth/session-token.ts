// 会话令牌与 CSRF 令牌（P3 设计 §3.5）。
import { Buffer } from 'node:buffer'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 字节随机数的 base64url 编码：43 个字符。 */
const SESSION_TOKEN_PATTERN = /^[\w-]{43}$/
const CSRF_CONTEXT = 'nerve-office:csrf:v1'

/** 新的会话令牌：只放进 Cookie，数据库存它的摘要。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 格式不对的令牌不必查库。 */
export function isWellFormedSessionToken(value: string): boolean {
  return SESSION_TOKEN_PATTERN.test(value)
}

/** 数据库里存的是令牌的 SHA-256 摘要：库被读到也拿不到能用的令牌。 */
export function sessionTokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * CSRF 令牌由会话令牌派生，不另外存储：
 * 攻击者的页面读不到 HttpOnly 的会话 Cookie，也读不到会话接口的响应（同源策略，不开 CORS），所以算不出它。
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_CONTEXT).digest('base64url')
}

/** 常数时间比较，不从比较耗时泄漏令牌的前缀。 */
export function csrfTokenMatches(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined)
    return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(candidate, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

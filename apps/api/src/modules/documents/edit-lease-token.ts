// 编辑租约的令牌（M3-P1 设计 §3.2、§3.5）：与会话令牌同样的强度与存法——32 字节安全随机数（base64url，43 个字符），
// 只在申请的响应里出现一次；库里只存 SHA-256 摘要（document_edit_leases.token_digest），比较用恒定时间。
// 请求头里的令牌先按 contracts 的 editLeaseTokenSchema 校验格式（参数装饰器，格式不对是 400），这里不再管格式。
import type { Buffer } from 'node:buffer'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 新的令牌：放进申请的响应，页面只放在内存里，经请求头带回来 */
export function generateEditLeaseToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 库里存的是令牌的 SHA-256 摘要（32 字节）：库被读到也拿不到能用的令牌 */
export function editLeaseTokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * 请求带来的令牌是不是这个摘要的那一个：先算摘要，再做恒定时间比较，不从比较的耗时泄漏摘要的前缀。
 * 长度不同直接为假（timingSafeEqual 遇到长度不同的输入会抛错）：表上的 CHECK 保证摘要是 32 字节，长度不同只会出自损坏的数据
 */
export function editLeaseTokenMatches(token: string, digest: Buffer): boolean {
  const candidate = editLeaseTokenDigest(token)
  return candidate.length === digest.length && timingSafeEqual(candidate, digest)
}

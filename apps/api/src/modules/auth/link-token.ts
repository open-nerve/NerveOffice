// 一次性链接的令牌（M2-P1 设计 §3.4）：与会话令牌同样的强度与存法：32 字节安全随机数（base64url，43 个字符），
// 库里只存 SHA-256 摘要。链接只在签发时给出一次。
import type { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { isWellFormedLinkToken } from '@nerve-office/contracts'

export function generateLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 格式合法的令牌才算摘要去查库；格式不对（例如复制时少了几个字符）与找不到一样回答"链接无效" */
export function linkTokenDigest(token: string): Buffer | undefined {
  return isWellFormedLinkToken(token) ? createHash('sha256').update(token, 'utf8').digest() : undefined
}

// 管理界面账户列表的游标（M2-P1 设计 §3.6）：上一页最后一条的登录名（登录名唯一），keyset 分页。对客户端不透明。
import { Buffer } from 'node:buffer'
import { USERNAME_PATTERN_SOURCE } from '@nerve-office/contracts'
import { z } from 'zod'

const cursorSchema = z.strictObject({ u: z.string().regex(new RegExp(USERNAME_PATTERN_SOURCE)) })

export function encodeAccountCursor(username: string): string {
  return Buffer.from(JSON.stringify({ u: username }), 'utf8').toString('base64url')
}

/** 不是我们发的游标（改过、截断、拼错）返回 undefined。 */
export function decodeAccountCursor(value: string): string | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  }
  catch {
    return undefined
  }
  const cursor = cursorSchema.safeParse(decoded)
  return cursor.success ? cursor.data.u : undefined
}

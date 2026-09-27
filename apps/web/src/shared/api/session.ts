// 当前会话的请求：平台页面与编辑器页共用。
import type { SessionResponse } from '@nerve-office/contracts'
import { sessionResponseSchema } from '@nerve-office/contracts'
import { apiRequest } from './client.ts'

/** 向服务端要现在的会话，不改动请求层的 CSRF 令牌：调用方确认是同一个人之后才用它的令牌（复验 S2）。 */
export async function requestSession(signal?: AbortSignal): Promise<SessionResponse> {
  return apiRequest('/api/auth/session', { schema: sessionResponseSchema, signal })
}

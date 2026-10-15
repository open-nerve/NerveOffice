import type { SessionResponse } from '@nerve-office/contracts'
import { z } from 'zod'
import { apiRequest } from '../api/client.ts'

/** 固定确认时的 CSRF，401 由退出协调器记录原会话已结束；绝不采纳新登录重发。 */
export async function requestLogout(session: SessionResponse): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST', schema: z.undefined(), session })
}

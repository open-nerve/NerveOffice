// 本人的账户（M2-P1 设计 §3.8）：修改密码。
import type { ChangePasswordRequest, ChangePasswordResponse } from '@nerve-office/contracts'
import { changePasswordResponseSchema } from '@nerve-office/contracts'
import { apiRequest, setCsrfToken } from '../../shared/api/index.ts'

/**
 * 修改密码：成功时服务端撤销本人的全部会话（包括当前这个），为当前页面新建一个并写回 Cookie（M2-P6 复核 B1）。
 * 响应与登录相同：旧的 CSRF 令牌随旧会话一起失效，换上新的，页面照常可用。
 */
export async function changePassword(request: ChangePasswordRequest): Promise<ChangePasswordResponse> {
  const session = await apiRequest('/api/auth/password', { method: 'PUT', body: request, schema: changePasswordResponseSchema })
  setCsrfToken(session.csrfToken)
  return session
}

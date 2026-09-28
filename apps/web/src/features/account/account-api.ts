// 本人的账户（M2-P1 设计 §3.8）：修改密码。
import type { ChangePasswordRequest } from '@nerve-office/contracts'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'

export async function changePassword(request: ChangePasswordRequest): Promise<void> {
  await apiRequest('/api/auth/password', { method: 'PUT', body: request, schema: z.undefined() })
}

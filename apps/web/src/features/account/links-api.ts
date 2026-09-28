// 一次性链接（M2-P1 设计 §3.4、§3.8）：邀请注册与重置密码的公开接口。令牌放在请求体里。
// 接受邀请、完成重置之后已登录：与登录一样把 CSRF 令牌交给请求层。
import type { AcceptInvitationRequest, CompletePasswordResetRequest, InspectLinkResponse, OneTimeLinkPurpose, SessionResponse } from '@nerve-office/contracts'
import { inspectLinkResponseSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { apiRequest, setCsrfToken } from '../../shared/api/index.ts'

const INSPECT_PATHS: Readonly<Record<OneTimeLinkPurpose, string>> = {
  invitation: '/api/auth/invitations/inspect',
  password_reset: '/api/auth/password-resets/inspect',
}

export async function inspectLink(purpose: OneTimeLinkPurpose, token: string, signal?: AbortSignal): Promise<InspectLinkResponse> {
  return apiRequest(INSPECT_PATHS[purpose], { method: 'POST', body: { token }, schema: inspectLinkResponseSchema, signal })
}

export async function acceptInvitation(request: AcceptInvitationRequest): Promise<SessionResponse> {
  const session = await apiRequest('/api/auth/invitations/accept', { method: 'POST', body: request, schema: sessionResponseSchema })
  setCsrfToken(session.csrfToken)
  return session
}

export async function completePasswordReset(request: CompletePasswordResetRequest): Promise<SessionResponse> {
  const session = await apiRequest('/api/auth/password-resets/complete', { method: 'POST', body: request, schema: sessionResponseSchema })
  setCsrfToken(session.csrfToken)
  return session
}

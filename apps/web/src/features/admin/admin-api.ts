// 管理界面的接口（M2-P1 设计 §3.3）：账户、邀请、审计。只给系统管理员，服务端逐请求检查；
// 查询与变更都标明 SYSTEM_ADMIN_ONLY：被拒绝时由请求缓存的全局处理重新确认会话（审查 B4）。
import type {
  AdminUser,
  AdminUserListQuery,
  AdminUserListResponse,
  AuditEventListResponse,
  AuditEventQuery,
  CreateInvitationRequest,
  Invitation,
  InvitationListQuery,
  InvitationListResponse,
  IssuedInvitation,
  IssuedPasswordReset,
  UserSystemRole,
} from '@nerve-office/contracts'
import {
  adminUserListResponseSchema,
  adminUserSchema,
  auditEventListResponseSchema,
  invitationListResponseSchema,
  invitationSchema,
  issuedInvitationSchema,
  issuedPasswordResetSchema,
} from '@nerve-office/contracts'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'

/** 查询参数：去掉没填的，其余按字符串编码 */
function search(params: Readonly<Record<string, string | undefined>>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries).toString()}`
}

export const ADMIN_QUERY_KEY = ['admin'] as const

/** 审计页找操作者时给出的候选数 */
const ACTOR_CANDIDATE_LIMIT = 5

export async function fetchAdminUsers(query: AdminUserListQuery, signal?: AbortSignal): Promise<AdminUserListResponse> {
  return apiRequest(`/api/admin/users${search({ query: query.query, status: query.status, cursor: query.cursor })}`, { schema: adminUserListResponseSchema, signal })
}

export function adminUsersQueryOptions(filter: Omit<AdminUserListQuery, 'cursor'>) {
  return infiniteQueryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'users', filter],
    queryFn: async ({ pageParam, signal }) => fetchAdminUsers({ ...filter, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    meta: SYSTEM_ADMIN_ONLY,
  })
}

/** 审计页找操作者：按名字或登录名搜索账户（含停用的），只取前几条 */
export function actorCandidatesQueryOptions(keyword: string) {
  return queryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'actor-candidates', keyword],
    queryFn: async ({ signal }) => fetchAdminUsers({ query: keyword }, signal),
    select: page => page.items.slice(0, ACTOR_CANDIDATE_LIMIT),
    meta: SYSTEM_ADMIN_ONLY,
  })
}

export async function disableUser(id: string): Promise<AdminUser> {
  return apiRequest(`/api/admin/users/${id}/disable`, { method: 'POST', schema: adminUserSchema })
}

export async function enableUser(id: string): Promise<AdminUser> {
  return apiRequest(`/api/admin/users/${id}/enable`, { method: 'POST', schema: adminUserSchema })
}

export async function changeSystemRole(id: string, systemRole: UserSystemRole): Promise<AdminUser> {
  return apiRequest(`/api/admin/users/${id}/system-role`, { method: 'PUT', body: { systemRole }, schema: adminUserSchema })
}

export async function issuePasswordReset(id: string): Promise<IssuedPasswordReset> {
  return apiRequest(`/api/admin/users/${id}/password-reset`, { method: 'POST', schema: issuedPasswordResetSchema })
}

export function invitationsQueryOptions(filter: Omit<InvitationListQuery, 'cursor'>) {
  return infiniteQueryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'invitations', filter],
    queryFn: async ({ pageParam, signal }): Promise<InvitationListResponse> => apiRequest(
      `/api/admin/invitations${search({ status: filter.status, cursor: pageParam ?? undefined })}`,
      { schema: invitationListResponseSchema, signal },
    ),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    meta: SYSTEM_ADMIN_ONLY,
  })
}

export async function createInvitation(request: CreateInvitationRequest): Promise<IssuedInvitation> {
  return apiRequest('/api/admin/invitations', { method: 'POST', body: request, schema: issuedInvitationSchema })
}

export async function revokeInvitation(id: string): Promise<Invitation> {
  return apiRequest(`/api/admin/invitations/${id}/revoke`, { method: 'POST', schema: invitationSchema })
}

export async function reissueInvitation(id: string): Promise<IssuedInvitation> {
  return apiRequest(`/api/admin/invitations/${id}/reissue`, { method: 'POST', schema: issuedInvitationSchema })
}

export function auditEventsQueryOptions(filter: Omit<AuditEventQuery, 'cursor'>) {
  return infiniteQueryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'audit', filter],
    queryFn: async ({ pageParam, signal }): Promise<AuditEventListResponse> => apiRequest(
      `/api/admin/audit-events${search({ ...filter, cursor: pageParam ?? undefined })}`,
      { schema: auditEventListResponseSchema, signal },
    ),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    meta: SYSTEM_ADMIN_ONLY,
  })
}

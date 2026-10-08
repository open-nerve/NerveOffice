// 管理界面的接口（M2-P1 设计 §3.3，M2-P2 设计 §3.3）：账户、邀请、团队空间、停用者文档的转移、审计。只给系统管理员，服务端逐请求检查；
// 查询与变更都标明 SYSTEM_ADMIN_ONLY：被拒绝时由请求缓存的全局处理重新确认会话（审查 B4）。
// 团队空间的改名与加入空间用空间的接口（那里的授权规则包含系统管理员），经 features/spaces 的公开入口引用，不另写一份（M2-P2 审查 B13）。
import type {
  AdminSpace,
  AdminSpaceListQuery,
  AdminSpaceListResponse,
  AdminUser,
  AdminUserDocumentListResponse,
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
  TransferDocumentsRequest,
  TransferDocumentsResponse,
  UserSystemRole,
} from '@nerve-office/contracts'
import {
  adminSpaceListResponseSchema,
  adminSpaceSchema,
  adminUserDocumentListResponseSchema,
  adminUserListResponseSchema,
  adminUserSchema,
  auditEventListResponseSchema,
  invitationListResponseSchema,
  invitationSchema,
  issuedInvitationSchema,
  issuedPasswordResetSchema,
  transferDocumentsResponseSchema,
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

/** 解除登录锁定（M2-P6 复核 A1）：清掉这个账户在所有来源上的登录失败计数 */
export async function unlockLogin(id: string): Promise<AdminUser> {
  return apiRequest(`/api/admin/users/${id}/unlock-login`, { method: 'POST', schema: adminUserSchema })
}

export async function issuePasswordReset(id: string): Promise<IssuedPasswordReset> {
  return apiRequest(`/api/admin/users/${id}/password-reset`, { method: 'POST', schema: issuedPasswordResetSchema })
}

/**
 * 吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）：服务端擦掉当前的、换上下一版，响应是这个账户（localKey 是新的那一版；
 * 这个人从没取过密钥时原样返回，localKey 为 null）。原始的密钥不经过管理员
 */
export async function revokeLocalKey(id: string): Promise<AdminUser> {
  return apiRequest(`/api/admin/users/${id}/local-key/revoke`, { method: 'POST', schema: adminUserSchema })
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

/** 一个账户（含停用的）：转移页的页头 */
export function adminUserQueryOptions(id: string) {
  return queryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'user', id],
    queryFn: async ({ signal }): Promise<AdminUser> => apiRequest(`/api/admin/users/${id}`, { schema: adminUserSchema, signal }),
    meta: SYSTEM_ADMIN_ONLY,
  })
}

export function adminSpacesQueryOptions(filter: Omit<AdminSpaceListQuery, 'cursor'>) {
  return infiniteQueryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'spaces', filter],
    queryFn: async ({ pageParam, signal }): Promise<AdminSpaceListResponse> => apiRequest(
      `/api/admin/spaces${search({ query: filter.query, status: filter.status, cursor: pageParam ?? undefined })}`,
      { schema: adminSpaceListResponseSchema, signal },
    ),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    meta: SYSTEM_ADMIN_ONLY,
  })
}

/** 转移的目标：按名称找没有归档的团队空间，只取第一页 */
export function transferTargetsQueryOptions(keyword: string) {
  return queryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'transfer-targets', keyword],
    queryFn: async ({ signal }): Promise<AdminSpaceListResponse> => apiRequest(`/api/admin/spaces${search({ query: keyword, status: 'active' })}`, { schema: adminSpaceListResponseSchema, signal }),
    select: page => page.items,
    meta: SYSTEM_ADMIN_ONLY,
  })
}

export async function createTeamSpace(request: { readonly name: string, readonly adminUserId: string, readonly visibleToAll: boolean }): Promise<AdminSpace> {
  return apiRequest('/api/admin/spaces', { method: 'POST', body: request, schema: adminSpaceSchema })
}

export async function setSpaceVisibility(id: string, visibleToAll: boolean): Promise<AdminSpace> {
  return apiRequest(`/api/admin/spaces/${id}/visibility`, { method: 'PUT', body: { visibleToAll }, schema: adminSpaceSchema })
}

export async function archiveSpace(id: string): Promise<AdminSpace> {
  return apiRequest(`/api/admin/spaces/${id}/archive`, { method: 'POST', schema: adminSpaceSchema })
}

export async function restoreSpace(id: string): Promise<AdminSpace> {
  return apiRequest(`/api/admin/spaces/${id}/restore`, { method: 'POST', schema: adminSpaceSchema })
}

/** 停用者个人空间里的文档：只有标题 */
export function userDocumentsQueryOptions(userId: string) {
  return infiniteQueryOptions({
    queryKey: [...ADMIN_QUERY_KEY, 'user-documents', userId],
    queryFn: async ({ pageParam, signal }): Promise<AdminUserDocumentListResponse> => apiRequest(
      `/api/admin/users/${userId}/documents${search({ cursor: pageParam ?? undefined })}`,
      { schema: adminUserDocumentListResponseSchema, signal },
    ),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    meta: SYSTEM_ADMIN_ONLY,
  })
}

export async function transferDocuments(userId: string, request: TransferDocumentsRequest): Promise<TransferDocumentsResponse> {
  return apiRequest(`/api/admin/users/${userId}/documents/transfer`, { method: 'POST', body: request, schema: transferDocumentsResponseSchema })
}

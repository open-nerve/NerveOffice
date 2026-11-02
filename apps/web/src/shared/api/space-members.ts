// 成员页与系统管理页共享这份接口，两者按需加载；不经平台首屏的 spaces/index.ts 转出。
import type { AddSpaceMemberRequest, SpaceMember, SpaceMemberListResponse, SpaceRole } from '@nerve-office/contracts'
import { spaceMemberListResponseSchema, spaceMemberSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from './client.ts'
import { spaceMembersQueryKey } from './space-query-keys.ts'

/** 成员列表保留原空间查询前缀，改名与成员变化仍一起刷新。 */
export function membersQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: spaceMembersQueryKey(spaceId),
    queryFn: async ({ signal }): Promise<SpaceMemberListResponse> => apiRequest(`/api/spaces/${spaceId}/members`, { schema: spaceMemberListResponseSchema, signal }),
  })
}

/** 添加成员；系统管理员把自己加入团队空间也用它（审计记为系统管理员加入空间） */
export async function addMember(spaceId: string, request: AddSpaceMemberRequest): Promise<SpaceMember> {
  return apiRequest(`/api/spaces/${spaceId}/members`, { method: 'POST', body: request, schema: spaceMemberSchema })
}

export async function changeMemberRole(spaceId: string, userId: string, role: SpaceRole): Promise<SpaceMember> {
  return apiRequest(`/api/spaces/${spaceId}/members/${userId}`, { method: 'PUT', body: { role }, schema: spaceMemberSchema })
}

export async function removeMember(spaceId: string, userId: string): Promise<void> {
  await apiRequest(`/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE', schema: z.undefined() })
}

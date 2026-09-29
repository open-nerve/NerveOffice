// 团队空间的成员（M2-P2 设计 §3.3，US-M2-06）：查看、添加、调整角色、移出。
import type { AddSpaceMemberRequest, SpaceMember, SpaceMemberListResponse, SpaceRole } from '@nerve-office/contracts'
import { spaceMemberListResponseSchema, spaceMemberSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'
import { SPACES_QUERY_KEY } from '../spaces/index.ts'

/** 放在空间的查询下面：改名、成员的变化之后一起刷新（导航、空间页头与成员页） */
export function membersQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: [...SPACES_QUERY_KEY, 'members', spaceId],
    queryFn: async ({ signal }): Promise<SpaceMemberListResponse> => apiRequest(`/api/spaces/${spaceId}/members`, { schema: spaceMemberListResponseSchema, signal }),
  })
}

export async function addMember(spaceId: string, request: AddSpaceMemberRequest): Promise<SpaceMember> {
  return apiRequest(`/api/spaces/${spaceId}/members`, { method: 'POST', body: request, schema: spaceMemberSchema })
}

export async function changeMemberRole(spaceId: string, userId: string, role: SpaceRole): Promise<SpaceMember> {
  return apiRequest(`/api/spaces/${spaceId}/members/${userId}`, { method: 'PUT', body: { role }, schema: spaceMemberSchema })
}

export async function removeMember(spaceId: string, userId: string): Promise<void> {
  await apiRequest(`/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE', schema: z.undefined() })
}

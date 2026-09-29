// 空间的接口（M2-P2 设计 §3.3）：我能看到的空间（导航）、空间页头、改名；团队空间的成员（查看、添加、调整角色、移出，US-M2-06）。
// 成员的接口也放在这里（审查 B13）：成员页与管理界面（系统管理员把自己加入空间）用的是同一个接口，都经这里的公开入口引用。
// 这几个函数随这个模块进首屏（按需加载的页面用到的函数不会被摇掉，gzip 之后几百字节），比成员页与管理界面各写一份划算。
import type { AddSpaceMemberRequest, SpaceListResponse, SpaceMember, SpaceMemberListResponse, SpaceRole, SpaceView, TeamSpace } from '@nerve-office/contracts'
import { spaceListResponseSchema, spaceMemberListResponseSchema, spaceMemberSchema, spaceViewSchema, teamSpaceSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'

export const SPACES_QUERY_KEY = ['spaces'] as const

/** 左侧导航：个人空间、我是成员的团队空间、全员可见的团队空间 */
export function spacesQueryOptions() {
  return queryOptions({
    queryKey: [...SPACES_QUERY_KEY, 'list'],
    queryFn: async ({ signal }): Promise<SpaceListResponse> => apiRequest('/api/spaces', { schema: spaceListResponseSchema, signal }),
  })
}

/** 空间页头：看不到与不存在都是 404 */
export function spaceQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: [...SPACES_QUERY_KEY, 'space', spaceId],
    queryFn: async ({ signal }): Promise<SpaceView> => apiRequest(`/api/spaces/${spaceId}`, { schema: spaceViewSchema, signal }),
  })
}

export async function renameSpace(spaceId: string, name: string): Promise<TeamSpace> {
  return apiRequest(`/api/spaces/${spaceId}/name`, { method: 'PUT', body: { name }, schema: teamSpaceSchema })
}

/** 成员列表。放在空间的查询下面：改名、成员的变化之后一起刷新（导航、空间页头与成员页） */
export function membersQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: [...SPACES_QUERY_KEY, 'members', spaceId],
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

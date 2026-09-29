// 空间的接口（M2-P2 设计 §3.3）：我能看到的空间（导航）、空间页头、改名。
import type { SpaceListResponse, SpaceView, TeamSpace } from '@nerve-office/contracts'
import { spaceListResponseSchema, spaceViewSchema, teamSpaceSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
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

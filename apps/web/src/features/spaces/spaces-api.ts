// 空间首屏接口（M2-P2 设计 §3.3）：导航、空间页头及改名。
// 成员查询和修改由按需成员页/管理页直接消费 shared/api/space-members.ts。
import type { SpaceListResponse, SpaceView, TeamSpace } from '@nerve-office/contracts'
import { spaceListResponseSchema, spaceViewSchema, teamSpaceSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'
import { SPACES_QUERY_KEY } from '../../shared/api/space-query-keys.ts'

export { SPACES_QUERY_KEY } from '../../shared/api/space-query-keys.ts'

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

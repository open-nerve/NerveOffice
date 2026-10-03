// "与我共享"（GET /api/shared，M2-P5 设计 §3.2）：我有单独授权的全部文档，按更新时间从新到旧，keyset 分页（每页条数固定）。
import type { SharedListResponse } from '@nerve-office/contracts'
import { sharedListResponseSchema } from '@nerve-office/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'
import { SHARED_LIST_QUERY_KEY } from '../../shared/api/shared-list-key.ts'

export function sharedListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: SHARED_LIST_QUERY_KEY,
    queryFn: async ({ pageParam, signal }): Promise<SharedListResponse> => {
      const suffix = pageParam === null ? '' : `?${new URLSearchParams({ cursor: pageParam }).toString()}`
      return apiRequest(`/api/shared${suffix}`, { schema: sharedListResponseSchema, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}

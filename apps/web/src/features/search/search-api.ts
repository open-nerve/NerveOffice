// 按标题搜索我能访问的文档（M2-P4 设计 §3.2、§3.4 第 5 条）：范围是我能看到的空间里正常状态的文档，不含回收站里的。
import type { SearchResponse } from '@nerve-office/contracts'
import { searchResponseSchema } from '@nerve-office/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'

export const SEARCH_QUERY_KEY = ['search'] as const

/** 一个关键词的搜索结果，按更新时间从新到旧逐页加载（keyset 分页，不做相关度排序）。 */
export function searchQueryOptions(keyword: string) {
  return infiniteQueryOptions({
    queryKey: [...SEARCH_QUERY_KEY, keyword],
    queryFn: async ({ pageParam, signal }): Promise<SearchResponse> => {
      const query = new URLSearchParams({ query: keyword })
      if (pageParam !== null)
        query.set('cursor', pageParam)
      return apiRequest(`/api/search?${query.toString()}`, { schema: searchResponseSchema, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}

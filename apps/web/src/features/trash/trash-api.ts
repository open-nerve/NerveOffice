// 回收站的接口（M2-P4 设计 §3.2，规则细则见 specs/P4-S3-回收站的规则.md）：按空间列出删除单元、恢复、永久删除。
import type { RestoredTrashEntry, TrashListResponse } from '@nerve-office/contracts'
import { restoredTrashEntrySchema, trashListResponseSchema } from '@nerve-office/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'

export const TRASH_QUERY_KEY = ['trash'] as const

export function spaceTrashQueryKey(spaceId: string) {
  return [...TRASH_QUERY_KEY, 'space', spaceId] as const
}

/** 一个空间的回收站，按删除时间从新到旧逐页加载（keyset 分页，与文档列表同一个做法）。 */
export function spaceTrashQueryOptions(spaceId: string) {
  return infiniteQueryOptions({
    queryKey: spaceTrashQueryKey(spaceId),
    queryFn: async ({ pageParam, signal }): Promise<TrashListResponse> => {
      const query = new URLSearchParams({ spaceId })
      if (pageParam !== null)
        query.set('cursor', pageParam)
      return apiRequest(`/api/trash?${query.toString()}`, { schema: trashListResponseSchema, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}

/** 恢复整个删除单元：响应里说明它回到了哪里（原位置不在时回到空间的根目录）。 */
export async function restoreTrashEntry(entryId: string): Promise<RestoredTrashEntry> {
  return apiRequest(`/api/trash/${entryId}/restore`, { method: 'POST', schema: restoredTrashEntrySchema })
}

/** 永久删除：内容找不回来了，没有响应体。 */
export async function purgeTrashEntry(entryId: string): Promise<void> {
  await apiRequest(`/api/trash/${entryId}`, { method: 'DELETE', schema: z.undefined() })
}

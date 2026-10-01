import type { QueryKey } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { documentDetailsQueryKey, spaceDocumentsQueryKey } from './documents-api.ts'
import { spaceFoldersQueryKey } from './folders-api.ts'

/**
 * 整理之后要重新请求哪些内容：源空间与目标空间里各层的文件夹与文档（跨空间移动、复制时两个空间都变了），
 * 以及按 id 取过的文档元数据（标题与所在文件夹都可能变了）。
 * 按前缀整片作废，不逐层挑：层数不多，漏掉一层会让人看到已经不在的条目。
 */
function organizeQueryKeys(spaceIds: readonly string[]): QueryKey[] {
  return [documentDetailsQueryKey(), ...[...new Set(spaceIds)].flatMap(spaceId => [spaceFoldersQueryKey(spaceId), spaceDocumentsQueryKey(spaceId)])]
}

/** 整理（与新建）成功之后重新请求相关的内容：刷新失败时各个列表自己显示加载失败，不算这个操作失败 */
export function useOrganizeRefresh(): (spaceIds: readonly string[]) => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async (spaceIds) => {
    await Promise.all(organizeQueryKeys(spaceIds).map(async queryKey => queryClient.invalidateQueries({ queryKey })))
  }, [queryClient])
}

/**
 * 结果未知之后重新请求同样的内容（M2-P6 复核第四批）：有一个没能刷新就拒绝（shared/lib/refresh-queries.ts 的 refreshQueries）。
 * 交给 shared/api/write-outcome.ts 的 refreshIfUnknown 在时限之内等它：新建表格与文件夹、整理面板的说明据此区分"已刷新"与"没能刷新"，
 * 刷新一直不回来时也不一直停在"正在…"
 */
export function useOrganizeRefreshAfterUnknown(): (spaceIds: readonly string[]) => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async spaceIds => refreshQueries(queryClient, organizeQueryKeys(spaceIds)), [queryClient])
}

import type { QueryKey } from '@tanstack/react-query'
import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { refreshAfterSuccess } from '../../shared/api/write-outcome.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { documentDetailsQueryKey, spaceDocumentsQueryKey } from './documents-api.ts'
import { spaceFoldersQueryKey } from './folders-api.ts'

/**
 * 整理之后要重新请求的列表：源空间与目标空间里各层的文件夹与文档（跨空间移动、复制时两个空间都变了）。
 * 按前缀整片作废，不逐层挑：层数不多，漏掉一层会让人看到已经不在的条目。also 是空间之外也列着它的列表（"与我共享"，Codex 对抗评审 CX3）
 */
function organizeListKeys(spaceIds: readonly string[], also: readonly QueryKey[]): QueryKey[] {
  return [...[...new Set(spaceIds)].flatMap(spaceId => [spaceFoldersQueryKey(spaceId), spaceDocumentsQueryKey(spaceId)]), ...also]
}

/**
 * 整理（与新建）成功之后重新请求相关的内容：各层的列表，以及按 id 取过的文档元数据（标题与所在文件夹都可能变了）。
 * 最多等到时限（shared/api/write-outcome.ts 的 refreshAfterSuccess，Codex 对抗评审 CX4）：兑现为 undefined 是刷新已经有了结果；
 * 兑现为 BackgroundRefresh 是到了时限还在后台刷新，操作照常结束，说明里说列表还在刷新（OrganizeNotice.refreshing）。
 * 刷新失败不算这个操作失败，各个列表自己说明没能刷新、给出重试（shared/ui/refresh-problem.tsx，CX5）
 */
export function useOrganizeRefresh(): (spaceIds: readonly string[], also?: readonly QueryKey[]) => Promise<BackgroundRefresh | undefined> {
  const queryClient = useQueryClient()
  return useCallback(async (spaceIds, also = []) => refreshAfterSuccess(async () => refreshQueries(queryClient, [...organizeListKeys(spaceIds, also), documentDetailsQueryKey()])), [queryClient])
}

/**
 * 结果未知（M2-P6 复核第四批）、或者按访问权限被拒绝（第五批 G3）之后重新请求同样的内容：说明里要说"列表已刷新"还是"没能刷新"，
 * 只看列表——有一个没能刷新就拒绝（shared/lib/refresh-queries.ts 的 refreshQueries），交给 shared/api/write-outcome.ts 在时限之内等它。
 * 文档的元数据照常重新请求，不计入、也不等（第五批 S-1）：删除、移走真的生效了时，再取那份文档正是 404（或者 403），
 * 那是生效之后的样子，不是"列表没能刷新"——原来计入时，最常见的情形（删除其实已经生效）反倒说成没能刷新，而那一行已经随列表消失了
 */
export function useOrganizeRefreshChecked(): (spaceIds: readonly string[], also?: readonly QueryKey[]) => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async (spaceIds, also = []) => {
    void refreshQueries(queryClient, [documentDetailsQueryKey()], { throwOnError: false })
    await refreshQueries(queryClient, organizeListKeys(spaceIds, also))
  }, [queryClient])
}

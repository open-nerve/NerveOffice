import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { documentDetailsQueryKey, spaceDocumentsQueryKey } from './documents-api.ts'
import { spaceFoldersQueryKey } from './folders-api.ts'

/**
 * 整理之后要重新请求哪些内容：源空间与目标空间里各层的文件夹与文档（跨空间移动、复制时两个空间都变了），
 * 以及按 id 取过的文档元数据（标题与所在文件夹都可能变了）。
 * 按前缀整片作废，不逐层挑：层数不多，漏掉一层会让人看到已经不在的条目。
 */
export function useOrganizeRefresh(): (spaceIds: readonly string[]) => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async (spaceIds) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey() }),
      ...[...new Set(spaceIds)].flatMap(spaceId => [
        queryClient.invalidateQueries({ queryKey: spaceFoldersQueryKey(spaceId) }),
        queryClient.invalidateQueries({ queryKey: spaceDocumentsQueryKey(spaceId) }),
      ]),
    ])
  }, [queryClient])
}

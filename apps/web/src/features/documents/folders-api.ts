// 文件夹的接口（M2-P4 设计 §3.2）：列出一层、新建、改名、移动（同一个空间里或连同子树换空间）、删除（进回收站）。
// 与文档放在同一个功能模块：空间页的一份列表里既有文件夹又有文档，两者的整理操作也是同一套。
import type { CreateFolderRequest, Folder, FolderListResponse, MoveFolderRequest, UpdateFolderRequest } from '@nerve-office/contracts'
import { folderListResponseSchema, folderSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'

export const FOLDERS_QUERY_KEY = ['folders'] as const

/** 一个空间里全部层级的文件夹列表在请求缓存里的共同前缀：整理之后按它整片作废 */
export function spaceFoldersQueryKey(spaceId: string) {
  return [...FOLDERS_QUERY_KEY, 'space', spaceId] as const
}

/** 某一层的子文件夹：parentId 为 null 表示空间的根目录 */
export function folderChildrenQueryKey(spaceId: string, parentId: string | null) {
  return [...spaceFoldersQueryKey(spaceId), parentId ?? 'root'] as const
}

/** 列出一层（不分页，超过上限时服务端给 truncated）。 */
export function folderChildrenQueryOptions(spaceId: string, parentId: string | null) {
  return queryOptions({
    queryKey: folderChildrenQueryKey(spaceId, parentId),
    queryFn: async ({ signal }): Promise<FolderListResponse> => {
      const query = new URLSearchParams({ spaceId })
      if (parentId !== null)
        query.set('parentId', parentId)
      return apiRequest(`/api/folders?${query.toString()}`, { schema: folderListResponseSchema, signal })
    },
  })
}

/** 新建（US-M2-07）：同一个 requestId 重试只建一个。 */
export async function createFolder(request: CreateFolderRequest): Promise<Folder> {
  return apiRequest('/api/folders', { method: 'POST', body: request, schema: folderSchema })
}

/** 改名（同一个文件夹里允许同名，所以不必先查重）。 */
export async function updateFolder(folderId: string, request: UpdateFolderRequest): Promise<Folder> {
  return apiRequest(`/api/folders/${folderId}`, { method: 'PATCH', body: request, schema: folderSchema })
}

/**
 * 连同子树移动到某个空间的某个位置。目标就是现在所在的空间时，服务端按空间内移动处理，
 * 所以界面上"移动"只用这一个接口，不分空间内与跨空间（契约 moveFolderRequestSchema）。
 */
export async function moveFolder(folderId: string, request: MoveFolderRequest): Promise<Folder> {
  return apiRequest(`/api/folders/${folderId}/move`, { method: 'POST', body: request, schema: folderSchema })
}

/** 删除：连同整棵子树进所在空间的回收站，没有响应体。 */
export async function deleteFolder(folderId: string): Promise<void> {
  await apiRequest(`/api/folders/${folderId}`, { method: 'DELETE', schema: z.undefined() })
}

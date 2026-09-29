// 当前位置的那一串文件夹（M2-P4 设计 §3.7）：地址里带着从空间根目录到当前文件夹的 id 路径（shared/lib/space-paths.ts 里写了为什么）。
import type { Folder, FolderListResponse } from '@nerve-office/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import { useQueries } from '@tanstack/react-query'
import { isMissingResource } from '../../shared/api/index.ts'
import { folderChildrenQueryOptions } from './folders-api.ts'

/** 面包屑上的一级：id 一定有，名称要从"它父亲那一层的列表"里读出来，还没读到时为 undefined */
export interface FolderCrumb {
  readonly id: string
  readonly name: string | undefined
}

export interface FolderTrail {
  /** 从最浅到最深，与地址里的 id 路径一一对应 */
  readonly crumbs: readonly FolderCrumb[]
  /** 当前这一层的子文件夹 */
  readonly children: UseQueryResult<FolderListResponse>
  /** 路径上有一级看不到了（被删、被移走，或者本来就不存在）：整条路径都不成立 */
  readonly missing: boolean
}

/**
 * 取当前位置需要的每一层：根目录、以及路径上每个文件夹的子列表。
 * 一次性把各层都请求出去（它们互不依赖），所以直接打开深层地址与一层层点进去一样快；
 * 上一级的列表也已经在缓存里，点面包屑回去不用再等。
 */
export function useFolderTrail(spaceId: string, folderIds: readonly string[]): FolderTrail {
  const results = useQueries({
    // 要取子列表的每一层：先是空间的根目录，然后是路径上的每个文件夹
    queries: [null, ...folderIds].map(parentId => folderChildrenQueryOptions(spaceId, parentId)),
  })
  const crumbs = folderIds.map((id, level) => ({
    // 第 level 个文件夹的名称，在"它父亲那一层"（第 level 个列表）里
    id,
    name: results[level]?.data?.items.find((folder: Folder) => folder.id === id)?.name,
  }))
  return {
    crumbs,
    // 上面按 [null, ...folderIds] 逐层取，最后一个就是当前这一层
    children: results[folderIds.length] as UseQueryResult<FolderListResponse>,
    missing: results.some(result => isMissingResource(result.error)),
  }
}

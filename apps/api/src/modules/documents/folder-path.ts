import type { FolderAncestorRow } from './folders.repository.ts'
import { FOLDER_MAX_DEPTH } from '@nerve-office/contracts'

/**
 * 每个文件夹从空间根目录到它自己的名称（从浅到深）；空间根目录下的文件夹只有它自己一段。
 *
 * rows 是这些文件夹连同它们的全部祖先，由一次批量查询一起取出（FoldersRepository.ancestorsOf）：
 * 拼路径在内存里走父链，不再查库，所以一页结果只查一次，不按结果条数、也不按层数反复查。
 * 父辈不在 rows 里（看不到的空间被过滤掉了）时路径就到此为止，只给看得到的那几段；
 * 走的步数以 FOLDER_MAX_DEPTH 为上限，万一数据里的父子关系成环也不会转不出来，路径也不会超过契约的上限。
 */
export function folderPathsOf(rows: readonly FolderAncestorRow[]): ReadonlyMap<string, string[]> {
  const byId = new Map(rows.map(row => [row.id, row]))
  const paths = new Map<string, string[]>()
  for (const row of rows) {
    const names: string[] = []
    let current: FolderAncestorRow | undefined = row
    for (let step = 0; current !== undefined && step < FOLDER_MAX_DEPTH; step += 1) {
      names.unshift(current.name)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    paths.set(row.id, names)
  }
  return paths
}

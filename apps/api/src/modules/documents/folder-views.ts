import type { Folder, FolderPermissions } from '@nerve-office/contracts'
import type { FolderRow } from './folders.repository.ts'

/** 一个文件夹与调用者在它上面的权限（contracts 的 folderSchema）。 */
export function toFolder(row: FolderRow, permissions: FolderPermissions): Folder {
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    name: row.name,
    depth: row.depth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    permissions,
  }
}

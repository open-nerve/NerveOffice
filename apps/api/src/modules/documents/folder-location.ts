import type { Transaction } from '../database/index.ts'
import type { FolderRow, FoldersRepository } from './folders.repository.ts'
import { AppError } from '../../shared/errors/app-error.ts'

/**
 * 某个空间里正常状态的一个文件夹：列出的那一层、新建时的父文件夹、文档移动或复制的目标位置。
 * 不存在、已经在回收站里、在别的空间里都是同一个 NOT_FOUND（M2-P4 设计 §3.5）：
 * 三种情况执行同样的查询，不暴露别的空间里有没有这个文件夹。
 * 只有一处这样的判断：文件夹、文档、列表的目录过滤共用它，规则不各写各的
 */
export async function requireFolderIn(
  folders: FoldersRepository,
  spaceId: string,
  folderId: string,
  transaction?: Transaction,
): Promise<FolderRow> {
  const folder = await folders.findById(folderId, transaction)
  if (folder === undefined || folder.spaceId !== spaceId)
    throw new AppError('NOT_FOUND')
  return folder
}

/**
 * 请求里给出的目标位置换成要写进 folder_id 的值：null 表示空间的根目录，不必查询。
 * 给出文件夹时按上面的规则判断它在不在这个空间里。
 */
export async function folderIdIn(
  folders: FoldersRepository,
  spaceId: string,
  folderId: string | null,
  transaction?: Transaction,
): Promise<string | null> {
  return folderId === null ? null : (await requireFolderIn(folders, spaceId, folderId, transaction)).id
}

import type { CsvCreateLocation } from '@nerve-office/contracts'
import type { CsvCreationDestination } from './csv-create-controller.ts'
import { folderListResponseSchema, spaceViewSchema } from '@nerve-office/contracts'
import { ApiError, apiRequest } from '../../shared/api/index.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'

/** 两个既有只读接口核对空间权限和 parent 所属；最终创建仍由服务端事务复核。 */
export async function fetchCsvDestination(location: CsvCreateLocation, signal: AbortSignal): Promise<CsvCreationDestination> {
  const space = await apiRequest(`/api/spaces/${location.spaceId}`, { schema: spaceViewSchema, signal })
  if (space.status !== 'active' || !space.permissions.canCreateDocuments)
    throw new ApiError(403, 'PERMISSION_DENIED', '此位置不能创建文档')
  if (location.folderId === undefined)
    return { spaceName: space.name }
  const parameters = new URLSearchParams({ spaceId: location.spaceId, parentId: location.folderId })
  await apiRequest(`/api/folders?${parameters.toString()}`, { schema: folderListResponseSchema, signal })
  return { spaceName: space.name, folderName: editorMessages.csvCreate.selectedFolder }
}

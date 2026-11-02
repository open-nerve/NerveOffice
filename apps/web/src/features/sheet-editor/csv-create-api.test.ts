import type { SpaceView } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
import { fetchCsvDestination } from './csv-create-api.ts'

const CSV_SPACE: SpaceView = {
  id: '0199a2c4-0000-7000-8000-000000000002',
  name: '我的空间',
  type: 'personal',
  status: 'active',
  role: 'admin',
  visibleToAll: false,
  permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: false, canManageMembers: false, canRename: false, canPurgeTrash: true },
}
const folderId = '0199a2c4-0000-7000-8000-000000000004'

describe('CSV 新建位置的既有权限接口', () => {
  it('根目录只读取空间权限；文件夹经服务端核对所属空间', async () => {
    const api = installFakeApi({
      [`GET /api/spaces/${CSV_SPACE.id}`]: () => json(200, CSV_SPACE),
      [`GET /api/folders?spaceId=${CSV_SPACE.id}&parentId=${folderId}`]: () => json(200, { items: [], truncated: false }),
    })
    const signal = new AbortController().signal
    expect(await fetchCsvDestination({ spaceId: CSV_SPACE.id }, signal)).toEqual({ spaceName: '我的空间' })
    expect(api.requests).toHaveLength(1)
    expect(await fetchCsvDestination({ spaceId: CSV_SPACE.id, folderId }, signal)).toEqual({ spaceName: '我的空间', folderName: '所选文件夹' })
    expect(api.requests.map(r => r.key)).toEqual([`GET /api/spaces/${CSV_SPACE.id}`, `GET /api/spaces/${CSV_SPACE.id}`, `GET /api/folders?spaceId=${CSV_SPACE.id}&parentId=${folderId}`])
  })

  it('不能创建或归档的空间拒绝，文件夹不存在也不继续', async () => {
    const api = installFakeApi({ [`GET /api/spaces/${CSV_SPACE.id}`]: () => json(200, { ...CSV_SPACE, permissions: { ...CSV_SPACE.permissions, canCreateDocuments: false } }) })
    const signal = new AbortController().signal
    await expect(fetchCsvDestination({ spaceId: CSV_SPACE.id, folderId }, signal)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(api.requests).toHaveLength(1)
    api.on(`GET /api/spaces/${CSV_SPACE.id}`, () => json(200, { ...CSV_SPACE, status: 'archived' }))
    await expect(fetchCsvDestination({ spaceId: CSV_SPACE.id }, signal)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    api.on(`GET /api/spaces/${CSV_SPACE.id}`, () => json(200, CSV_SPACE))
    api.on(`GET /api/folders?spaceId=${CSV_SPACE.id}&parentId=${folderId}`, () => apiError(404, 'NOT_FOUND'))
    await expect(fetchCsvDestination({ spaceId: CSV_SPACE.id, folderId }, signal)).rejects.toMatchObject({ status: 404 })
  })
})

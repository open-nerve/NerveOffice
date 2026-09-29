import { describe, expect, it } from 'vitest'
import { documentListQuerySchema } from '../documents/documents.ts'
import {
  createFolderRequestSchema,
  FOLDER_MAX_DEPTH,
  FOLDER_NAME_MAX_LENGTH,
  folderListQuerySchema,
  folderListResponseSchema,
  folderNameSchema,
  moveFolderRequestSchema,
  updateFolderRequestSchema,
} from './folders.ts'

const SPACE_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
const FOLDER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0f'
const REQUEST_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c10'

const folder = {
  id: FOLDER_ID,
  spaceId: SPACE_ID,
  parentId: null,
  name: '资料',
  depth: 1,
  createdAt: '2026-09-30T01:00:00.000Z',
  updatedAt: '2026-09-30T02:00:00.000Z',
  permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false },
}

describe('文件夹的名称', () => {
  it('去掉首尾空白之后 1–100 个字符（按码点计），不含控制字符', () => {
    expect(folderNameSchema.parse(' 资料 ')).toBe('资料')
    expect(folderNameSchema.safeParse('😀'.repeat(FOLDER_NAME_MAX_LENGTH)).success).toBe(true)
    expect(folderNameSchema.safeParse('😀'.repeat(FOLDER_NAME_MAX_LENGTH + 1)).success).toBe(false)
    expect(folderNameSchema.safeParse('   ').success).toBe(false)
    expect(folderNameSchema.safeParse('资\t料').success).toBe(false)
  })
})

describe('列出一层', () => {
  it('parentId 省略表示空间的根目录；多出的参数被拒绝', () => {
    expect(folderListQuerySchema.parse({ spaceId: SPACE_ID })).toEqual({ spaceId: SPACE_ID })
    expect(folderListQuerySchema.parse({ spaceId: SPACE_ID, parentId: FOLDER_ID.toUpperCase() })).toEqual({ spaceId: SPACE_ID, parentId: FOLDER_ID })
    expect(folderListQuerySchema.safeParse({ spaceId: SPACE_ID, depth: 2 }).success).toBe(false)
    expect(folderListQuerySchema.safeParse({}).success).toBe(false)
  })

  it('响应带着每个文件夹的层数与调用者能做的操作；多出的字段被丢弃', () => {
    expect(folderListResponseSchema.parse({ items: [{ ...folder, createdBy: 'x' }], truncated: false })).toEqual({ items: [folder], truncated: false })
    expect(folderListResponseSchema.safeParse({ items: [{ ...folder, depth: 0 }], truncated: false }).success).toBe(false)
    expect(FOLDER_MAX_DEPTH).toBe(10)
  })
})

describe('新建与改动', () => {
  it('新建：空间、名称与 requestId 必填，parentId 可选；UUID 统一成小写', () => {
    expect(createFolderRequestSchema.parse({ spaceId: SPACE_ID.toUpperCase(), name: ' 资料 ', requestId: REQUEST_ID.toUpperCase() }))
      .toEqual({ spaceId: SPACE_ID, name: '资料', requestId: REQUEST_ID })
    expect(createFolderRequestSchema.safeParse({ spaceId: SPACE_ID, name: '资料' }).success).toBe(false)
    expect(createFolderRequestSchema.safeParse({ spaceId: SPACE_ID, name: '', requestId: REQUEST_ID }).success).toBe(false)
    expect(createFolderRequestSchema.safeParse({ spaceId: SPACE_ID, name: '资料', requestId: REQUEST_ID, depth: 3 }).success).toBe(false)
  })

  it('改动：两项都可选，parentId 为 null 表示移到空间的根目录；省略与 null 分得开', () => {
    expect(updateFolderRequestSchema.parse({ name: ' 归档 ' })).toEqual({ name: '归档' })
    expect(updateFolderRequestSchema.parse({ parentId: null })).toEqual({ parentId: null })
    expect(Object.hasOwn(updateFolderRequestSchema.parse({ name: '归档' }), 'parentId')).toBe(false)
    expect(updateFolderRequestSchema.parse({})).toEqual({})
    expect(updateFolderRequestSchema.safeParse({ spaceId: SPACE_ID }).success).toBe(false)
  })

  it('移动：目标空间必填，folderId 省略表示目标空间的根目录（与移动文档同一个形状）', () => {
    expect(moveFolderRequestSchema.parse({ spaceId: SPACE_ID.toUpperCase() })).toEqual({ spaceId: SPACE_ID })
    expect(moveFolderRequestSchema.parse({ spaceId: SPACE_ID, folderId: FOLDER_ID.toUpperCase() })).toEqual({ spaceId: SPACE_ID, folderId: FOLDER_ID })
    expect(moveFolderRequestSchema.safeParse({ folderId: FOLDER_ID }).success).toBe(false)
    // 根目录用"省略"表示，不收 null；多出的字段（例如 PATCH 用的 parentId）被拒绝
    expect(moveFolderRequestSchema.safeParse({ spaceId: SPACE_ID, folderId: null }).success).toBe(false)
    expect(moveFolderRequestSchema.safeParse({ spaceId: SPACE_ID, parentId: FOLDER_ID }).success).toBe(false)
  })
})

describe('文档列表按目录过滤', () => {
  it('folderId 省略表示空间的根目录，all 表示整个空间，其余只接受 UUID（统一成小写）', () => {
    expect(documentListQuerySchema.parse({ spaceId: SPACE_ID }).folderId).toBeUndefined()
    expect(documentListQuerySchema.parse({ spaceId: SPACE_ID, folderId: 'all' }).folderId).toBe('all')
    expect(documentListQuerySchema.parse({ spaceId: SPACE_ID, folderId: FOLDER_ID.toUpperCase() }).folderId).toBe(FOLDER_ID)
    expect(documentListQuerySchema.safeParse({ spaceId: SPACE_ID, folderId: 'root' }).success).toBe(false)
  })
})

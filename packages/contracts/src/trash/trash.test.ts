import { describe, expect, it } from 'vitest'
import {
  restoredTrashEntrySchema,
  TRASH_ENTRY_KINDS,
  TRASH_RETENTION_DAYS,
  trashListQuerySchema,
  trashListResponseSchema,
} from './trash.ts'

const SPACE_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c11'
const ENTRY_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c12'
const FOLDER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c13'
const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c14'

const entry = {
  id: ENTRY_ID,
  spaceId: SPACE_ID,
  kind: 'folder',
  title: '资料',
  deletedBy: { id: USER_ID, username: 'amy', displayName: '艾米' },
  deletedAt: '2026-09-30T01:00:00.000Z',
  expiresAt: '2026-10-30T01:00:00.000Z',
  origin: { parentId: FOLDER_ID, parentName: '归档', available: true },
  documentCount: 3,
  permissions: { canRestore: true, canPurge: false },
}

describe('删除单元', () => {
  it('种类只有文档与文件夹，保留 30 天', () => {
    expect(TRASH_ENTRY_KINDS).toEqual(['document', 'folder'])
    expect(TRASH_RETENTION_DAYS).toBe(30)
  })

  it('列表带原位置、份数与调用者能做的操作；多出的字段被丢弃，不合法的被拒绝', () => {
    expect(trashListResponseSchema.parse({ items: [{ ...entry, deletedById: USER_ID }], nextCursor: null }))
      .toEqual({ items: [entry], nextCursor: null })
    // 删除的人可以为空（账户已经不在），原位置的父文件夹与名称也可以为空（根目录、或者原位置已不存在）
    const orphan = { ...entry, deletedBy: null, origin: { parentId: null, parentName: null, available: false } }
    expect(trashListResponseSchema.parse({ items: [orphan], nextCursor: 'abc' }).items).toEqual([orphan])
    expect(trashListResponseSchema.safeParse({ items: [{ ...entry, kind: 'space' }], nextCursor: null }).success).toBe(false)
    expect(trashListResponseSchema.safeParse({ items: [{ ...entry, documentCount: -1 }], nextCursor: null }).success).toBe(false)
  })
})

describe('按空间列出回收站', () => {
  it('spaceId 必填、统一成小写，cursor 可选；多出的参数被拒绝', () => {
    expect(trashListQuerySchema.parse({ spaceId: SPACE_ID.toUpperCase() })).toEqual({ spaceId: SPACE_ID })
    expect(trashListQuerySchema.parse({ spaceId: SPACE_ID, cursor: 'abc' })).toEqual({ spaceId: SPACE_ID, cursor: 'abc' })
    expect(trashListQuerySchema.safeParse({}).success).toBe(false)
    expect(trashListQuerySchema.safeParse({ spaceId: SPACE_ID, limit: 10 }).success).toBe(false)
  })
})

describe('恢复的结果', () => {
  it('给出恢复到的位置；原位置不在时 movedToRoot 为真、folderId 为空', () => {
    const restored = { id: FOLDER_ID, kind: 'folder', title: '资料', spaceId: SPACE_ID, folderId: null, movedToRoot: true }
    expect(restoredTrashEntrySchema.parse({ ...restored, extra: 1 })).toEqual(restored)
    expect(restoredTrashEntrySchema.safeParse({ ...restored, title: '' }).success).toBe(false)
    expect(restoredTrashEntrySchema.safeParse({ ...restored, movedToRoot: undefined }).success).toBe(false)
  })
})

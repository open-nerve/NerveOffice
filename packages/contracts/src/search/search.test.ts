import { describe, expect, it } from 'vitest'
import { DOCUMENT_TITLE_MAX_LENGTH } from '../documents/documents.ts'
import { FOLDER_MAX_DEPTH } from '../folders/folders.ts'
import { SEARCH_PAGE_SIZE, searchQuerySchema, searchResponseSchema } from './search.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c21'
const SPACE_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c22'
const FOLDER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c23'

const result = {
  id: DOCUMENT_ID,
  title: '季度预算',
  type: 'sheet',
  createdAt: '2026-09-30T01:00:00.000Z',
  updatedAt: '2026-09-30T02:00:00.000Z',
  space: { id: SPACE_ID, type: 'team', name: '市场部' },
  folderId: FOLDER_ID,
  folderPath: ['资料', '2026'],
  accessVia: 'space',
}

describe('搜索的查询参数', () => {
  it('关键词去掉首尾空白；只有空白、空字符串与缺失都被拒绝（400 由此而来）', () => {
    expect(searchQuerySchema.parse({ query: '  预算  ' })).toEqual({ query: '预算' })
    for (const query of ['', ' ', '\t\n ', '　'])
      expect(searchQuerySchema.safeParse({ query }).success, JSON.stringify(query)).toBe(false)
    expect(searchQuerySchema.safeParse({}).success).toBe(false)
  })

  it('关键词的上限与标题一致，按码点计', () => {
    expect(searchQuerySchema.safeParse({ query: '好'.repeat(DOCUMENT_TITLE_MAX_LENGTH) }).success).toBe(true)
    expect(searchQuerySchema.safeParse({ query: '好'.repeat(DOCUMENT_TITLE_MAX_LENGTH + 1) }).success).toBe(false)
    // 一个星标符号算一个码点（两个 UTF-16 码元）
    expect(searchQuerySchema.safeParse({ query: '𝄞'.repeat(DOCUMENT_TITLE_MAX_LENGTH) }).success).toBe(true)
  })

  it('通配符与转义符是普通的关键词，契约层不拦（转义在服务端做）', () => {
    for (const query of ['%', '_', '\\', 'a%b_c\\d'])
      expect(searchQuerySchema.parse({ query })).toEqual({ query })
  })

  it('游标可选；每页条数不由客户端指定，多出的参数被拒绝', () => {
    expect(searchQuerySchema.parse({ query: '预算', cursor: 'abc' })).toEqual({ query: '预算', cursor: 'abc' })
    expect(SEARCH_PAGE_SIZE).toBe(50)
    expect(searchQuerySchema.safeParse({ query: '预算', limit: 10 }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ query: '预算', spaceId: SPACE_ID }).success).toBe(false)
  })
})

describe('搜索的结果', () => {
  it('一条是文档的摘要加上所在的空间与文件夹路径；多出的字段被丢弃', () => {
    expect(searchResponseSchema.parse({ items: [{ ...result, revision: 3 }], nextCursor: null }))
      .toEqual({ items: [result], nextCursor: null })
  })

  it('空间根目录下的文档：folderId 为空，路径是空数组', () => {
    const atRoot = { ...result, folderId: null, folderPath: [] }
    expect(searchResponseSchema.parse({ items: [atRoot], nextCursor: 'abc' }).items).toEqual([atRoot])
  })

  it('看得到它的途径（M2-P5）：必填；凭授权命中的一条不带目录结构（folderId 为空、路径是空数组）', () => {
    const viaGrant = { ...result, folderId: null, folderPath: [], accessVia: 'grant' }
    expect(searchResponseSchema.parse({ items: [viaGrant], nextCursor: null }).items).toEqual([viaGrant])
    expect(searchResponseSchema.safeParse({ items: [{ ...result, accessVia: undefined }], nextCursor: null }).success).toBe(false)
    expect(searchResponseSchema.safeParse({ items: [{ ...result, accessVia: 'link' }], nextCursor: null }).success).toBe(false)
  })

  it('个人空间只带所有者（"人"的结构，M2-P5），不带存的名称（建号时的显示名，可以伪造，规范 §2.4）：服务端多给了也被丢弃；缺了所有者、所有者不是"人"的结构都被拒绝', () => {
    const owner = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c24', username: 'amy', displayName: '艾米' }
    const personal = { ...result, space: { id: SPACE_ID, type: 'personal', owner } }
    expect(searchResponseSchema.parse({ items: [personal], nextCursor: null }).items).toEqual([personal])
    const [withName] = searchResponseSchema.parse({ items: [{ ...personal, space: { ...personal.space, name: '艾米（管理员）' } }], nextCursor: null }).items
    expect(withName?.space).toEqual({ id: SPACE_ID, type: 'personal', owner })
    for (const space of [{ id: SPACE_ID, type: 'personal', name: '艾米' }, { id: SPACE_ID, type: 'personal', owner: { id: owner.id } }, { id: SPACE_ID, type: 'personal', owner: null }])
      expect(searchResponseSchema.safeParse({ items: [{ ...result, space }], nextCursor: null }).success, JSON.stringify(space)).toBe(false)
  })

  it('团队空间带名称、没有所有者（多给的被丢弃）；别的空间类型被拒绝', () => {
    const owner = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c24', username: 'amy', displayName: '艾米' }
    const [team] = searchResponseSchema.parse({ items: [{ ...result, space: { id: SPACE_ID, type: 'team', name: '市场部', owner } }], nextCursor: null }).items
    expect(team?.space).toEqual({ id: SPACE_ID, type: 'team', name: '市场部' })
    expect(searchResponseSchema.safeParse({ items: [{ ...result, space: { id: SPACE_ID, type: 'team', owner } }], nextCursor: null }).success).toBe(false)
    expect(searchResponseSchema.safeParse({ items: [{ ...result, space: { id: SPACE_ID, type: 'folder', name: '市场部' } }], nextCursor: null }).success).toBe(false)
  })

  it('路径最长与文件夹的层数上限一致；结构不对的被拒绝', () => {
    const path = (segments: number): string[] => Array.from({ length: segments }, (_, index) => `第 ${index + 1} 层`)
    expect(searchResponseSchema.safeParse({ items: [{ ...result, folderPath: path(FOLDER_MAX_DEPTH) }], nextCursor: null }).success).toBe(true)
    expect(searchResponseSchema.safeParse({ items: [{ ...result, folderPath: path(FOLDER_MAX_DEPTH + 1) }], nextCursor: null }).success).toBe(false)
    expect(searchResponseSchema.safeParse({ items: [{ ...result, folderPath: '资料/2026' }], nextCursor: null }).success).toBe(false)
    expect(searchResponseSchema.safeParse({ items: [{ ...result, space: { id: SPACE_ID, name: '市场部' } }], nextCursor: null }).success).toBe(false)
  })
})

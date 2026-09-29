import { describe, expect, it } from 'vitest'
import {
  createDocumentRequestSchema,
  DEFAULT_DOCUMENT_TITLES,
  DOCUMENT_PROFILE_OF,
  DOCUMENT_PROFILES,
  DOCUMENT_TITLE_MAX_LENGTH,
  DOCUMENT_TYPES,
  documentDetailSchema,
  documentListQuerySchema,
  documentListResponseSchema,
  documentTitleSchema,
  PLATFORM_FORMAT_VERSION,
  PLATFORM_FORMAT_VERSIONS,
} from './documents.ts'

describe('文档列表的查询参数', () => {
  it('limit 默认 50，查询串里的数字字符串转成数字，范围 1–100', () => {
    expect(documentListQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(documentListQuerySchema.parse({ limit: '20', cursor: 'abc' })).toEqual({ limit: 20, cursor: 'abc' })
    for (const limit of ['0', '101', '1.5', 'x', ''])
      expect(documentListQuerySchema.safeParse({ limit }).success, limit).toBe(false)
  })

  it('不接受多余的参数，游标不能为空', () => {
    expect(documentListQuerySchema.safeParse({ sort: 'title' }).success).toBe(false)
    expect(documentListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })

  it('按空间列出：spaceId 可选，必须是 UUID；没有时是个人空间（M1 兼容）', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    expect(documentListQuerySchema.parse({ spaceId })).toEqual({ spaceId, limit: 50 })
    expect(documentListQuerySchema.parse({})).not.toHaveProperty('spaceId')
    expect(documentListQuerySchema.safeParse({ spaceId: 'personal' }).success).toBe(false)
  })
})

describe('文档列表的响应', () => {
  it('时间必须是 UTC 的 ISO 8601', () => {
    const item = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', title: '周报', type: 'sheet', createdAt: '2026-09-26T08:00:00.000Z', updatedAt: '2026-09-26T09:00:00.000Z' }
    expect(documentListResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true)
    expect(documentListResponseSchema.safeParse({ items: [{ ...item, updatedAt: '2026-09-26 09:00' }], nextCursor: null }).success).toBe(false)
  })

  it('多出的字段被丢弃：接口只做加法时，打开着的旧页面照常工作', () => {
    const item = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', title: '周报', type: 'sheet', createdAt: '2026-09-26T08:00:00.000Z', updatedAt: '2026-09-26T09:00:00.000Z' }
    expect(documentListResponseSchema.parse({ items: [{ ...item, starred: true }], nextCursor: null, total: 1 })).toEqual({ items: [item], nextCursor: null })
  })
})

describe('新建文档的请求', () => {
  const requestId = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'

  it('类型与 requestId 必填，标题可选；标题去掉首尾空白', () => {
    expect(createDocumentRequestSchema.parse({ type: 'sheet', requestId })).toEqual({ type: 'sheet', requestId })
    expect(createDocumentRequestSchema.parse({ type: 'sheet', title: ' 周报 ', requestId })).toEqual({ type: 'sheet', title: '周报', requestId })
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet' }).success).toBe(false)
    expect(createDocumentRequestSchema.safeParse({ type: 'doc', requestId }).success).toBe(false)
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId: 'abc' }).success).toBe(false)
  })

  it('不接受多余的字段', () => {
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId, folderId: requestId }).success).toBe(false)
  })

  it('建在哪个空间：spaceId 可选，必须是 UUID；没有时建在个人空间（M1 兼容）', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    expect(createDocumentRequestSchema.parse({ type: 'sheet', requestId, spaceId })).toEqual({ type: 'sheet', requestId, spaceId })
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId, spaceId: 'team' }).success).toBe(false)
  })

  it('标题 1–200 个字符（按码点计），不含控制字符', () => {
    expect(documentTitleSchema.safeParse('😀'.repeat(DOCUMENT_TITLE_MAX_LENGTH)).success).toBe(true)
    expect(documentTitleSchema.safeParse('😀'.repeat(DOCUMENT_TITLE_MAX_LENGTH + 1)).success).toBe(false)
    expect(documentTitleSchema.safeParse('   ').success).toBe(false)
    expect(documentTitleSchema.safeParse('周\n报').success).toBe(false)
  })

  it('每种类型都有默认标题与档案', () => {
    for (const type of DOCUMENT_TYPES) {
      expect(documentTitleSchema.parse(DEFAULT_DOCUMENT_TITLES[type])).toBe(DEFAULT_DOCUMENT_TITLES[type])
      expect(DOCUMENT_PROFILES).toContain(DOCUMENT_PROFILE_OF[type])
    }
    expect(PLATFORM_FORMAT_VERSIONS).toContain(PLATFORM_FORMAT_VERSION)
  })
})

describe('文档的元数据', () => {
  const detail = {
    id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d',
    title: '周报',
    type: 'sheet',
    createdAt: '2026-09-26T08:00:00.000Z',
    updatedAt: '2026-09-26T09:00:00.000Z',
    spaceId: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e',
    space: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e', type: 'team', name: '市场部' },
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    permissions: { canEdit: true },
  }

  it('档案与格式版本不按已知的取值校验：客户端自己核对，不认识的显示格式不受支持', () => {
    expect(documentDetailSchema.parse(detail)).toEqual(detail)
    expect(documentDetailSchema.parse({ ...detail, profile: 'sheet@9', formatVersion: 7 })).toMatchObject({ profile: 'sheet@9', formatVersion: 7 })
  })

  it('修订号从 1 开始', () => {
    expect(documentDetailSchema.safeParse({ ...detail, revision: 0 }).success).toBe(false)
  })

  it('带着所在的空间：编辑器页的返回链接回到那里', () => {
    expect(documentDetailSchema.safeParse({ ...detail, space: undefined }).success).toBe(false)
    expect(documentDetailSchema.safeParse({ ...detail, space: { ...detail.space, type: 'shared' } }).success).toBe(false)
  })
})

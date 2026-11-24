// M6-P1 S2：文字文档的类型与档案、可新建的类型、响应里类型字段的宽容解析（M6 总设计 §2.2 第 5 条、§6.1，P1 设计 §3.2）
import { describe, expect, it } from 'vitest'
import { adminUserDocumentSchema } from '../admin/admin.ts'
import { searchResultSchema } from '../search/search.ts'
import { sharedDocumentSchema } from '../sharing/sharing.ts'
import { documentHistorySummarySchema } from './document-history.ts'
import { createDocumentRequestSchema } from './document-requests.ts'
import {
  CREATABLE_DOCUMENT_TYPES,
  createdDocumentSchema,
  DEFAULT_DOCUMENT_TITLES,
  DOCUMENT_PROFILE_OF,
  DOCUMENT_PROFILES,
  DOCUMENT_TYPES,
  documentDetailSchema,
  documentListResponseSchema,
  documentSummarySchema,
  responseDocumentTypeSchema,
  UNKNOWN_DOCUMENT_TYPE,
} from './documents.ts'
import { documentDraftFactSchema } from './draft-facts.ts'

const ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const AT = '2026-11-18T08:00:00.000Z'

describe('文档类型与档案（M6 加上文字文档）', () => {
  it('类型是表格与文字文档，档案各一个，新建时用的档案与默认标题都有', () => {
    expect(DOCUMENT_TYPES).toEqual(['sheet', 'doc'])
    expect(DOCUMENT_PROFILES).toEqual(['sheet@1', 'doc@1'])
    expect(DOCUMENT_PROFILE_OF).toEqual({ sheet: 'sheet@1', doc: 'doc@1' })
    expect(DEFAULT_DOCUMENT_TITLES.doc).toBe('未命名文字文档')
  })

  it('可新建的类型 P1 只有表格：文字文档的新建模板在 P2 随编辑器生成，之前新建请求不收 doc', () => {
    expect(CREATABLE_DOCUMENT_TYPES).toEqual(['sheet'])
    for (const type of CREATABLE_DOCUMENT_TYPES)
      expect(DOCUMENT_TYPES).toContain(type)
    expect(createDocumentRequestSchema.safeParse({ type: 'doc', requestId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d' }).success).toBe(false)
  })
})

describe('响应里的文档类型：没见过的取值解析为 unknown，不让整个响应作废', () => {
  it('认识的取值原样保留；没见过的非空字符串解析为 unknown；缺少、空串与非字符串仍是格式错误，不猜测', () => {
    expect(UNKNOWN_DOCUMENT_TYPE).toBe('unknown')
    expect(responseDocumentTypeSchema.parse('sheet')).toBe('sheet')
    expect(responseDocumentTypeSchema.parse('doc')).toBe('doc')
    for (const value of ['slides', 'SHEET', 'unknown'])
      expect(responseDocumentTypeSchema.parse(value), value).toBe(UNKNOWN_DOCUMENT_TYPE)
    for (const value of ['', 42, null, undefined, {}, ['sheet']])
      expect(responseDocumentTypeSchema.safeParse(value).success, String(value)).toBe(false)
  })

  it('列表里有一条新类型：这一条的类型是 unknown，其余条目与整个列表照常', () => {
    const sheet = { id: ID, title: '周报', type: 'sheet', createdAt: AT, updatedAt: AT }
    const parsed = documentListResponseSchema.parse({ items: [sheet, { ...sheet, type: 'slides' }, { ...sheet, type: 'doc' }], nextCursor: null })
    expect(parsed.items.map(item => item.type)).toEqual(['sheet', UNKNOWN_DOCUMENT_TYPE, 'doc'])
  })

  it('凡是带文档类型的响应都用同一个宽容的字段：摘要（详情、新建与副本、搜索、与我共享继承它）、历史、草稿事实、管理端', () => {
    for (const schema of [documentSummarySchema, documentDetailSchema, createdDocumentSchema, searchResultSchema, sharedDocumentSchema, documentHistorySummarySchema, adminUserDocumentSchema])
      expect(schema.shape.type).toBe(responseDocumentTypeSchema)
    const [accessible] = documentDraftFactSchema.options
    expect(accessible.shape.status.value).toBe('accessible')
    expect(accessible.shape.type).toBe(responseDocumentTypeSchema)
  })
})

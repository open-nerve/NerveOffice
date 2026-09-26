import { describe, expect, it } from 'vitest'
import { documentListQuerySchema, documentListResponseSchema } from './documents.ts'

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
})

describe('文档列表的响应', () => {
  it('时间必须是 UTC 的 ISO 8601', () => {
    const item = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', title: '周报', type: 'sheet', createdAt: '2026-09-26T08:00:00.000Z', updatedAt: '2026-09-26T09:00:00.000Z' }
    expect(documentListResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true)
    expect(documentListResponseSchema.safeParse({ items: [{ ...item, updatedAt: '2026-09-26 09:00' }], nextCursor: null }).success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { clearDocumentHistoryResponseSchema, documentHistoryDetailSchema, documentHistoryIdSchema, documentHistoryListResponseSchema, HISTORY_PAGE_SIZE, historyListQuerySchema, restoreDocumentHistoryRequestSchema } from './document-history.ts'

const ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const AT = '2026-10-22T08:00:00.000Z'
const item = {
  id: ID,
  revision: 2,
  savedAt: AT,
  createdAt: AT,
  expiresAt: '2026-10-29T08:00:00.000Z',
  savedBy: { id: ID, username: 'alice', displayName: '甲' },
  title: '旧表格',
  type: 'sheet',
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '0.18.0',
  clientBuild: 'build1',
  formulasPending: false,
  rawBytes: 200,
  storedBytes: 120,
  compatibility: 'supported',
}

describe('用户历史契约', () => {
  it('列表固定 30 条，只接受有界游标；路径 id 必须是 UUID', () => {
    expect(HISTORY_PAGE_SIZE).toBe(30)
    expect(historyListQuerySchema.parse({})).toEqual({})
    expect(historyListQuerySchema.parse({ cursor: 'abc' })).toEqual({ cursor: 'abc' })
    for (const input of [{ limit: 1 }, { cursor: '' }, { cursor: 'x'.repeat(513) }, { cursor: ['x'] }, { kind: 'before_delete' }])
      expect(historyListQuerySchema.safeParse(input).success).toBe(false)
    expect(documentHistoryIdSchema.safeParse(ID).success).toBe(true)
    expect(documentHistoryIdSchema.safeParse('invalid').success).toBe(false)
  })

  it('保留未知格式供界面说明，不把兼容标记当作正文已通过检查', () => {
    expect(documentHistoryDetailSchema.parse(item)).toEqual(item)
    expect(documentHistoryDetailSchema.parse({ ...item, clientBuild: null })).toEqual({ ...item, clientBuild: null })
    const newer = { ...item, profile: 'sheet@999', formatVersion: 999, sdkVersion: '999.0.0', compatibility: 'unsupported' }
    expect(documentHistoryDetailSchema.parse(newer)).toEqual(newer)
    expect(documentHistoryDetailSchema.safeParse({ ...item, compatibility: 'verified' }).success).toBe(false)
    for (const patch of [{ id: 'x' }, { savedAt: 'yesterday' }, { revision: 0 }, { rawBytes: -1 }])
      expect(documentHistoryDetailSchema.safeParse({ ...item, ...patch }).success).toBe(false)
    expect(documentHistoryListResponseSchema.parse({ items: [item], nextCursor: null, canClearHistory: false, total: 1 })).toEqual({ items: [item], nextCursor: null, canClearHistory: false })
  })

  it('清除资格必须由服务端明确返回，清除数量只接受非负整数', () => {
    for (const canClearHistory of [undefined, null, 'true', 1])
      expect(documentHistoryListResponseSchema.safeParse({ items: [], nextCursor: null, canClearHistory }).success).toBe(false)
    for (const canClearHistory of [false, true])
      expect(documentHistoryListResponseSchema.parse({ items: [], nextCursor: null, canClearHistory }).canClearHistory).toBe(canClearHistory)
    for (const cleared of [0, 1, 100])
      expect(clearDocumentHistoryResponseSchema.parse({ cleared })).toEqual({ cleared })
    for (const cleared of [undefined, null, -1, 1.5, '2', Number.POSITIVE_INFINITY])
      expect(clearDocumentHistoryResponseSchema.safeParse({ cleared }).success).toBe(false)
  })

  it('恢复明确要求目标空间和请求标识，标题沿用码点与空白规则，不接收替换原件或正文', () => {
    const request = { requestId: ID, spaceId: ID }
    expect(restoreDocumentHistoryRequestSchema.parse(request)).toEqual(request)
    expect(restoreDocumentHistoryRequestSchema.parse({ ...request, folderId: ID, title: '  历史副本  ' })).toEqual({ ...request, folderId: ID, title: '历史副本' })
    for (const input of [{ requestId: ID }, { spaceId: ID }, { ...request, requestId: 'x' }, { ...request, folderId: 'x' }, { ...request, title: '' }, { ...request, title: '字'.repeat(201) }, { ...request, snapshot: '{}' }, { ...request, overwrite: true }])
      expect(restoreDocumentHistoryRequestSchema.safeParse(input).success).toBe(false)
  })
})

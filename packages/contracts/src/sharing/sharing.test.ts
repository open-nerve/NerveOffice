import { describe, expect, it } from 'vitest'
import { SPACE_ROLES } from '../spaces/spaces.ts'
import {
  documentGrantListResponseSchema,
  documentGrantSchema,
  GRANT_ROLES,
  setDocumentGrantRequestSchema,
  SHARED_PAGE_SIZE,
  sharedListQuerySchema,
  sharedListResponseSchema,
} from './sharing.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c31'
const SPACE_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c32'
const AMY = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c33', username: 'amy', displayName: '艾米' }
const BEN = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c34', username: 'ben', displayName: '本' }

const grant = { user: BEN, status: 'active', role: 'editor', grantedBy: AMY, grantedAt: '2026-10-02T03:00:00.000Z' }

const summary = { id: DOCUMENT_ID, title: '季度预算', type: 'sheet', createdAt: '2026-10-01T01:00:00.000Z', updatedAt: '2026-10-02T02:00:00.000Z' }

describe('单独授权的角色', () => {
  it('查看者与编辑者，是空间角色的一部分（按同样的高低比较），最高只到编辑者', () => {
    expect(GRANT_ROLES).toEqual(['viewer', 'editor'])
    for (const role of GRANT_ROLES)
      expect(SPACE_ROLES, role).toContain(role)
    expect(GRANT_ROLES).not.toContain('admin')
  })
})

describe('设置或调整授权的请求', () => {
  it('只有角色：查看者或编辑者；空间管理员、缺失与多余的字段都拒绝', () => {
    expect(setDocumentGrantRequestSchema.parse({ role: 'viewer' })).toEqual({ role: 'viewer' })
    expect(setDocumentGrantRequestSchema.parse({ role: 'editor' })).toEqual({ role: 'editor' })
    expect(setDocumentGrantRequestSchema.safeParse({ role: 'admin' }).success).toBe(false)
    expect(setDocumentGrantRequestSchema.safeParse({}).success).toBe(false)
    // 被授权人在路径里，不在请求体里；不带 requestId（按状态幂等）
    expect(setDocumentGrantRequestSchema.safeParse({ role: 'viewer', userId: BEN.id }).success).toBe(false)
    expect(setDocumentGrantRequestSchema.safeParse({ role: 'viewer', requestId: DOCUMENT_ID }).success).toBe(false)
  })
})

describe('授权列表', () => {
  it('一条是被授权人（人名与账户状态）、角色、最后设置它的人与时间；多出的字段被丢弃', () => {
    expect(documentGrantListResponseSchema.parse({ items: [{ ...grant, documentId: DOCUMENT_ID }] })).toEqual({ items: [grant] })
  })

  it('停用的被授权人照样列出；人名是"人"的结构：id、登录名、显示名都要有', () => {
    expect(documentGrantSchema.parse({ ...grant, status: 'disabled' }).status).toBe('disabled')
    expect(documentGrantSchema.safeParse({ ...grant, user: { id: BEN.id, displayName: '本' } }).success).toBe(false)
    expect(documentGrantSchema.safeParse({ ...grant, grantedBy: { id: AMY.id, username: 'amy' } }).success).toBe(false)
  })

  it('角色只有查看者与编辑者；时间是 UTC 的 ISO 8601', () => {
    expect(documentGrantSchema.safeParse({ ...grant, role: 'admin' }).success).toBe(false)
    expect(documentGrantSchema.safeParse({ ...grant, grantedAt: '2026-10-02 03:00' }).success).toBe(false)
  })
})

describe('"与我共享"', () => {
  it('查询只有游标；每页条数固定，不由客户端指定', () => {
    expect(sharedListQuerySchema.parse({})).toEqual({})
    expect(sharedListQuerySchema.parse({ cursor: 'abc' })).toEqual({ cursor: 'abc' })
    expect(SHARED_PAGE_SIZE).toBe(50)
    expect(sharedListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
    expect(sharedListQuerySchema.safeParse({ limit: 10 }).success).toBe(false)
  })

  it('团队空间里的一份：空间带名称；我的内容权限', () => {
    const item = { ...summary, space: { id: SPACE_ID, type: 'team', name: '市场部' }, contentRole: 'viewer' }
    expect(sharedListResponseSchema.parse({ items: [item], nextCursor: 'abc' })).toEqual({ items: [item], nextCursor: 'abc' })
  })

  it('个人空间里的一份：空间带所有者（"人"的结构），不带存的名称（建号时的显示名，可以伪造）', () => {
    const item = { ...summary, space: { id: SPACE_ID, type: 'personal', owner: AMY }, contentRole: 'editor' }
    expect(sharedListResponseSchema.parse({ items: [item], nextCursor: null }).items).toEqual([item])
    const parsed = sharedListResponseSchema.parse({ items: [{ ...item, space: { ...item.space, name: '艾米（管理员）' } }], nextCursor: null })
    expect(parsed.items[0]?.space).toEqual({ id: SPACE_ID, type: 'personal', owner: AMY })
    // 个人空间没有所有者、团队空间没有名称都不合法
    expect(sharedListResponseSchema.safeParse({ items: [{ ...item, space: { id: SPACE_ID, type: 'personal', name: '艾米' } }], nextCursor: null }).success).toBe(false)
    expect(sharedListResponseSchema.safeParse({ items: [{ ...item, space: { id: SPACE_ID, type: 'team', owner: AMY } }], nextCursor: null }).success).toBe(false)
  })

  it('不带目录结构：文件夹与路径被丢弃；内容权限按空间角色的取值（空间管理员本人另有授权时是 admin）', () => {
    const item = { ...summary, space: { id: SPACE_ID, type: 'team', name: '市场部' }, contentRole: 'admin' }
    const [parsed] = sharedListResponseSchema.parse({ items: [{ ...item, folderId: DOCUMENT_ID, folderPath: ['资料'] }], nextCursor: null }).items
    expect(parsed).toEqual(item)
    expect(sharedListResponseSchema.safeParse({ items: [{ ...item, contentRole: 'owner' }], nextCursor: null }).success).toBe(false)
    expect(sharedListResponseSchema.safeParse({ items: [{ ...item, contentRole: undefined }], nextCursor: null }).success).toBe(false)
  })
})

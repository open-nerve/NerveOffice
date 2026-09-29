import { describe, expect, it } from 'vitest'
import {
  adminSpaceListQuerySchema,
  adminSpaceSchema,
  adminUserDocumentListResponseSchema,
  adminUserListQuerySchema,
  changeSpaceVisibilityRequestSchema,
  changeSystemRoleRequestSchema,
  createInvitationRequestSchema,
  createTeamSpaceRequestSchema,
  invitationListQuerySchema,
  invitationSchema,
  TRANSFER_MAX_DOCUMENTS,
  transferDocumentsRequestSchema,
} from './admin.ts'

describe('管理界面的契约', () => {
  it('账户列表：关键词去掉首尾空白，状态只能是有效或停用', () => {
    expect(adminUserListQuerySchema.parse({ query: ' 张 ', status: 'disabled' })).toEqual({ query: '张', status: 'disabled' })
    expect(adminUserListQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false)
    expect(adminUserListQuerySchema.safeParse({ query: 'x'.repeat(65) }).success).toBe(false)
    expect(adminUserListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })

  it('系统角色只能是管理员或成员', () => {
    expect(changeSystemRoleRequestSchema.safeParse({ systemRole: 'admin' }).success).toBe(true)
    expect(changeSystemRoleRequestSchema.safeParse({ systemRole: 'owner' }).success).toBe(false)
  })

  it('签发邀请：登录名按规范写法规范化，显示名按设置时的规则', () => {
    expect(createInvitationRequestSchema.parse({ username: ' Zhang.San ', displayName: ' 张三 ' })).toEqual({ username: 'zhang.san', displayName: '张三' })
    expect(createInvitationRequestSchema.safeParse({ username: '张三', displayName: '张三' }).success).toBe(false)
    expect(createInvitationRequestSchema.safeParse({ username: 'zhangsan', displayName: '' }).success).toBe(false)
  })

  it('邀请的状态：待接受、已接受、已过期、已作废', () => {
    for (const status of ['pending', 'accepted', 'expired', 'revoked'])
      expect(invitationListQuerySchema.safeParse({ status }).success).toBe(true)
    expect(invitationListQuerySchema.safeParse({ status: 'used' }).success).toBe(false)
  })

  it('邀请的响应不含令牌：多出来的字段被丢弃', () => {
    const invitation = invitationSchema.parse({
      id: '0192f0c8-0000-7000-8000-000000000001',
      username: 'zhangsan',
      displayName: '张三',
      status: 'pending',
      createdAt: '2026-09-28T00:00:00Z',
      expiresAt: '2026-10-05T00:00:00Z',
      createdBy: { id: '0192f0c8-0000-7000-8000-000000000002', username: 'admin', displayName: '管理员' },
      acceptedAt: null,
      revokedAt: null,
      superseded: false,
      token: 'secret',
    })
    expect(invitation).not.toHaveProperty('token')
  })
})

describe('团队空间的管理', () => {
  const USER_ID = '0192f0c8-0000-7000-8000-000000000001'

  it('创建：名称按规则去掉首尾空白，首个空间管理员与全员可见都必填', () => {
    expect(createTeamSpaceRequestSchema.parse({ name: ' 市场部 ', adminUserId: USER_ID, visibleToAll: false }))
      .toEqual({ name: '市场部', adminUserId: USER_ID, visibleToAll: false })
    expect(createTeamSpaceRequestSchema.safeParse({ name: '市场部', adminUserId: USER_ID }).success).toBe(false)
    expect(createTeamSpaceRequestSchema.safeParse({ name: '', adminUserId: USER_ID, visibleToAll: false }).success).toBe(false)
    expect(createTeamSpaceRequestSchema.safeParse({ name: '市场部', adminUserId: USER_ID, visibleToAll: false, type: 'personal' }).success).toBe(false)
  })

  it('全员可见的开关只有一个布尔值', () => {
    expect(changeSpaceVisibilityRequestSchema.safeParse({ visibleToAll: true }).success).toBe(true)
    expect(changeSpaceVisibilityRequestSchema.safeParse({ visibleToAll: 'true' }).success).toBe(false)
  })

  it('列表：关键词去掉首尾空白，状态只能是正常或归档', () => {
    expect(adminSpaceListQuerySchema.parse({ query: ' 市场 ', status: 'archived' })).toEqual({ query: '市场', status: 'archived' })
    expect(adminSpaceListQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false)
  })

  it('没有加入的空间，我的角色为空', () => {
    const space = { id: USER_ID, name: '市场部', status: 'active', visibleToAll: false, memberCount: 0, createdAt: '2026-09-29T00:00:00.000Z', myRole: null }
    expect(adminSpaceSchema.parse(space)).toEqual(space)
    expect(adminSpaceSchema.safeParse({ ...space, myRole: 'owner' }).success).toBe(false)
  })
})

describe('停用者文档的转移', () => {
  const ids = Array.from({ length: TRANSFER_MAX_DOCUMENTS + 1 }, (_, index) => `0192f0c8-0000-7000-8000-${String(index).padStart(12, '0')}`)
  const team = { type: 'team', spaceId: '0192f0c8-0000-7000-8000-00000000aaaa' }

  it('标题列表只有标题、类型与更新时间：多出的字段（例如内容）被丢弃', () => {
    const item = { id: ids[0], title: '周报', type: 'sheet', updatedAt: '2026-09-29T00:00:00.000Z' }
    expect(adminUserDocumentListResponseSchema.parse({ items: [{ ...item, snapshot: 'x' }], nextCursor: null })).toEqual({ items: [item], nextCursor: null })
  })

  it('一次 1–100 份，不能重复（大小写不同的同一个 id 也算重复）', () => {
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: ids.slice(0, TRANSFER_MAX_DOCUMENTS), target: team }).success).toBe(true)
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: ids, target: team }).success).toBe(false)
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: [], target: team }).success).toBe(false)
    const upper = '0192F0C8-0000-7000-8000-00000000000A'
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: [upper, upper.toLowerCase()], target: team }).success).toBe(false)
  })

  it('目标是某人的个人空间或某个团队空间', () => {
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: [ids[0]], target: { type: 'personal', userId: ids[1] } }).success).toBe(true)
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: [ids[0]], target: { type: 'personal', spaceId: ids[1] } }).success).toBe(false)
    expect(transferDocumentsRequestSchema.safeParse({ documentIds: [ids[0]], target: { type: 'folder', spaceId: ids[1] } }).success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  adminUserListQuerySchema,
  changeSystemRoleRequestSchema,
  createInvitationRequestSchema,
  invitationListQuerySchema,
  invitationSchema,
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

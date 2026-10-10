import { describe, expect, it } from 'vitest'
import { changePasswordRequestSchema, loginRequestSchema, sessionResponseSchema } from './auth.ts'

describe('登录请求', () => {
  it('只限制长度：不向外透露用户名与密码的规则', () => {
    expect(loginRequestSchema.safeParse({ username: 'A B', password: 'x' }).success).toBe(true)
    expect(loginRequestSchema.safeParse({ username: '', password: 'x' }).success).toBe(false)
    expect(loginRequestSchema.safeParse({ username: 'a', password: '' }).success).toBe(false)
    expect(loginRequestSchema.safeParse({ username: 'a'.repeat(65), password: 'x' }).success).toBe(false)
    expect(loginRequestSchema.safeParse({ username: 'a', password: 'x'.repeat(1025) }).success).toBe(false)
  })

  it('不接受多余的字段', () => {
    expect(loginRequestSchema.safeParse({ username: 'a', password: 'x', remember: true }).success).toBe(false)
  })
})

describe('会话信息', () => {
  const identity = {
    user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'admin', displayName: '管理员', systemRole: 'admin' },
    personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '管理员' },
    csrfToken: 'token',
  }

  it.each([true, false])('服务端给出的本机草稿能力 %s 被保留，未知能力被丢弃', (localDraftsEnabled) => {
    expect(sessionResponseSchema.parse({ ...identity, features: { localDraftsEnabled, future: true } }))
      .toEqual({ ...identity, features: { localDraftsEnabled } })
  })

  it('旧后端没有能力字段时关闭本机草稿，不猜测为开启', () => {
    expect(sessionResponseSchema.parse(identity)).toEqual({ ...identity, features: { localDraftsEnabled: false } })
  })

  it.each([null, [], {}, { localDraftsEnabled: 'false' }, { localDraftsEnabled: 0 }, { localDraftsEnabled: null }])('能力形状错误 %j 仍是格式错误', (features) => {
    expect(sessionResponseSchema.safeParse({ ...identity, features }).success).toBe(false)
  })

  it('账户、个人空间与 CSRF 令牌', () => {
    const session = {
      user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'admin', displayName: '管理员', systemRole: 'admin' },
      personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '管理员' },
      csrfToken: 'token',
    }
    expect(sessionResponseSchema.parse(session)).toEqual({ ...session, features: { localDraftsEnabled: false } })
    expect(sessionResponseSchema.safeParse({ ...session, user: { ...session.user, systemRole: 'root' } }).success).toBe(false)
  })

  it('响应多出的字段被丢弃，不算格式错误：接口只做加法时，打开着的旧页面照常工作', () => {
    const session = {
      user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'admin', displayName: '管理员', systemRole: 'admin', avatar: 'x' },
      personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '管理员', quota: 1 },
      csrfToken: 'token',
      features: { localDraftsEnabled: true, future: [] },
    }
    expect(sessionResponseSchema.parse(session)).toEqual({
      user: { id: session.user.id, username: 'admin', displayName: '管理员', systemRole: 'admin' },
      personalSpace: { id: session.personalSpace.id, name: '管理员' },
      csrfToken: 'token',
      features: { localDraftsEnabled: true },
    })
  })
})

describe('修改密码的请求', () => {
  it('旧密码只限制长度，新密码按设置时的规则', () => {
    expect(changePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'n'.repeat(12) }).success).toBe(true)
    expect(changePasswordRequestSchema.safeParse({ currentPassword: '', newPassword: 'n'.repeat(12) }).success).toBe(false)
    expect(changePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success).toBe(false)
    expect(changePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'n'.repeat(12), extra: true }).success).toBe(false)
  })
})

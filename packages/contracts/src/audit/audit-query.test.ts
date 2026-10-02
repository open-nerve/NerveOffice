import { describe, expect, it } from 'vitest'
import { auditEventItemSchema, auditEventQuerySchema } from './audit-query.ts'

describe('审计查询', () => {
  it('条件都是可选的；动作与对象类型只收已知的取值', () => {
    expect(auditEventQuerySchema.parse({})).toEqual({})
    expect(auditEventQuerySchema.safeParse({ action: 'users.disabled', targetType: 'user' }).success).toBe(true)
    expect(auditEventQuerySchema.safeParse({ action: 'users.deleted' }).success).toBe(false)
    expect(auditEventQuerySchema.safeParse({ targetType: 'folder' }).success).toBe(true)
    expect(auditEventQuerySchema.safeParse({ targetType: 'comment' }).success).toBe(false)
  })

  it('时间是 ISO 8601，id 是 UUID；多出来的参数不合法', () => {
    expect(auditEventQuerySchema.safeParse({ from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z' }).success).toBe(true)
    expect(auditEventQuerySchema.safeParse({ from: '2026-09-28' }).success).toBe(false)
    // PostgreSQL 没有 0 年（审查 A4）：1 年可以
    expect(auditEventQuerySchema.safeParse({ from: '0000-01-01T00:00:00Z' }).success).toBe(false)
    expect(auditEventQuerySchema.safeParse({ to: '0000-12-31T23:59:59Z' }).success).toBe(false)
    expect(auditEventQuerySchema.safeParse({ from: '0001-01-01T00:00:00Z' }).success).toBe(true)
    expect(auditEventQuerySchema.safeParse({ actorId: 'admin' }).success).toBe(false)
    expect(auditEventQuerySchema.safeParse({ limit: '10' }).success).toBe(false)
  })

  it('响应宽松：以后新增的动作与对象类型在旧页面上照样能解析', () => {
    const item = auditEventItemSchema.parse({
      id: '0192f0c8-0000-7000-8000-000000000001',
      occurredAt: '2026-09-28T00:00:00Z',
      action: 'spaces.created',
      actor: { type: 'user', id: '0192f0c8-0000-7000-8000-000000000002', username: 'admin', displayName: '管理员' },
      target: { type: 'folder', id: '0192f0c8-0000-7000-8000-000000000003', name: null, user: null },
      source: 'http',
      requestId: 'req-1',
      clientIp: '192.0.2.1',
      details: {},
    })
    expect(item.action).toBe('spaces.created')
  })

  it('对象是账户时登录名与显示名分开给出（M2-P6 复核 M2）：显示名里写的"（登录名）"只是显示名的一部分', () => {
    const item = auditEventItemSchema.parse({
      id: '0192f0c8-0000-7000-8000-000000000001',
      occurredAt: '2026-09-28T00:00:00Z',
      action: 'users.disabled',
      actor: { type: 'user', id: '0192f0c8-0000-7000-8000-000000000002', username: 'admin', displayName: '管理员' },
      target: { type: 'user', id: '0192f0c8-0000-7000-8000-000000000003', name: null, user: { username: 'mallory', displayName: '李四（lisi）' } },
      source: 'http',
      requestId: null,
      clientIp: null,
      details: {},
    })
    expect(item.target?.user).toEqual({ username: 'mallory', displayName: '李四（lisi）' })
    // 新页面要靠它分辨人：缺了它不是合法的响应
    expect(auditEventItemSchema.safeParse({ ...item, target: { type: 'user', id: '0192f0c8-0000-7000-8000-000000000003', name: null } }).success).toBe(false)
  })
})

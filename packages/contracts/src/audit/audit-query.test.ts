import { describe, expect, it } from 'vitest'
import { auditEventItemSchema, auditEventQuerySchema } from './audit-query.ts'

describe('审计查询', () => {
  it('条件都是可选的；动作与对象类型只收已知的取值', () => {
    expect(auditEventQuerySchema.parse({})).toEqual({})
    expect(auditEventQuerySchema.safeParse({ action: 'users.disabled', targetType: 'user' }).success).toBe(true)
    expect(auditEventQuerySchema.safeParse({ action: 'users.deleted' }).success).toBe(false)
    expect(auditEventQuerySchema.safeParse({ targetType: 'folder' }).success).toBe(false)
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
      target: { type: 'folder', id: '0192f0c8-0000-7000-8000-000000000003', label: null },
      source: 'http',
      requestId: 'req-1',
      clientIp: '192.0.2.1',
      details: {},
    })
    expect(item.action).toBe('spaces.created')
  })
})

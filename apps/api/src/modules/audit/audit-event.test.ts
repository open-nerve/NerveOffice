import { describe, expect, it } from 'vitest'
import { auditEventSchema } from './audit-event.ts'

const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const base = { action: 'documents.created', actor: { type: 'user', id: USER_ID }, origin: { source: 'http', requestId: 'req-1', clientIp: '127.0.0.1' } } as const

describe('审计事件的校验', () => {
  it('接受合法的事件', () => {
    expect(auditEventSchema.parse({ ...base, target: { type: 'document', id: USER_ID }, details: { title: '周报' } })).toMatchObject(base)
    expect(auditEventSchema.parse({ action: 'users.admin_initialized', actor: { type: 'system' }, origin: { source: 'cli' } })).toBeDefined()
  })

  it.each([
    ['未登记的动作', { ...base, action: 'documents.archived' }],
    ['用户操作者没有 id', { ...base, actor: { type: 'user' } }],
    ['系统操作者带 id', { ...base, actor: { type: 'system', id: USER_ID } }],
    ['id 不是 UUID', { ...base, actor: { type: 'user', id: '42' } }],
    ['未登记的对象类型', { ...base, target: { type: 'comment', id: USER_ID } }],
    ['HTTP 来源没有请求标识', { ...base, origin: { source: 'http' } }],
    ['命令行来源带客户端地址', { ...base, origin: { source: 'cli', clientIp: '127.0.0.1' } }],
    ['客户端地址不合法', { ...base, origin: { source: 'http', requestId: 'r', clientIp: 'localhost' } }],
    ['多余的字段', { ...base, extra: 1 }],
  ])('拒绝%s', (_case, event) => {
    expect(auditEventSchema.safeParse(event).success).toBe(false)
  })

  it('details 按 JSON 文本计不超过 4 KiB', () => {
    expect(auditEventSchema.safeParse({ ...base, details: { text: 'x'.repeat(4_000) } }).success).toBe(true)
    expect(auditEventSchema.safeParse({ ...base, details: { text: 'x'.repeat(4_100) } }).success).toBe(false)
  })

  // 数组与嵌套对象的长度没有上界，很容易越过字节上限，而审计与业务写在同一个事务里：
  // 那会把整条业务事务一起回滚成 500（M2-P4 审查 A1）。在写入口就挡住，不靠每个调用点自觉
  it('details 的值只收标量：字符串、数字、布尔、null', () => {
    expect(auditEventSchema.safeParse({ ...base, details: { title: '周报', folders: 2, movedToRoot: false, parentId: null } }).success).toBe(true)
  })

  it.each([
    ['数组', { ids: ['a', 'b'] }],
    ['空数组', { ids: [] }],
    ['嵌套对象', { from: { name: '周报' } }],
  ])('details 的值不收%s', (_case, details) => {
    expect(auditEventSchema.safeParse({ ...base, details }).success).toBe(false)
  })
})

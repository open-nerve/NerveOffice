import type { AuditEvent } from './audit-event.ts'
import { describe, expect, it } from 'vitest'
import { parseAuditEvent } from './audit-event.ts'

const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const SPACE_ID = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'
const base = { action: 'documents.created', actor: { type: 'user', id: USER_ID }, origin: { source: 'http', requestId: 'req-1', clientIp: '127.0.0.1' }, details: { revision: 1, folderId: null } } as const

/** 不合法的事件：绕过类型检查，模拟调用方写错了 */
function parses(event: unknown): boolean {
  try {
    parseAuditEvent(event as AuditEvent)
    return true
  }
  catch {
    return false
  }
}

describe('审计事件的校验', () => {
  it('接受合法的事件；明细里没有必填字段的动作可以不给 details（按空对象写入）', () => {
    expect(parseAuditEvent({ ...base, target: { type: 'document', id: USER_ID } })).toMatchObject(base)
    expect(parseAuditEvent({ action: 'users.disabled', actor: { type: 'system' }, origin: { source: 'cli' } })).toMatchObject({ details: {} })
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
    ['明细少了必填的字段', { ...base, details: { revision: 1 } }],
    ['明细的类型不对', { ...base, details: { revision: 1, folderId: 'x' } }],
  ])('拒绝%s', (_case, event) => {
    expect(parses(event)).toBe(false)
  })

  // 明细按动作的严格结构（M2-P6 复核 M-1）：多出来的键写不进去，标题与名称因此进不了审计
  it.each([
    ['文档改名带着标题', { action: 'documents.renamed', details: { spaceId: SPACE_ID, folderId: null, from: '周报', to: '月报' } }],
    ['新建文件夹带着名称', { action: 'folders.created', details: { spaceId: SPACE_ID, parentId: null, name: '资料' } }],
    ['永久删除带着标题', { action: 'documents.purged', details: { spaceId: SPACE_ID, trashEntryId: USER_ID, folders: 0, documents: 1, cascadedEntries: 0, title: '周报' } }],
    ['没有明细的动作带着明细', { action: 'users.disabled', details: { title: '周报' } }],
  ])('拒绝%s', (_case, event) => {
    expect(parses({ actor: { type: 'user', id: USER_ID }, origin: { source: 'cli' }, ...event })).toBe(false)
  })

  it('同一个动作换一个结构正确的明细就接受', () => {
    expect(parses({ action: 'documents.renamed', actor: { type: 'user', id: USER_ID }, origin: { source: 'cli' }, details: { spaceId: SPACE_ID, folderId: null } })).toBe(true)
  })
})

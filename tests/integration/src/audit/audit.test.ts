// 审计（P2 设计 §3.8）：经真实应用写入、只追加由数据库保证、CHECK 约束兜底、与业务写入同一个事务。
import type { AuditOrigin } from '@nerve-office/api'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { AuditModule, AuditService, RequestOrigin, TransactionRunner } from '@nerve-office/api'
import { AUDIT_ACTIONS } from '@nerve-office/contracts'
import { Controller, Module, Post } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'

const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const DOCUMENT_ID = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'

@Controller('__test/audit')
class AuditProbeController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  async record(@RequestOrigin() origin: AuditOrigin): Promise<void> {
    await this.audit.record({
      action: 'documents.created',
      actor: { type: 'user', id: USER_ID },
      target: { type: 'document', id: DOCUMENT_ID },
      origin,
      details: { title: '周报' },
    })
  }
}

@Module({ imports: [AuditModule], controllers: [AuditProbeController] })
class AuditProbeModule {}

interface AuditRow {
  id: string
  occurred_at: Date
  action: string
  actor_type: string
  actor_id: string | null
  target_type: string | null
  target_id: string | null
  source: string
  request_id: string | null
  client_ip: string | null
  details: unknown
}

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ env: { NERVE_DATABASE_URL: database.url }, additionalModules: [AuditProbeModule] })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function rows(where = 'true'): Promise<AuditRow[]> {
  return database.query(async client => (await client.query<AuditRow>(`SELECT * FROM audit_events WHERE ${where} ORDER BY occurred_at, id`)).rows)
}

describe('审计事件', () => {
  it('经 HTTP 写入：动作、操作者、对象、来源（请求标识与客户端地址）、数据库时间', async () => {
    const before = await database.query(async client => (await client.query<{ now: Date }>('SELECT now()')).rows[0]?.now)
    const response = await fetch(`${app.baseUrl}/api/__test/audit`, { method: 'POST', headers: { 'x-request-id': 'audit-req-1' } })
    expect(response.status).toBe(201)
    const [row] = await rows('request_id = \'audit-req-1\'')
    expect(row).toMatchObject({
      action: 'documents.created',
      actor_type: 'user',
      actor_id: USER_ID,
      target_type: 'document',
      target_id: DOCUMENT_ID,
      source: 'http',
      client_ip: '127.0.0.1',
      details: { title: '周报' },
    })
    // 主键是 PostgreSQL 18 的 uuidv7()（第 13 位是版本号 7），时间取自数据库
    expect(row?.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-/)
    expect(row?.occurred_at.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? Number.POSITIVE_INFINITY)
  })

  it('命令行来源：没有请求标识与客户端地址', async () => {
    await app.runtime.get(AuditService).record({ action: 'users.admin_initialized', actor: { type: 'system' }, origin: { source: 'cli' } })
    expect(await rows('action = \'users.admin_initialized\'')).toMatchObject([{ actor_type: 'system', actor_id: null, source: 'cli', request_id: null, client_ip: null, details: {} }])
  })

  it('事件不合法时直接抛出，不写入', async () => {
    const count = (await rows()).length
    await expect(app.runtime.get(AuditService).record({ action: 'documents.created', actor: { type: 'user', id: '42' }, origin: { source: 'cli' } })).rejects.toThrow()
    expect(await rows()).toHaveLength(count)
  })

  it('只追加：更新、删除、清空都被数据库拒绝', async () => {
    await database.query(async (client) => {
      await expect(client.query('UPDATE audit_events SET details = \'{}\'::jsonb')).rejects.toThrow('只追加')
      await expect(client.query('DELETE FROM audit_events')).rejects.toThrow('只追加')
      await expect(client.query('TRUNCATE audit_events')).rejects.toThrow('只追加')
    })
    expect((await rows()).length).toBeGreaterThan(0)
  })

  it.each([
    ['未登记的动作', '(\'documents.deleted\', \'system\', NULL, \'cli\', NULL, NULL)'],
    ['用户操作者没有 id', '(\'auth.logout\', \'user\', NULL, \'cli\', NULL, NULL)'],
    ['HTTP 来源没有请求标识', '(\'auth.logout\', \'system\', NULL, \'http\', NULL, NULL)'],
    ['命令行来源带客户端地址', '(\'auth.logout\', \'system\', NULL, \'cli\', NULL, \'127.0.0.1\')'],
  ])('CHECK 约束兜底：绕过应用直接写入%s被拒绝', async (_case, values) => {
    await database.query(async (client) => {
      await expect(client.query(`INSERT INTO audit_events (action, actor_type, actor_id, source, request_id, client_ip) VALUES ${values}`)).rejects.toThrow('violates check constraint')
    })
  })

  it('与业务写入放在同一个事务里：事务回滚时，审计也一起回滚；提交时一起写入', async () => {
    const count = (await rows()).length
    const transactions = app.runtime.get(TransactionRunner)
    const audit = app.runtime.get(AuditService)
    const event = { action: 'auth.logout', actor: { type: 'user', id: USER_ID }, origin: { source: 'cli' } } as const
    await expect(transactions.run(async (transaction) => {
      await audit.record(event, { transaction })
      throw new Error('业务写入失败')
    })).rejects.toThrow('业务写入失败')
    expect(await rows()).toHaveLength(count)
    await transactions.run(async (transaction) => {
      await audit.record(event, { transaction })
    })
    expect(await rows()).toHaveLength(count + 1)
  })

  it('每个登记的审计动作都能写入：contracts 的枚举与数据库的 CHECK 约束一致', async () => {
    const audit = app.runtime.get(AuditService)
    for (const action of AUDIT_ACTIONS)
      await audit.record({ action, actor: { type: 'system' }, origin: { source: 'cli' } })
    const written = new Set((await rows()).map(row => row.action))
    expect(AUDIT_ACTIONS.filter(action => !written.has(action))).toEqual([])
  })
})

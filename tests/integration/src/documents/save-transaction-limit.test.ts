// 保存的事务有时限（M3-P5 复验 C1）：撤权的"刚死不久"窗口（一个有效期）靠"保存从开始到提交短于一个有效期"成立（lease-revocation-locks.test.ts），
// 这个上界由数据库保证——保存的事务的第一条语句设下 transaction_timeout（60 秒，documents 的 SAVE_TRANSACTION_TIMEOUT_MS，单元测试钉住它的值），
// 到点时数据库结束会话、整个事务回滚。这里把时限换得很小（包装事务运行器：保存带着时限开启事务时把它换成 SHORT_LIMIT_MS，不加环境变量），
// 让保存停在提交之前（写审计之前的闸门，同 lease-revocation-locks.test.ts）超过它：保存失败、什么也没写，回 503（数据库繁忙），日志的原因是
// transaction_timeout；坏连接被丢弃，同一个连接池（只有一个连接）之后的请求照常，同一份租约接着保存成功。
// 时限要够保存走到闸门上（十来条语句，本机几毫秒；CI 慢几倍也远够），又比等锁的时限（5 秒）短：没有时限的话保存会等满 5 秒、以等锁超时失败
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { TransactionRunner } from '@nerve-office/api'
import { EDIT_LEASE_TTL_SECONDS, REQUEST_ID_HEADER, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, outcomeOf, renewLease, saveContent } from '../support/edit-leases.ts'
import { completesWithoutWaiting, whileHolding } from '../support/held-lock.ts'
import { login } from '../support/session-client.ts'

/** 换小之后的时限 */
const SHORT_LIMIT_MS = 2_000

/** 闸门：每写一条审计之前，按"动作 + 操作者"取一把共享的 advisory lock；测试持有同一个键的排他锁时，那个操作停在这里 */
const GATE_DDL = `
CREATE FUNCTION audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('audit-gate:' || NEW.action || ':' || coalesce(NEW.actor_id::text, 'system'), 0));
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_gate();
`

let database: TestDatabase
let app: TestApp
let holder: TestAccount
let session: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(GATE_DDL))
  // 连接池只有一个连接：被数据库结束的那个连接要是没被丢弃，之后的请求都会失败
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_POOL_MAX: '1' } })
  holder = await createAccount(database, { username: 'save-limit-holder' })
  session = await login(app.baseUrl, holder.username, holder.password)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await app.close()
  await database.drop()
})

async function save(document: SeededDocument, lease: HeldLease): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, session, document.id, zlib.gzipSync(raw), { baseRevision: 1, lease })
}

/** 这份文档的修订号、修订记录的条数、保存的审计条数与回执的条数 */
async function writesOf(documentId: string): Promise<{ readonly revision: number | undefined, readonly revisions: number, readonly saves: number, readonly receipts: number }> {
  return database.query(async client => ({
    revision: (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision,
    revisions: Number((await client.query<{ count: string }>('SELECT count(*) FROM document_revisions WHERE document_id = $1', [documentId])).rows[0]?.count),
    saves: Number((await client.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = \'documents.content_saved\'', [documentId])).rows[0]?.count),
    receipts: Number((await client.query<{ count: string }>('SELECT count(*) FROM document_save_receipts WHERE document_id = $1', [documentId])).rows[0]?.count),
  }))
}

/**
 * 保存带着时限开启的事务：把时限换成 SHORT_LIMIT_MS（不加环境变量）。不带时限的事务（申请、心跳、会话）原样执行。
 * 交回保存带来的时限（换小之前的），用完 mockRestore
 */
function shortenSaveLimit(): { readonly requested: number[], readonly restore: () => void } {
  const runner = app.runtime.get(TransactionRunner)
  const run = runner.run.bind(runner)
  const requested: number[] = []
  const spy = vi.spyOn(runner, 'run').mockImplementation(async (work: Parameters<typeof run>[0], options?: Parameters<typeof run>[1]) => {
    if (options?.timeoutMs === undefined)
      return run(work, options)
    requested.push(options.timeoutMs)
    return run(work, { ...options, timeoutMs: SHORT_LIMIT_MS })
  })
  return { requested, restore: () => spy.mockRestore() }
}

describe('US-M3-12 保存的事务有时限，由数据库保证（M3-P5 复验 C1）', () => {
  it('US-M3-12 保存停在提交之前（写审计之前）超过事务的时限：数据库结束会话、整个事务回滚——什么也没写，回 503（数据库繁忙，原因 transaction_timeout）；坏连接被丢弃，同一个连接池之后的请求照常，同一份租约接着保存成功', async () => {
    const document = await seedDocument(database, { spaceId: holder.personalSpaceId, createdBy: holder.id, title: '限时的保存' })
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const limit = shortenSaveLimit()
    let response: Response
    try {
      response = await whileHolding(
        database,
        async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:documents.content_saved:${holder.id}`]),
        async () => {
          const saving = save(document, lease)
          // 先走到闸门上：修订记录、修订号与内容都已写进这个事务，在写审计之前等锁；之后由数据库按时限结束它（测试一直持着闸门）
          expect(await completesWithoutWaiting(database, saving, 1)).toBe(false)
          return saving
        },
      )
    }
    finally {
      limit.restore()
    }
    // 保存带着时限开启事务（换小之前的那个比一个有效期短）
    expect(limit.requested).toHaveLength(1)
    expect(limit.requested[0]).toBeLessThan(EDIT_LEASE_TTL_SECONDS * 1000)

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
    const requestId = response.headers.get(REQUEST_ID_HEADER)
    const busy = app.logs.entries().find(line => line.requestId === requestId && line.reason === 'transaction_timeout')
    expect(busy).toMatchObject({ level: 'warn', msg: '数据库繁忙，回 503 让客户端稍后重试' })
    expect(JSON.stringify(busy)).toContain('"sqlState":"25P04"')
    expect(await writesOf(document.id)).toEqual({ revision: 1, revisions: 1, saves: 0, receipts: 0 })

    // 被结束的连接已经丢弃：同一个连接池（只有一个连接）之后的心跳、保存照常；租约没被碰过，同一份租约接着保存
    expect(await outcomeOf(await renewLease(app.baseUrl, session, document.id, lease))).toBe('200')
    expect(await outcomeOf(await save(document, lease))).toBe('200')
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1, receipts: 0 })
  })
})

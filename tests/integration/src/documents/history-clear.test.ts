import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { AuditService, TransactionRunner } from '@nerve-office/api'
import { DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let owner: TestAccount
let session: LoggedIn
let at: Date
beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(`
    CREATE FUNCTION history_clear_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('history-clear-gate:' || NEW.action, 0));
      RETURN NEW;
    END $$;
    CREATE TRIGGER history_clear_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION history_clear_gate();
  `))
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createAccount(database, { username: 'history-clear-owner', systemRole: 'admin' })
  session = await login(app.baseUrl, owner.username, owner.password)
})
beforeEach(() => {
  at = new Date('2026-10-22T08:00:00Z')
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

const source = async () => seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '清除后保留原件' })
const clear = async (id: string) => asUser(app.baseUrl, session, `/api/documents/${id}/history`, { method: 'DELETE' })

async function preserved(id: string) {
  return database.query(async client => (await client.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'document',to_jsonb(d), 'content',to_jsonb(c),
    'links',(SELECT jsonb_agg(l ORDER BY l.asset_id) FROM document_asset_links l WHERE l.document_id=d.id),
    'revisions',(SELECT jsonb_agg(r ORDER BY r.revision) FROM document_revisions r WHERE r.document_id=d.id),
    'receipts',(SELECT jsonb_agg(r ORDER BY r.request_id) FROM document_save_receipts r WHERE r.document_id=d.id),
    'leases',(SELECT jsonb_agg(l) FROM document_edit_leases l WHERE l.document_id=d.id),
    'buckets',(SELECT jsonb_agg(b ORDER BY b.hour_bucket) FROM document_history_buckets b WHERE b.document_id=d.id),
    'ops',(SELECT jsonb_agg(h ORDER BY h.id) FROM document_checkpoints h WHERE h.source_document_id=d.id AND h.kind <> 'hourly')
    ) AS state FROM documents d JOIN document_contents c ON c.document_id=d.id WHERE d.id=$1`, [id])).rows[0]!.state)
}

async function histories(id: string) {
  return database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_checkpoints WHERE source_document_id=$1 AND kind=\'hourly\' ORDER BY id', [id])).rows.map(row => row.id))
}

describe('US-M5-11 管理员清除用户历史', () => {
  it('清除有效与过期 hourly；当前正文、图片、租约、回执、桶、运维检查点与其他源保持原样', async () => {
    const doc = await source()
    const asset = await uploadTestAsset(app.baseUrl, session)
    const bytes = gzipSync(Buffer.from(JSON.stringify({ ...JSON.parse(pageSnapshot(doc.unitId, '当前内容保留').toString('utf8')) as Record<string, unknown>, images: [`/api/assets/${asset.assetId}`] })))
    expect((await saveContent(app.baseUrl, session, doc.id, bytes, { baseRevision: 1 })).status).toBe(200)
    at = new Date('2026-10-30T08:00:00Z')
    await captureHistory(app, doc.id)
    const removed = await histories(doc.id)
    expect(removed).toHaveLength(2)
    await app.runtime.get(TransactionRunner).run(async (tx) => {
      await app.runtime.get(DocumentsRepository).lockById(doc.id, tx)
      for (const kind of ['before_delete', 'before_upgrade'] as const)
        await app.runtime.get(DocumentCheckpointService).captureOperation(doc.id, kind, randomUUID(), tx)
    })
    const other = await source()
    const foreign = await captureHistory(app, other.id)
    const lease = await acquireLease(app.baseUrl, session, doc.id)
    try {
      const before = await preserved(doc.id)
      const response = await clear(doc.id)
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toEqual({ cleared: 2 })
      expect(await preserved(doc.id)).toEqual(before)
      expect(await histories(doc.id)).toEqual([])
      expect(await histories(other.id)).toEqual([foreign])
      const links = await database.query(async client => (await client.query<{ checkpoint_id: string }>('SELECT checkpoint_id FROM document_checkpoint_assets WHERE checkpoint_id=ANY($1::uuid[])', [removed])).rows)
      expect(links).toEqual([])
      const audit = await database.query(async client => (await client.query<{ actor_id: string, details: unknown }>('SELECT actor_id,details FROM audit_events WHERE action=\'documents.history_cleared\' AND target_id=$1', [doc.id])).rows)
      expect(audit).toEqual([{ actor_id: owner.id, details: { spaceId: owner.personalSpaceId, cleared: 2 } }])
      const image = await asUser(app.baseUrl, session, `/api/assets/${asset.assetId}`)
      expect(image.headers.get('x-asset-status')).toBe('200')
      await image.arrayBuffer()
      const sampledAgain = await app.runtime.get(TransactionRunner).run(async (tx) => {
        await app.runtime.get(DocumentsRepository).lockById(doc.id, tx)
        return app.runtime.get(DocumentCheckpointService).captureHourly(doc.id, tx)
      })
      expect(sampledAgain).toBeUndefined()
      const changed = gzipSync(Buffer.from(pageSnapshot(doc.unitId, '清除后原页继续编辑')))
      expect((await saveContent(app.baseUrl, session, doc.id, changed, { baseRevision: 2, lease })).status).toBe(200)
      expect(await histories(doc.id)).toEqual([])
    }
    finally {
      await releaseLease(app.baseUrl, session, doc.id, lease)
    }
  })

  it('没有历史仍准确返回零并记录本次意图', async () => {
    const doc = await source()
    const response = await clear(doc.id)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ cleared: 0 })
    const audits = await database.query(async client => (await client.query<{ details: unknown }>('SELECT details FROM audit_events WHERE action=\'documents.history_cleared\' AND target_id=$1', [doc.id])).rows)
    expect(audits).toEqual([{ details: { spaceId: owner.personalSpaceId, cleared: 0 } }])
  })

  it('审计落库后故障使清除与审计一起回滚', async () => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const audit = app.runtime.get(AuditService)
    const record = audit.record.bind(audit)
    vi.spyOn(audit, 'record').mockImplementationOnce(async (...args) => {
      await record(...args)
      throw new Error('清除审计后的故障')
    })
    expect((await clear(doc.id)).status).toBe(500)
    expect(await histories(doc.id)).toEqual([history])
    const audits = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM audit_events WHERE action=\'documents.history_cleared\' AND target_id=$1', [doc.id])).rows)
    expect(audits).toEqual([])
    expect((await clear(doc.id)).status).toBe(200)
    expect(await histories(doc.id)).toEqual([])
  })

  it.each(['降级', '移出', '归档', '跨空间移动'] as const)('等待锁时%s：重新核对资格与所在空间，旧历史保持', async (change) => {
    const spaceId = await createTeamSpace(database, { name: `清除交错 ${change}`, createdBy: owner.id, members: { [owner.id]: 'admin' } })
    const doc = await seedDocument(database, { spaceId, createdBy: owner.id, title: '等待期间保留的历史' })
    const history = await captureHistory(app, doc.id)
    const result = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [spaceId]),
      request: async () => clear(doc.id),
      change: async (client) => {
        if (change === '降级')
          await client.query('UPDATE space_members SET role=\'editor\' WHERE space_id=$1 AND user_id=$2', [spaceId, owner.id])
        else if (change === '移出')
          await client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, owner.id])
        else if (change === '归档')
          await client.query('UPDATE spaces SET status=\'archived\' WHERE id=$1', [spaceId])
        else
          await client.query('UPDATE documents SET space_id=$2 WHERE id=$1', [doc.id, owner.personalSpaceId])
      },
    })
    expect(result.status, await result.clone().text()).toBe(['降级', '归档'].includes(change) ? 403 : 404)
    expect(await histories(doc.id)).toEqual([history])
  })

  it.each(['恢复先持锁', '清除先持锁'] as const)('%s：同一个历史只按锁序恢复或拒绝，不出现半份副本', async (order) => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const restore = async () => asUser(app.baseUrl, session, `/api/documents/${doc.id}/history/${history}/restore`, {
      method: 'POST',
      body: { requestId: randomUUID(), spaceId: owner.personalSpaceId },
    })
    const restoringFirst = order === '恢复先持锁'
    const firstAction = restoringFirst ? 'documents.history_restored' : 'documents.history_cleared'
    const results = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`history-clear-gate:${firstAction}`]),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const first = step(restoringFirst ? restore() : clear(doc.id))
        await waitForWaiting(1)
        const second = step(restoringFirst ? clear(doc.id) : restore())
        return Promise.all([first, second])
      },
      change: async () => {},
    })
    expect(results.map(result => result.status)).toEqual(restoringFirst ? [201, 200] : [200, 404])
    expect(await histories(doc.id)).toEqual([])
    if (restoringFirst) {
      const copy = await results[0].json() as { id: string }
      expect(copy.id).not.toBe(doc.id)
      expect((await asUser(app.baseUrl, session, `/api/documents/${copy.id}/content`)).status).toBe(200)
    }
    const count = await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_events WHERE action=\'documents.history_restored\' AND details->>\'sourceId\'=$1', [doc.id])).rows[0]!.count)
    expect(count).toBe(restoringFirst ? 1 : 0)
  })
})

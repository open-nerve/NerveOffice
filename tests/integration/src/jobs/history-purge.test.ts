import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { AuditService, HISTORY_PURGE_LOCK, HistoryPurgeJob, TransactionRunner } from '@nerve-office/api'
import { DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { whileHolding } from '../support/held-lock.ts'
import { login } from '../support/session-client.ts'

const HOUR = 3600_000
const START = Date.parse('2026-10-22T10:20:30.123Z')
let database: TestDatabase
let app: TestApp
let owner: TestAccount
let at: Date
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_HISTORY_PURGE_BATCH: '2' } })
  owner = await createAccount(database, { username: 'history-purge-owner' })
})
beforeEach(async () => {
  await database.query(async (client) => {
    await client.query('DELETE FROM document_checkpoints')
    await client.query('DELETE FROM document_history_buckets')
  })
  at = new Date(START)
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function sample(operations = false) {
  const doc = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '到期清理原件' })
  const history = await captureHistory(app, doc.id)
  const ops: string[] = []
  if (operations) {
    await app.runtime.get(TransactionRunner).run(async (tx) => {
      await app.runtime.get(DocumentsRepository).lockById(doc.id, tx)
      for (const kind of ['before_delete', 'before_upgrade'] as const)
        ops.push((await app.runtime.get(DocumentCheckpointService).captureOperation(doc.id, kind, randomUUID(), tx))!)
    })
  }
  return { doc, history, ops }
}
async function counts() {
  return database.query(async client => (await client.query<{ checkpoints: number, buckets: number }>(`SELECT
    (SELECT count(*)::int FROM document_checkpoints) AS checkpoints,
    (SELECT count(*)::int FROM document_history_buckets) AS buckets`)).rows[0]!)
}
const purge = async (now: number, signal?: AbortSignal) => app.runtime.get(HistoryPurgeJob).runOnce(new Date(now), signal)

describe('US-M5-11 历史与运维检查点的到期清理', () => {
  it('用户历史严格七天到期；桶至少留满七天，保留到下一自然小时才可移除', async () => {
    await sample()
    expect(await purge(START + 168 * HOUR - 1)).toMatchObject({ checkpoints: 0, buckets: 0, ending: 'drained' })
    expect(await counts()).toEqual({ checkpoints: 1, buckets: 1 })
    expect(await purge(START + 168 * HOUR)).toMatchObject({ checkpoints: 1, buckets: 0 })
    expect(await counts()).toEqual({ checkpoints: 0, buckets: 1 })
    expect(await purge(Date.parse('2026-10-29T10:59:59.999Z'))).toMatchObject({ checkpoints: 0, buckets: 0 })
    expect(await purge(Date.parse('2026-10-29T11:00:00.000Z'))).toMatchObject({ checkpoints: 0, buckets: 1 })
  })

  it('两个运维种类严格三十天，到期前不提前删除；当前正文与修订留存', async () => {
    const { doc, ops } = await sample(true)
    await purge(START + 168 * HOUR)
    expect(await purge(START + 720 * HOUR - 1)).toMatchObject({ checkpoints: 0 })
    const remaining = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_checkpoints ORDER BY id')).rows.map(row => row.id))
    expect(remaining.toSorted()).toEqual(ops.toSorted())
    expect(await purge(START + 720 * HOUR)).toMatchObject({ checkpoints: 2, buckets: 0 })
    expect(await counts()).toEqual({ checkpoints: 0, buckets: 0 })
    const current = await database.query(async client => (await client.query<{ revision: number }>('SELECT d.revision FROM documents d JOIN document_contents c ON c.document_id=d.id JOIN document_revisions r ON r.document_id=d.id AND r.revision=d.revision WHERE d.id=$1', [doc.id])).rows)
    expect(current).toEqual([{ revision: 1 }])
  })

  it('逐期释放历史图片关系，当前正文不变；即使完全没有引用也不在本任务删除文件和配额', async () => {
    const session = await login(app.baseUrl, owner.username, owner.password)
    const doc = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '历史独有图片' })
    const asset = await uploadTestAsset(app.baseUrl, session)
    const bytes = gzipSync(Buffer.from(JSON.stringify({ ...JSON.parse(pageSnapshot(doc.unitId, '旧的图片').toString('utf8')) as Record<string, unknown>, images: [`/api/assets/${asset.assetId}`] })))
    expect((await saveContent(app.baseUrl, session, doc.id, bytes, { baseRevision: 1 })).status).toBe(200)
    await app.runtime.get(TransactionRunner).run(async (tx) => {
      await app.runtime.get(DocumentsRepository).lockById(doc.id, tx)
      for (const kind of ['before_delete', 'before_upgrade'] as const)
        await app.runtime.get(DocumentCheckpointService).captureOperation(doc.id, kind, randomUUID(), tx)
    })
    const current = gzipSync(pageSnapshot(doc.unitId, '当前不含图片'))
    expect((await saveContent(app.baseUrl, session, doc.id, current, { baseRevision: 2 })).status).toBe(200)
    const retained = async () => database.query(async client => (await client.query<{ refs: number }>('SELECT count(*)::int AS refs FROM document_checkpoint_assets WHERE asset_id=$1', [asset.assetId])).rows[0]!.refs)
    const object = await database.query(async client => (await client.query<{ storage_key: string }>('SELECT o.storage_key FROM asset_objects o JOIN assets a ON a.object_hash=o.sha256 WHERE a.id=$1', [asset.assetId])).rows[0]!)
    const path = join(testAssetRoot(database.url), object.storage_key)
    const image = await readFile(path)
    const quota = await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes,used_assets FROM asset_quota')).rows)
    expect(await retained()).toBe(3)
    await purge(START + 168 * HOUR)
    expect(await retained()).toBe(2)
    await purge(START + 720 * HOUR)
    expect(await retained()).toBe(0)
    expect(await readFile(path)).toEqual(image)
    expect(await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes,used_assets FROM asset_quota')).rows)).toEqual(quota)
    const body = await database.query(async client => (await client.query<{ snapshot: Buffer }>('SELECT snapshot FROM document_contents WHERE document_id=$1', [doc.id])).rows[0]!.snapshot)
    expect(body).toEqual(current)
  })

  it('有界短批与退出：中止时保留已提交批次，下一轮接着清理', async () => {
    for (let i = 0; i < 5; i++)
      await sample()
    expect(await purge(START + 200 * HOUR, AbortSignal.abort())).toEqual({ ran: true, checkpoints: 2, buckets: 2, batches: 1, ending: 'stopped' })
    expect(await counts()).toEqual({ checkpoints: 3, buckets: 3 })
    expect(await purge(START + 200 * HOUR)).toEqual({ ran: true, checkpoints: 3, buckets: 3, batches: 2, ending: 'drained' })
  })

  it('其他实例持有同一事务锁时一条不删，也不写完成审计', async () => {
    await sample()
    await whileHolding(database, async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [HISTORY_PURGE_LOCK]), async () => expect(await purge(START + 200 * HOUR)).toEqual({ ran: false, checkpoints: 0, buckets: 0, batches: 0, ending: 'contended' }))
    expect(await counts()).toEqual({ checkpoints: 1, buckets: 1 })
  })

  it('被使用的到期历史跳过，同时保留它的桶；不等待源文档锁，下一轮补清', async () => {
    const first = await sample()
    await sample()
    await whileHolding(database, async (client) => {
      await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [first.doc.id])
      await client.query('SELECT id FROM document_checkpoints WHERE id=$1 FOR SHARE', [first.history])
    }, async () => {
      expect(await purge(START + 200 * HOUR)).toMatchObject({ checkpoints: 1, buckets: 1, ending: 'drained' })
      expect(await counts()).toEqual({ checkpoints: 1, buckets: 1 })
    })
    expect(await purge(START + 200 * HOUR)).toMatchObject({ checkpoints: 1, buckets: 1 })
  })

  it('桶被单独锁住时跳过，检查点仍可过期，释放后下一轮只清桶', async () => {
    const { doc } = await sample()
    await whileHolding(database, async client => client.query('SELECT document_id FROM document_history_buckets WHERE document_id=$1 FOR UPDATE', [doc.id]), async () => expect(await purge(START + 200 * HOUR)).toMatchObject({ checkpoints: 1, buckets: 0, ending: 'drained' }))
    expect(await purge(START + 200 * HOUR)).toMatchObject({ checkpoints: 0, buckets: 1 })
  })

  it('审计故障整批回滚；下次可清理，审计只记系统来源和聚合数量', async () => {
    await sample()
    const audit = app.runtime.get(AuditService)
    const record = audit.record.bind(audit)
    vi.spyOn(audit, 'record').mockImplementationOnce(async (...args) => {
      await record(...args)
      throw new Error('历史清理审计写后故障')
    })
    expect(await purge(START + 200 * HOUR)).toEqual({ ran: true, checkpoints: 0, buckets: 0, batches: 0, ending: 'failed' })
    expect(await counts()).toEqual({ checkpoints: 1, buckets: 1 })
    expect(await purge(START + 200 * HOUR)).toMatchObject({ checkpoints: 1, buckets: 1, ending: 'drained' })
    const auditRow = await database.query(async client => (await client.query<{ actor_type: string, source: string, target_id: string | null, details: unknown }>('SELECT actor_type,source,target_id,details FROM audit_events WHERE action=\'documents.checkpoints_expired\' ORDER BY occurred_at DESC,id DESC LIMIT 1')).rows[0])
    expect(auditRow).toEqual({ actor_type: 'system', source: 'job', target_id: null, details: { checkpoints: 1, buckets: 1 } })
  })

  it('真实调度器自动使用数据库现在时刻，关闭开关只停任务', async () => {
    at = new Date(Date.now() - 31 * 24 * HOUR)
    await sample(true)
    const timed = await startTestApp({ databaseUrl: database.url, env: { NERVE_HISTORY_PURGE_ENABLED: 'true', NERVE_HISTORY_PURGE_INTERVAL_MS: '1000' } })
    try {
      await expect.poll(counts, { timeout: 20_000, interval: 100 }).toEqual({ checkpoints: 0, buckets: 0 })
      expect(timed.logs.entries().some(line => line.job === 'history-purge' && String(line.msg).includes('已启动'))).toBe(true)
    }
    finally {
      await timed.close()
    }
  })
})

import type { Transaction } from '@nerve-office/api'
import type { Database } from '@nerve-office/api/testing'
import type { Buffer } from 'node:buffer'
import type { PassiveAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TransactionRunner } from '@nerve-office/api'
import { AssetUploadService, DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'

let database: TestDatabase
let app: TestApp
let service: DocumentCheckpointService
let clock: DocumentCheckpointClock
let transactions: TransactionRunner
let documents: DocumentsRepository
let owner: PassiveAccount
let at: Date

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  service = app.runtime.get(DocumentCheckpointService)
  clock = app.runtime.get(DocumentCheckpointClock)
  transactions = app.runtime.get(TransactionRunner)
  documents = app.runtime.get(DocumentsRepository)
  owner = await createPassiveAccount(database, { username: 'checkpoint-storage-owner' })
})
beforeEach(() => {
  at = new Date('2026-10-22T23:59:59.999Z')
  vi.spyOn(clock, 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function document(): Promise<string> {
  return (await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '待恢复正文' })).id
}

async function capture(id: string): Promise<string | undefined> {
  return transactions.run(async (transaction) => {
    await documents.lockById(id, transaction)
    return service.captureHourly(id, transaction)
  })
}

async function counts(id: string): Promise<{ checkpoints: number, buckets: number }> {
  return database.query(async client => (await client.query<{ checkpoints: number, buckets: number }>(`SELECT
    (SELECT count(*)::int FROM document_checkpoints WHERE source_document_id=$1) AS checkpoints,
    (SELECT count(*)::int FROM document_history_buckets WHERE document_id=$1) AS buckets`, [id])).rows[0]!)
}

describe('历史采样的事务与原字节', () => {
  it.each(['', 'legacy-unit-'.repeat(30)])('运维检查点原样保留源表已有的 SDK 身份，不另加长度限制：%j', async (unitId) => {
    const id = await document()
    await database.query(async client => client.query('UPDATE documents SET unit_id=$2 WHERE id=$1', [id, unitId]))
    const checkpoint = await transactions.run(async (transaction) => {
      await documents.lockById(id, transaction)
      return service.captureOperation(id, 'before_upgrade', randomUUID(), transaction)
    })
    expect(await database.query(async client => (await client.query<{ unit_id: string }>('SELECT unit_id FROM document_checkpoints WHERE id=$1', [checkpoint])).rows)).toEqual([{ unit_id: unitId }])
  })

  it('同小时保留首份信封和原 gzip；跨 UTC 日期后新增，清除正文不重开该小时', async () => {
    const id = await document()
    const first = await capture(id)
    expect(first).toEqual(expect.any(String))
    await database.query(async client => client.query('UPDATE documents SET title=\'后来改名\' WHERE id=$1', [id]))
    expect(await capture(id)).toBeUndefined()
    at = new Date('2026-10-23T00:00:00.000Z')
    const second = await capture(id)
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
    const rows = await database.query(async client => (await client.query<{
      title: string
      identical: boolean
      integrity: boolean
      content_hash: Buffer | null
      resource_names: string[] | null
      saved_by: string
      same_unit: boolean
      retained: boolean
      bucket: string
    }>(`SELECT p.title,
      p.snapshot=c.snapshot AS identical, p.snapshot_hash=sha256(c.snapshot) AS integrity,
      p.content_hash, p.resource_names, p.saved_by, p.unit_id=d.unit_id AS same_unit,
      p.expires_at-p.created_at=interval '168 hours' AS retained,
      to_char(p.hour_bucket AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket
      FROM document_checkpoints p JOIN documents d ON d.id=p.source_document_id
      JOIN document_contents c ON c.document_id=d.id WHERE d.id=$1 ORDER BY p.created_at`, [id])).rows)
    expect(rows).toEqual([
      { title: '待恢复正文', identical: true, integrity: true, content_hash: null, resource_names: null, saved_by: owner.id, same_unit: true, retained: true, bucket: '2026-10-22T23:00:00Z' },
      { title: '后来改名', identical: true, integrity: true, content_hash: null, resource_names: null, saved_by: owner.id, same_unit: true, retained: true, bucket: '2026-10-23T00:00:00Z' },
    ])
    await database.query(async client => client.query('DELETE FROM document_checkpoints WHERE source_document_id=$1', [id]))
    expect(await capture(id)).toBeUndefined()
    expect(await counts(id)).toEqual({ checkpoints: 0, buckets: 2 })
  })

  it('夏令时回拨不改变 UTC 桶与 168/720 小时保留期', async () => {
    const id = await document()
    at = new Date('2026-11-01T01:30:00-04:00')
    await transactions.run(async (transaction) => {
      await (transaction as unknown as Database).execute(sql`SET LOCAL TIME ZONE 'America/New_York'`)
      await documents.lockById(id, transaction)
      await service.captureHourly(id, transaction)
      await service.captureOperation(id, 'before_upgrade', randomUUID(), transaction)
    })
    at = new Date('2026-11-01T01:30:00-05:00')
    await capture(id)
    const rows = await database.query(async client => (await client.query<{ kind: string, seconds: number, bucket: string | null }>(`SELECT kind,
      extract(epoch FROM expires_at-created_at)::int AS seconds,
      extract(epoch FROM hour_bucket)::bigint::text AS bucket
      FROM document_checkpoints WHERE source_document_id=$1 ORDER BY kind, created_at`, [id])).rows)
    expect(rows).toEqual([
      { kind: 'before_upgrade', seconds: 2592000, bucket: null },
      { kind: 'hourly', seconds: 604800, bucket: '1793509200' },
      { kind: 'hourly', seconds: 604800, bucket: '1793512800' },
    ])
  })

  it('运维事件幂等且独立于小时采样，源永久删除之后正文仍在', async () => {
    const id = await document()
    const event = randomUUID()
    const operation = async (transaction: Transaction) => {
      await documents.lockById(id, transaction)
      return service.captureOperation(id, 'before_delete', event, transaction)
    }
    expect(await transactions.run(operation)).toEqual(expect.any(String))
    expect(await transactions.run(operation)).toBeUndefined()
    expect(await counts(id)).toEqual({ checkpoints: 1, buckets: 0 })
    await capture(id)
    await database.query(async client => client.query('DELETE FROM documents WHERE id=$1', [id]))
    expect(await counts(id)).toEqual({ checkpoints: 2, buckets: 0 })
  })

  it('事务回滚移除正文和小时占位，下一次成功可以生成该小时首份', async () => {
    const id = await document()
    await expect(transactions.run(async (transaction) => {
      await documents.lockById(id, transaction)
      await service.captureHourly(id, transaction)
      throw new Error('模拟后续业务失败')
    })).rejects.toThrow('模拟后续业务失败')
    expect(await counts(id)).toEqual({ checkpoints: 0, buckets: 0 })
    expect(await capture(id)).toEqual(expect.any(String))
  })

  it('两个真实事务竞争同一小时，只提交一份正文与占位', async () => {
    const id = await document()
    const results = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [id]),
      request: async ({ step }) => Promise.all([step(capture(id)), step(capture(id))]),
      waiting: 2,
      change: async client => client.query('SELECT 1'),
    })
    expect(results.filter(value => typeof value === 'string')).toHaveLength(1)
    expect(results.filter(value => value === undefined)).toHaveLength(1)
    expect(await counts(id)).toEqual({ checkpoints: 1, buckets: 1 })
  })

  it('缺正文不能提交孤立小时占位，修复事务外的数据缺口后仍能采样', async () => {
    const id = await document()
    await expect(transactions.run(async (transaction) => {
      await documents.lockById(id, transaction)
      await (transaction as unknown as Database).execute(sql`DELETE FROM document_contents WHERE document_id=${id}`)
      await service.captureHourly(id, transaction)
    })).rejects.toThrow('检查点源文档或正文/修订不完整')
    expect(await counts(id)).toEqual({ checkpoints: 0, buckets: 0 })
    expect(await capture(id)).toEqual(expect.any(String))
  })

  it('仅承接已授权当前关系；回滚不留关系，源删除后检查点继续保护 assetId', async () => {
    const actor = await createAssetActor(database, owner.id)
    const bytes = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
    const upload = async () => app.runtime.get(AssetUploadService).upload(actor, async () => ({ data: bytes, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
    const allowed = (await upload()).assetId
    const unlinked = (await upload()).assetId
    const id = await document()
    await database.query(async client => client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES($1,$2)', [id, allowed]))
    await expect(transactions.run(async (transaction) => {
      await documents.lockById(id, transaction)
      await service.captureHourly(id, transaction)
      throw new Error('引用一起回滚')
    })).rejects.toThrow('引用一起回滚')
    expect(await counts(id)).toEqual({ checkpoints: 0, buckets: 0 })
    const checkpoint = await capture(id)
    const links = await database.query(async client => (await client.query<{ asset_id: string }>('SELECT asset_id FROM document_checkpoint_assets WHERE checkpoint_id=$1', [checkpoint])).rows.map(row => row.asset_id))
    expect(links).toEqual([allowed])
    expect(links).not.toContain(unlinked)
    await database.query(async (client) => {
      await client.query('DELETE FROM documents WHERE id=$1', [id])
      await expect(client.query('DELETE FROM assets WHERE id=$1', [allowed])).rejects.toMatchObject({ code: '23001' })
      await client.query('DELETE FROM document_checkpoints WHERE id=$1', [checkpoint])
      expect((await client.query('SELECT asset_id FROM document_checkpoint_assets WHERE checkpoint_id=$1', [checkpoint])).rowCount).toBe(0)
    })
  })

  it('未替换的生产时钟来自同一事务的数据库真实时间', async () => {
    vi.restoreAllMocks()
    await transactions.run(async (transaction) => {
      const db = transaction as unknown as Database
      const start = (await db.execute<{ epoch: string }>(sql`SELECT extract(epoch FROM clock_timestamp())::text AS epoch`)).rows[0]!.epoch
      const actual = await clock.now(transaction)
      const end = (await db.execute<{ epoch: string }>(sql`SELECT extract(epoch FROM clock_timestamp())::text AS epoch`)).rows[0]!.epoch
      expect(actual.getTime()).toBeGreaterThanOrEqual(Math.floor(Number(start) * 1000))
      expect(actual.getTime()).toBeLessThanOrEqual(Number(end) * 1000)
    })
  })

  it('现代正文的非空哈希、资源名、格式和公式状态原样保留', async () => {
    const id = await document()
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('UPDATE document_contents SET content_hash=sha256(\'normalized fixture\'::bytea), resource_names=ARRAY[\'SHEET_DEFINED_NAME_PLUGIN\'] WHERE document_id=$1', [id])
        await client.query('UPDATE document_revisions SET content_hash=sha256(\'normalized fixture\'::bytea) WHERE document_id=$1', [id])
        await client.query('UPDATE documents SET client_build=\'0.1.0+history-test\', formulas_pending=true WHERE id=$1', [id])
        await client.query('COMMIT')
      }
      catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
    const checkpoint = await capture(id)
    const result = await database.query(async client => (await client.query<{
      same_hash: boolean
      same_resources: boolean
      same_profile: boolean
      same_format: boolean
      same_sdk: boolean
      client_build: string
      formulas_pending: boolean
      same_revision: boolean
      same_saved_at: boolean
    }>(`SELECT
      p.content_hash=c.content_hash AS same_hash, p.resource_names=c.resource_names AS same_resources,
      p.profile=d.profile AS same_profile, p.format_version=d.format_version AS same_format,
      p.sdk_version=d.sdk_version AS same_sdk, p.client_build, p.formulas_pending,
      p.revision=d.revision AS same_revision, p.saved_at=r.created_at AS same_saved_at
      FROM document_checkpoints p JOIN documents d ON d.id=p.source_document_id
      JOIN document_contents c ON c.document_id=d.id
      JOIN document_revisions r ON r.document_id=d.id AND r.revision=d.revision WHERE p.id=$1`, [checkpoint])).rows)
    expect(result).toEqual([{ same_hash: true, same_resources: true, same_profile: true, same_format: true, same_sdk: true, client_build: '0.1.0+history-test', formulas_pending: true, same_revision: true, same_saved_at: true }])
  })

  it('运维捕获的源修订缺失按失败处理，不能冒充同事件重放', async () => {
    const id = await document()
    await expect(transactions.run(async (transaction) => {
      await documents.lockById(id, transaction)
      await (transaction as unknown as Database).execute(sql`DELETE FROM document_revisions WHERE document_id=${id}`)
      return service.captureOperation(id, 'before_upgrade', randomUUID(), transaction)
    })).rejects.toThrow('检查点源文档或正文/修订不完整')
    expect(await counts(id)).toEqual({ checkpoints: 0, buckets: 0 })
  })
})

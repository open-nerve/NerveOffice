import type { AssetObjectMetadata } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { TransactionRunner } from '@nerve-office/api'
import { AssetGcClock, AssetGcService, AssetsRepository, DocumentAssetRetentionService } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { whileHolding } from '../support/held-lock.ts'
import { invariantViolations } from '../support/invariants.ts'

const BASE = Date.parse('2027-01-01T08:09:10.123Z')
const DAY = 86_400_000
const data = Buffer.from('gc image metadata fixture')
const image: AssetObjectMetadata = { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, mimeType: 'image/png', width: 1, height: 1, frames: 1 }
const quotas = { quotaBytes: 1_000_000, quotaCount: 100 }
const READY = { NERVE_ASSET_GC_ENABLED: 'true', NERVE_ASSET_GC_GRACE_DAYS: '2', NERVE_BACKUP_RETENTION_DAYS: '1', NERVE_ASSET_GC_RECOVERY_BEFORE: new Date(BASE + DAY).toISOString() }
let database: TestDatabase
let app: TestApp
let owner: string
let spaceId: string
let at: Date

beforeAll(async () => {
  database = await createTestDatabase()
  const account = await createPassiveAccount(database, { username: 'asset-gc-owner' })
  owner = account.id
  spaceId = account.personalSpaceId
})
beforeEach(async () => {
  await database.query(async client => client.query('TRUNCATE document_asset_links, document_checkpoint_assets, asset_reference_activity, assets, asset_objects, asset_object_claims, asset_object_deletions, asset_quota CASCADE'))
  at = new Date(BASE)
  await configure()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  expect(await database.query(invariantViolations)).toEqual([])
})
afterAll(async () => database?.drop())

async function configure(env: Readonly<Record<string, string>> = READY) {
  app = await startTestApp({ databaseUrl: database.url, env })
  vi.spyOn(app.runtime.get(AssetGcClock), 'now').mockImplementation(async () => at)
}
async function reopen(env: Readonly<Record<string, string>>) {
  vi.restoreAllMocks()
  await app.close()
  await configure(env)
}
async function asset() {
  const id = randomUUID()
  const repo = app.runtime.get(AssetsRepository)
  const transactions = app.runtime.get(TransactionRunner)
  const reservation = await transactions.run(async tx => repo.reserve(image, quotas, tx))
  // 本组只验证数据库候选、收费与退休原子性；文件发布/实际读取由 Task 4 的真实存储链路覆盖。
  await transactions.run(async tx => repo.finalize(id, owner, image, quotas, tx, reservation))
  await database.query(async client => client.query('UPDATE assets SET created_at=$2 WHERE id=$1', [id, new Date(BASE - 2 * DAY)]))
  return id
}
async function scan() {
  const gc = app.runtime.get(AssetGcService)
  const through = await gc.assetUpperBound()
  if (through === undefined)
    throw new Error('需要资源候选')
  return gc.scanAssets(app.runtime.get(DocumentAssetRetentionService), { through, limit: 100 })
}
async function count() {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM assets')).rows[0]!.count)
}
async function candidate(kind: 'object' | 'claim') {
  const table = kind === 'object' ? 'asset_objects' : 'asset_object_claims'
  return database.query(async client => (await client.query<{ since: Date | null }>(`SELECT unreferenced_at AS since FROM ${table} WHERE sha256=$1`, [image.sha256])).rows[0]?.since)
}
async function pendingCount() {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM asset_object_deletions WHERE completed_at IS NULL')).rows[0]!.count)
}
async function auditCount(action: string) {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_events WHERE action=$1', [action])).rows[0]!.count)
}

describe('资源回收的持久元数据事务', () => {
  it('正式时钟不依赖测试替身，候选时刻落在两次真实数据库读数之间', async () => {
    const id = await asset()
    vi.spyOn(app.runtime.get(AssetGcClock), 'now').mockRestore()
    await database.query(async client => client.query('UPDATE assets SET created_at=clock_timestamp()-interval \'25 hours\' WHERE id=$1', [id]))
    const before = await database.query(async client => (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at)
    expect(await scan()).toMatchObject({ marked: 1 })
    const times = await database.query(async client => (await client.query<{ since: Date, at: Date }>('SELECT unreferenced_at AS since,clock_timestamp() AS at FROM assets WHERE id=$1', [id])).rows[0]!)
    expect(times.since.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(times.since.getTime()).toBeLessThanOrEqual(times.at.getTime())
  })

  it('等待完整候选宽限，在精确截止点删除资源记录，字节仍收费', async () => {
    await asset()
    await scan()
    at = new Date(BASE + 2 * DAY - 1)
    await scan()
    expect(await count()).toBe(1)
    at = new Date(BASE + 2 * DAY)
    await scan()
    expect(await count()).toBe(0)
    expect(await database.query(async client => (await client.query<{ used_bytes: number, used_assets: number }>('SELECT used_bytes::int,used_assets FROM asset_quota')).rows))
      .toEqual([{ used_bytes: data.length, used_assets: 0 }])
  })

  it('同 hash 多记录回收后，对象重新等独立宽限；转入持久任务不释放字节', async () => {
    await asset()
    await asset()
    await scan()
    at = new Date(BASE + 2 * DAY)
    await scan()
    expect(await count()).toBe(0)
    const page = { through: image.sha256, limit: 100 }
    expect(await app.runtime.get(AssetGcService).scanObjects('object', page)).toMatchObject({ marked: 1, queued: 0 })
    at = new Date(BASE + 4 * DAY)
    await reopen({ ...READY, NERVE_ASSET_GC_RECOVERY_BEFORE: new Date(BASE + 3 * DAY).toISOString() })
    expect(await app.runtime.get(AssetGcService).scanObjects('object', page)).toMatchObject({ queued: 1, bytes: data.length })
    expect(await database.query(async client => (await client.query<{ bytes: number, completed_at: null }>('SELECT bytes,completed_at FROM asset_object_deletions')).rows))
      .toEqual([{ bytes: data.length, completed_at: null }])
    expect(await database.query(async client => (await client.query<{ used_bytes: number, used_assets: number }>('SELECT used_bytes::int,used_assets FROM asset_quota')).rows))
      .toEqual([{ used_bytes: data.length, used_assets: 0 }])
  })

  it('未发布 claim 从首次观察开始宽限，退休后相同 hash 重新上传取得新代次并单独收费', async () => {
    const repo = app.runtime.get(AssetsRepository)
    const txs = app.runtime.get(TransactionRunner)
    const first = await txs.run(async tx => repo.reserve(image, quotas, tx))
    const page = { through: image.sha256, limit: 100 }
    expect(await app.runtime.get(AssetGcService).scanObjects('claim', page)).toMatchObject({ marked: 1, queued: 0 })
    at = new Date(BASE + 2 * DAY)
    expect(await app.runtime.get(AssetGcService).scanObjects('claim', page)).toMatchObject({ queued: 1 })
    const second = await txs.run(async tx => repo.reserve(image, quotas, tx))
    expect(second.generation).not.toBe(first.generation)
    expect(second.storageKey).not.toBe(first.storageKey)
    await expect(txs.run(async tx => repo.finalize(randomUUID(), owner, image, quotas, tx, first))).rejects.toMatchObject({ code: 'ASSET_BUSY' })
    await txs.run(async tx => repo.finalize(randomUUID(), owner, image, quotas, tx, second))
    expect(await database.query(async client => (await client.query<{ used_bytes: number, used_assets: number }>('SELECT used_bytes::int,used_assets FROM asset_quota')).rows))
      .toEqual([{ used_bytes: 2 * data.length, used_assets: 1 }])
  })

  it('退休回执的身份、费用与起点不可改写，完成后不能退回 pending', async () => {
    await app.runtime.get(TransactionRunner).run(async tx => app.runtime.get(AssetsRepository).reserve(image, quotas, tx))
    const page = { through: image.sha256, limit: 100 }
    await app.runtime.get(AssetGcService).scanObjects('claim', page)
    at = new Date(BASE + 2 * DAY)
    await app.runtime.get(AssetGcService).scanObjects('claim', page)
    for (const change of ['bytes=bytes+1', 'unreferenced_at=unreferenced_at-interval \'1 day\'', 'id=uuidv7()']) {
      await database.query(async (client) => {
        await client.query('BEGIN')
        try {
          await expect(client.query(`UPDATE asset_object_deletions SET ${change}`)).rejects.toMatchObject({ code: '23514', constraint: 'asset_object_deletions_identity' })
        }
        finally {
          await client.query('ROLLBACK')
        }
      })
    }
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('UPDATE asset_object_deletions SET completed_at=created_at')
        await expect(client.query('UPDATE asset_object_deletions SET completed_at=NULL')).rejects.toMatchObject({ code: '23514', constraint: 'asset_object_deletions_identity' })
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  })

  it.each([
    ['disabled', { ...READY, NERVE_ASSET_GC_ENABLED: 'false' }],
    ['backup-retention-missing', { ...READY, NERVE_BACKUP_RETENTION_DAYS: '' }],
    ['recovery-boundary-missing', { ...READY, NERVE_ASSET_GC_RECOVERY_BEFORE: '' }],
    ['recovery-boundary-future', { ...READY, NERVE_ASSET_GC_RECOVERY_BEFORE: new Date(BASE + 4 * DAY).toISOString() }],
    ['recovery-boundary-too-new', { ...READY, NERVE_ASSET_GC_RECOVERY_BEFORE: new Date(BASE + 2 * DAY + 1).toISOString() }],
  ] as const)('政策 %s 时保留成熟资源，仍可读取元数据并整理活动', async (policy, env) => {
    const id = await asset()
    await scan()
    at = new Date(BASE + 3 * DAY)
    await reopen(env)
    expect(await scan()).toMatchObject({ policy, removed: 0 })
    expect(await count()).toBe(1)
    expect(await app.runtime.get(TransactionRunner).readSnapshot(async tx => app.runtime.get(AssetsRepository).metadata(id, tx))).toMatchObject({ assetId: id })
    const doc = await seedDocument(database, { spaceId, createdBy: owner, title: '活动清理' })
    await database.query(async (client) => {
      await client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES ($1,$2)', [doc.id, id])
      await client.query('DELETE FROM document_asset_links WHERE document_id=$1', [doc.id])
    })
    expect(await scan()).toMatchObject({ marked: 1, removed: 0, policy })
    expect(await database.query(async client => (await client.query<{ since: Date }>('SELECT unreferenced_at AS since FROM assets WHERE id=$1', [id])).rows[0]?.since)).toEqual(at)
  })

  it('候选等于恢复水位不能删除；水位前进一毫秒后仍重新核对宽限', async () => {
    at = new Date(BASE + DAY)
    await asset()
    await scan()
    at = new Date(BASE + 3 * DAY)
    expect(await scan()).toMatchObject({ removed: 0, policy: 'ready' })
    await reopen({ ...READY, NERVE_ASSET_GC_RECOVERY_BEFORE: new Date(BASE + DAY + 1).toISOString() })
    expect(await scan()).toMatchObject({ removed: 1 })
  })

  it('还有一个被引用的同 hash 资源时，只回收无引用 id，对象不进入孤儿宽限', async () => {
    await asset()
    const retained = await asset()
    const doc = await seedDocument(database, { spaceId, createdBy: owner, title: '同图副本' })
    await database.query(async client => client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES ($1,$2)', [doc.id, retained]))
    await scan()
    at = new Date(BASE + 2 * DAY)
    expect(await scan()).toMatchObject({ removed: 1 })
    expect(await count()).toBe(1)
    expect(await app.runtime.get(AssetGcService).scanObjects('object', { through: image.sha256, limit: 100 })).toMatchObject({ scanned: 1, marked: 0, queued: 0 })
    expect(await candidate('object')).toBeNull()
  })

  it.each(['object', 'claim'] as const)('重用 %s 重置候选；失败预留回滚，成功转正也清掉期间新出现的候选', async (kind) => {
    const repo = app.runtime.get(AssetsRepository)
    const txs = app.runtime.get(TransactionRunner)
    const gc = app.runtime.get(AssetGcService)
    const page = { through: image.sha256, limit: 100 }
    if (kind === 'object') {
      await asset()
      await scan()
      at = new Date(BASE + 2 * DAY)
      await scan()
    }
    else {
      await txs.run(async tx => repo.reserve(image, quotas, tx))
    }
    await gc.scanObjects(kind, page)
    const since = at
    await expect(txs.run(async (tx) => {
      await repo.reserve(image, quotas, tx)
      throw new Error('controlled reservation rollback')
    })).rejects.toThrow('controlled reservation rollback')
    expect(await candidate(kind)).toEqual(since)
    const reservation = await txs.run(async tx => repo.reserve(image, quotas, tx))
    expect(await candidate(kind)).toBeNull()
    at = new Date(at.getTime() + 1)
    expect(await gc.scanObjects(kind, page)).toMatchObject({ marked: 1, queued: 0 })
    await txs.run(async tx => repo.finalize(randomUUID(), owner, image, quotas, tx, reservation))
    expect(await candidate('object')).toBeNull()
  })

  it('待退休字节仍占配额，不能靠相同 hash 的新代次绕过上限', async () => {
    const repo = app.runtime.get(AssetsRepository)
    const txs = app.runtime.get(TransactionRunner)
    await txs.run(async tx => repo.reserve(image, quotas, tx))
    const page = { through: image.sha256, limit: 100 }
    await app.runtime.get(AssetGcService).scanObjects('claim', page)
    at = new Date(BASE + 2 * DAY)
    await app.runtime.get(AssetGcService).scanObjects('claim', page)
    await expect(txs.run(async tx => repo.reserve(image, { ...quotas, quotaBytes: data.length }, tx))).rejects.toMatchObject({ code: 'ASSET_QUOTA_EXCEEDED', details: { kind: 'bytes' } })
    expect(await pendingCount()).toBe(1)
    expect(await candidate('claim')).toBeUndefined()
  })

  it.each(['asset', 'claim'] as const)('%s 回收审计写失败时，资源、候选、任务和配额一起回滚', async (kind) => {
    if (kind === 'asset') {
      await asset()
      await scan()
    }
    else {
      await app.runtime.get(TransactionRunner).run(async tx => app.runtime.get(AssetsRepository).reserve(image, quotas, tx))
      await app.runtime.get(AssetGcService).scanObjects('claim', { through: image.sha256, limit: 100 })
    }
    at = new Date(BASE + 2 * DAY)
    const action = kind === 'asset' ? 'assets.records_collected' : 'assets.retirement_queued'
    const before = await auditCount(action)
    const collect = async () => kind === 'asset' ? scan() : app.runtime.get(AssetGcService).scanObjects('claim', { through: image.sha256, limit: 100 })
    await database.query(async (client) => {
      await client.query('CREATE FUNCTION reject_gc_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'controlled gc audit failure\'; END $$')
      await client.query(`CREATE TRIGGER reject_gc_audit BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action='${action}') EXECUTE FUNCTION reject_gc_audit()`)
    })
    try {
      await expect(collect()).rejects.toThrow()
      expect(await pendingCount()).toBe(0)
      expect(await count()).toBe(kind === 'asset' ? 1 : 0)
      expect(await auditCount(action)).toBe(before)
      expect(await database.query(invariantViolations)).toEqual([])
    }
    finally {
      await database.query(async (client) => {
        await client.query('DROP TRIGGER reject_gc_audit ON audit_events')
        await client.query('DROP FUNCTION reject_gc_audit()')
      })
    }
    await collect()
    expect(await auditCount(action)).toBe(before + 1)
  })

  it('排队事务真实提交后丢失回执，下一次扫描不重复登记或释放配额', async () => {
    const txs = app.runtime.get(TransactionRunner)
    await txs.run(async tx => app.runtime.get(AssetsRepository).reserve(image, quotas, tx))
    const gc = app.runtime.get(AssetGcService)
    const page = { through: image.sha256, limit: 100 }
    await gc.scanObjects('claim', page)
    at = new Date(BASE + 2 * DAY)
    const before = await auditCount('assets.retirement_queued')
    const run = txs.run.bind(txs)
    const lost = vi.spyOn(txs, 'run').mockImplementationOnce(async (work, options) => {
      await run(work, options)
      throw new Error('controlled committed acknowledgement loss')
    })
    await expect(gc.scanObjects('claim', page)).rejects.toThrow('controlled committed acknowledgement loss')
    lost.mockRestore()
    expect(await pendingCount()).toBe(1)
    expect(await gc.scanObjects('claim', page)).toMatchObject({ queued: 0, scanned: 0 })
    expect(await auditCount('assets.retirement_queued')).toBe(before + 1)
  })

  it('claim 锁争用时跳过，分页上界与非法批量保持有界', async () => {
    await app.runtime.get(TransactionRunner).run(async tx => app.runtime.get(AssetsRepository).reserve(image, quotas, tx))
    const gc = app.runtime.get(AssetGcService)
    expect(await gc.objectUpperBound('claim')).toBe(image.sha256)
    expect(await gc.objectUpperBound('object')).toBeUndefined()
    await whileHolding(database, async client => client.query('SELECT sha256 FROM asset_object_claims FOR UPDATE'), async () => {
      expect(await gc.scanObjects('claim', { through: image.sha256, limit: 1 })).toMatchObject({ scanned: 0 })
    })
    expect(await gc.scanObjects('claim', { through: image.sha256, limit: 1 })).toMatchObject({ scanned: 1, lastHash: image.sha256 })
    expect(await gc.scanObjects('claim', { through: image.sha256, after: image.sha256, limit: 1 })).toMatchObject({ scanned: 0 })
    await expect(gc.scanObjects('claim', { through: image.sha256, limit: 1001 })).rejects.toThrow()
  })
})

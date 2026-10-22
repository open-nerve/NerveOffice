import type { FileStorage } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import fs, { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TransactionRunner } from '@nerve-office/api'
import { ASSET_STORAGE, AssetGcClock, AssetGcService, AssetRetirementService, AssetsRepository } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { GC_TEST_ENV, queueAsset, retirementState } from '../support/asset-retirement.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { createTestDatabase } from '../support/database.ts'
import { invariantViolations } from '../support/invariants.ts'

let database: TestDatabase
let app: TestApp
let owner: string
beforeAll(async () => {
  database = await createTestDatabase()
  owner = (await createPassiveAccount(database, { username: 'asset-retirement-owner' })).id
})
beforeEach(async () => {
  await database.query(async client => client.query('TRUNCATE document_asset_links, document_checkpoint_assets, asset_reference_activity, assets, asset_objects, asset_object_claims, asset_object_deletions, asset_quota CASCADE'))
  app = await startTestApp({ databaseUrl: database.url, env: GC_TEST_ENV })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  expect(await database.query(invariantViolations)).toEqual([])
})
afterAll(async () => database?.drop())
const retire = async (id: string, signal?: AbortSignal) => app.runtime.get(AssetRetirementService).retire(id, signal)
const path = (key: string) => join(testAssetRoot(database.url), key)
function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

describe('图片文件退休的真实事务和文件接续', () => {
  it('只在私有文件标记同步后释放一次字节，保留完成回执；重复或并发执行不重复收费', async () => {
    const task = await queueAsset(app, database, owner)
    expect(await readFile(path(task.metadata.storageKey))).toEqual(task.data)
    const outcomes = await Promise.all([retire(task.id), retire(task.id)])
    expect(outcomes.map(item => item.bytes).reduce((sum, value) => sum + value, 0)).toBe(task.metadata.bytes)
    expect(await stat(path(task.metadata.storageKey))).toMatchObject({ size: 0 })
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 1 })
    const storage = app.runtime.get<FileStorage>(ASSET_STORAGE)
    const file = vi.spyOn(storage, 'retire')
    expect(await retire(task.id)).toMatchObject({ state: 'already-completed', bytes: 0 })
    expect(file).not.toHaveBeenCalled()
    expect(await retire(randomUUID())).toMatchObject({ state: 'missing', bytes: 0 })
  })

  it.each([false, true])('文件回收失败（标记已写入=%s）时保留全部收费，新实例接续', async (afterFile) => {
    const task = await queueAsset(app, database, owner)
    const storage = app.runtime.get<FileStorage>(ASSET_STORAGE)
    const original = storage.retire.bind(storage)
    vi.spyOn(storage, 'retire').mockImplementationOnce(async (...args) => {
      if (afterFile)
        await original(...args)
      throw new Error('controlled file retirement failure')
    })
    await expect(retire(task.id)).rejects.toThrow('controlled file retirement failure')
    expect(await retirementState(database)).toEqual({ bytes: task.metadata.bytes, assets: 0, pending: 1, completed: 0 })
    expect((await stat(path(task.metadata.storageKey))).size).toBe(afterFile ? 0 : task.metadata.bytes)
    vi.restoreAllMocks()
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env: GC_TEST_ENV })
    expect(await retire(task.id)).toMatchObject({ state: 'completed', bytes: task.metadata.bytes })
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 1 })
  })

  it('旧任务重放不触碰同 hash 的新代次，两个占用分别计费', async () => {
    const task = await queueAsset(app, database, owner)
    const repo = app.runtime.get(AssetsRepository)
    const txs = app.runtime.get(TransactionRunner)
    const quotas = { quotaBytes: 1_000_000, quotaCount: 10 }
    const reservation = await txs.run(async tx => repo.reserve(task.image, quotas, tx))
    expect(reservation.storageKey).not.toBe(task.metadata.storageKey)
    await app.runtime.get<FileStorage>(ASSET_STORAGE).publish({ ...task.image, data: task.data }, reservation.storageKey)
    await txs.run(async tx => repo.finalize(randomUUID(), owner, task.image, quotas, tx, reservation))
    expect((await retirementState(database)).bytes).toBe(task.metadata.bytes * 2)
    const before = await stat(path(reservation.storageKey))
    await retire(task.id)
    await retire(task.id)
    expect(await readFile(path(reservation.storageKey))).toEqual(task.data)
    expect((await stat(path(reservation.storageKey))).ino).toBe(before.ino)
    expect(await retirementState(database)).toEqual({ bytes: task.metadata.bytes, assets: 1, pending: 0, completed: 1 })
  })

  it('未具备备份声明时已有任务也暂停，不能触碰文件或释放额度', async () => {
    const task = await queueAsset(app, database, owner)
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env: { ...GC_TEST_ENV, NERVE_BACKUP_RETENTION_DAYS: '' } })
    const file = vi.spyOn(app.runtime.get<FileStorage>(ASSET_STORAGE), 'retire')
    expect(await retire(task.id)).toMatchObject({ state: 'paused', reason: 'backup-retention-missing', bytes: 0 })
    expect(file).not.toHaveBeenCalled()
    expect(await readFile(path(task.metadata.storageKey))).toEqual(task.data)
    expect((await retirementState(database)).bytes).toBe(task.metadata.bytes)
  })

  it('中止信号已到时不开始新的文件回收', async () => {
    const task = await queueAsset(app, database, owner)
    const stop = new AbortController()
    stop.abort()
    const file = vi.spyOn(app.runtime.get<FileStorage>(ASSET_STORAGE), 'retire')
    expect(await retire(task.id, stop.signal)).toMatchObject({ state: 'stopped', bytes: 0 })
    expect(file).not.toHaveBeenCalled()
    expect((await retirementState(database)).pending).toBe(1)
  })

  it.each(['completion', 'audit'] as const)('%s 数据库写入失败时文件可已退休，但收费与完成回执一并回滚', async (stage) => {
    const task = await queueAsset(app, database, owner)
    const table = stage === 'completion' ? 'asset_object_deletions' : 'audit_events'
    const event = stage === 'completion' ? 'UPDATE' : 'INSERT'
    const condition = stage === 'completion' ? 'NEW.completed_at IS NOT NULL' : 'NEW.action=\'assets.bytes_reclaimed\''
    await database.query(async (client) => {
      await client.query('CREATE FUNCTION reject_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'controlled retirement database failure\'; END $$')
      await client.query(`CREATE TRIGGER reject_retirement BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION reject_retirement()`)
    })
    try {
      await expect(retire(task.id)).rejects.toThrow()
      expect((await stat(path(task.metadata.storageKey))).size).toBe(0)
      expect(await retirementState(database)).toEqual({ bytes: task.metadata.bytes, assets: 0, pending: 1, completed: 0 })
    }
    finally {
      await database.query(async (client) => {
        await client.query(`DROP TRIGGER reject_retirement ON ${table}`)
        await client.query('DROP FUNCTION reject_retirement()')
      })
    }
    await retire(task.id)
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 1 })
  })

  it.each([1, 2])('第 %i 个真实事务提交后回执丢失，重读状态后只释放一次', async (lostAt) => {
    const task = await queueAsset(app, database, owner)
    const txs = app.runtime.get(TransactionRunner)
    const run = txs.run.bind(txs)
    let calls = 0
    const injected = vi.spyOn(txs, 'run').mockImplementation(async (work, options) => {
      const result = await run(work, options)
      calls++
      if (calls === lostAt)
        throw new Error('controlled retirement acknowledgement loss')
      return result
    })
    await expect(retire(task.id)).rejects.toThrow('controlled retirement acknowledgement loss')
    injected.mockRestore()
    expect((await retirementState(database)).bytes).toBe(lostAt === 1 ? task.metadata.bytes : 0)
    expect((await stat(path(task.metadata.storageKey))).size).toBe(lostAt === 1 ? task.metadata.bytes : 0)
    await retire(task.id)
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 1 })
  })

  it.each(['before-link', 'after-link'] as const)('旧 publish 停在 %s，回收确认后恢复仍不能重建文件或借用新代次', async (stage) => {
    const fixture = await queueAsset(app, database, owner)
    await retire(fixture.id)
    const repo = app.runtime.get(AssetsRepository)
    const txs = app.runtime.get(TransactionRunner)
    const storage = app.runtime.get<FileStorage>(ASSET_STORAGE)
    const quotas = { quotaBytes: 1_000_000, quotaCount: 10 }
    const old = await txs.run(async tx => repo.reserve(fixture.image, quotas, tx))
    const entered = gate()
    const resume = gate()
    const link = fs.link
    vi.spyOn(fs, 'link').mockImplementationOnce(async (source, target) => {
      if (stage === 'after-link')
        await link(source, target)
      entered.open()
      await resume.wait
      if (stage === 'before-link')
        await link(source, target)
    })
    const publishing = storage.publish({ ...fixture.image, data: fixture.data }, old.storageKey).then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await Promise.race([entered.wait, publishing.then(() => {
        throw new Error('未到发布交错点就结束')
      })])
      await database.query(async client => client.query('UPDATE asset_object_claims SET unreferenced_at=\'2020-01-01T00:00:00.000Z\' WHERE sha256=$1', [fixture.image.sha256]))
      await app.runtime.get(AssetGcService).scanObjects('claim', { through: fixture.image.sha256, limit: 100 })
      const retiredId = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM asset_object_deletions WHERE storage_key=$1', [old.storageKey])).rows[0]!.id)
      await retire(retiredId)
      const fresh = await txs.run(async tx => repo.reserve(fixture.image, quotas, tx))
      await storage.publish({ ...fixture.image, data: fixture.data }, fresh.storageKey)
      await txs.run(async tx => repo.finalize(randomUUID(), owner, fixture.image, quotas, tx, fresh))
      resume.open()
      const outcome = await publishing
      if (stage === 'before-link')
        expect(outcome).toMatchObject({ error: { name: 'AssetStorageError', reason: 'integrity' } })
      else
        expect(outcome).toEqual({ value: old.storageKey })
      await expect(txs.run(async tx => repo.finalize(randomUUID(), owner, fixture.image, quotas, tx, old))).rejects.toMatchObject({ code: 'ASSET_BUSY' })
      expect((await stat(path(old.storageKey))).size).toBe(0)
      expect(await readFile(path(fresh.storageKey))).toEqual(fixture.data)
      expect(await retirementState(database)).toEqual({ bytes: fixture.image.bytes, assets: 1, pending: 0, completed: 2 })
    }
    finally {
      resume.open()
      await publishing
    }
  })

  it.each([
    [{ ...GC_TEST_ENV, NERVE_ASSET_GC_ENABLED: 'false' }, 'disabled'],
    [{ ...GC_TEST_ENV, NERVE_ASSET_GC_GRACE_DAYS: '3650' }, 'candidate-protected'],
    [{ ...GC_TEST_ENV, NERVE_ASSET_GC_RECOVERY_BEFORE: '2019-12-31T00:00:00.000Z' }, 'candidate-protected'],
  ] as const)('重启收紧政策后不执行旧任务：%j', async (env, reason) => {
    const task = await queueAsset(app, database, owner)
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env })
    const file = vi.spyOn(app.runtime.get<FileStorage>(ASSET_STORAGE), 'retire')
    expect(await retire(task.id)).toMatchObject({ state: 'paused', reason })
    expect(file).not.toHaveBeenCalled()
    expect((await retirementState(database)).bytes).toBe(task.metadata.bytes)
  })

  it.each([false, true])('退出信号在文件回收后到来=%s：开始前停止，开始后完成当前确认', async (afterFile) => {
    const task = await queueAsset(app, database, owner)
    const stop = new AbortController()
    if (afterFile) {
      const storage = app.runtime.get<FileStorage>(ASSET_STORAGE)
      const original = storage.retire.bind(storage)
      vi.spyOn(storage, 'retire').mockImplementationOnce(async (...args) => {
        await original(...args)
        stop.abort()
      })
    }
    else {
      const clock = app.runtime.get(AssetGcClock)
      const now = clock.now.bind(clock)
      vi.spyOn(clock, 'now').mockImplementationOnce(async (tx) => {
        const at = await now(tx)
        stop.abort()
        return at
      })
    }
    expect(await retire(task.id, stop.signal)).toMatchObject({ state: afterFile ? 'completed' : 'stopped' })
    expect((await retirementState(database)).pending).toBe(afterFile ? 0 : 1)
  })

  it('持久状态不一致、退休路径仍被 claim 占用时拒绝触碰文件', async () => {
    const task = await queueAsset(app, database, owner)
    await database.query(async (client) => {
      await client.query('INSERT INTO asset_object_claims(sha256,generation,bytes) SELECT sha256,generation,bytes FROM asset_object_deletions WHERE id=$1', [task.id])
      await client.query('UPDATE asset_quota SET used_bytes=used_bytes+$1', [task.metadata.bytes])
    })
    try {
      await expect(retire(task.id)).rejects.toThrow('已退休路径仍被存活资源使用')
      expect(await readFile(path(task.metadata.storageKey))).toEqual(task.data)
    }
    finally {
      await database.query(async (client) => {
        await client.query('DELETE FROM asset_object_claims WHERE sha256=$1', [task.metadata.sha256])
        await client.query('UPDATE asset_quota SET used_bytes=used_bytes-$1', [task.metadata.bytes])
      })
    }
  })

  it('固定上界按 id 分页，只选择 pending，不无限追赶新加入的任务', async () => {
    const service = app.runtime.get(AssetRetirementService)
    expect(await service.upperBound()).toBeUndefined()
    const first = await queueAsset(app, database, owner)
    const through = (await service.upperBound())!
    const second = await queueAsset(app, database, owner)
    expect(await service.page({ through, limit: 1 })).toEqual([first.id])
    expect(await service.page({ through, after: first.id, limit: 1 })).toEqual([])
    await retire(first.id)
    expect(await service.upperBound()).toBe(second.id)
    await expect(service.page({ through, limit: 0 })).rejects.toThrow()
  })
})

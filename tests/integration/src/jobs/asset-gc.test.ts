import type { FileStorage } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { ASSET_GC_LOCK, AssetGcJob, TRASH_PURGE_LOCK } from '@nerve-office/api'
import { ASSET_STORAGE, AssetRetirementService, ExclusiveRunner } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { GC_TEST_ENV, queueAsset, retirementState } from '../support/asset-retirement.ts'
import { createTestDatabase } from '../support/database.ts'
import { whileHolding } from '../support/held-lock.ts'

let database: TestDatabase
let app: TestApp
let owner: string
beforeAll(async () => {
  database = await createTestDatabase()
  owner = (await createPassiveAccount(database, { username: 'asset-gc-job-owner' })).id
})
beforeEach(async () => {
  await database.query(async client => client.query('TRUNCATE document_asset_links, document_checkpoint_assets, asset_reference_activity, assets, asset_objects, asset_object_claims, asset_object_deletions, asset_quota CASCADE'))
  app = await startTestApp({ databaseUrl: database.url, env: { ...GC_TEST_ENV, NERVE_ASSET_GC_BATCH: '1' } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
})
afterAll(async () => database?.drop())
// 故意给过期的调度时刻；删除决定必须用每次锁后的真实数据库时间。
const run = async (signal?: AbortSignal) => app.runtime.get(AssetGcJob).runOnce(new Date('1980-01-01T00:00:00.000Z'), signal)

describe('资源 GC 定时任务的真实组合', () => {
  it('小批量处理全部持久任务，不复用调度开始时刻；下一轮幂等', async () => {
    const tasks = []
    for (let i = 0; i < 3; i++)
      tasks.push(await queueAsset(app, database, owner))
    expect(await run()).toMatchObject({ ran: true, ending: 'drained', retiredObjects: 3, reclaimedBytes: tasks[0]!.metadata.bytes * 3 })
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 3 })
    expect(await run()).toMatchObject({ ending: 'drained', retiredObjects: 0, reclaimedBytes: 0 })
  })

  it('其他连接持有本任务的独占锁时，本轮立即退出', async () => {
    await queueAsset(app, database, owner)
    await whileHolding(database, async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ASSET_GC_LOCK]), async () => {
      expect(await run()).toMatchObject({ ran: false, ending: 'contended', batches: 0 })
    })
    expect((await retirementState(database)).pending).toBe(1)
  })

  it('本轮固定任务上界，不追赶文件处理期间新加入的回执', async () => {
    await queueAsset(app, database, owner)
    const service = app.runtime.get(AssetRetirementService)
    const original = service.retire.bind(service)
    vi.spyOn(service, 'retire').mockImplementationOnce(async (...args) => {
      await queueAsset(app, database, owner)
      return original(...args)
    })
    expect(await run()).toMatchObject({ retiredObjects: 1, ending: 'drained' })
    expect((await retirementState(database)).pending).toBe(1)
    expect(await run()).toMatchObject({ retiredObjects: 1, ending: 'drained' })
  })

  it('失败后停止本轮且保留收费，下轮从持久任务继续，日志不输出原始异常内容', async () => {
    await queueAsset(app, database, owner)
    await queueAsset(app, database, owner)
    vi.spyOn(app.runtime.get<FileStorage>(ASSET_STORAGE), 'retire').mockRejectedValueOnce(new Error('sensitive /private/fixture/image'))
    expect(await run()).toMatchObject({ ending: 'failed', retiredObjects: 0 })
    expect((await retirementState(database)).pending).toBe(2)
    expect(JSON.stringify(app.logs.entries())).not.toContain('sensitive /private/fixture/image')
    expect(await run()).toMatchObject({ ending: 'drained', retiredObjects: 2 })
  })

  it('退出时完成当前文件确认，不再处理下一项', async () => {
    await queueAsset(app, database, owner)
    await queueAsset(app, database, owner)
    const stop = new AbortController()
    const service = app.runtime.get(AssetRetirementService)
    const original = service.retire.bind(service)
    vi.spyOn(service, 'retire').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      stop.abort()
      return result
    })
    expect(await run(stop.signal)).toMatchObject({ ending: 'stopped', retiredObjects: 1 })
    expect((await retirementState(database)).pending).toBe(1)
    expect(await run(stop.signal)).toMatchObject({ ending: 'stopped', batches: 0 })
  })

  it('没有备份水位时报告暂停，已有任务保持原状', async () => {
    const task = await queueAsset(app, database, owner)
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env: { ...GC_TEST_ENV, NERVE_ASSET_GC_RECOVERY_BEFORE: '' } })
    expect(await run()).toMatchObject({ ending: 'paused', pauseReason: 'recovery-boundary-missing', retiredObjects: 0 })
    expect((await retirementState(database)).bytes).toBe(task.metadata.bytes)
  })

  it('正式定时器自动处理待办，关闭应用时取消后续调度', async () => {
    await queueAsset(app, database, owner)
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env: { ...GC_TEST_ENV, NERVE_ASSET_GC_INTERVAL_MS: '1000' } })
    await expect.poll(async () => (await retirementState(database)).pending, { timeout: 8000 }).toBe(0)
    expect(app.logs.entries().some(line => line.job === 'asset-gc' && String(line.msg).includes('已启动'))).toBe(true)
  })

  it.each([false, true])('最小池实际跑完文件退休；另一回收任务占连接：%s', async (trash) => {
    await queueAsset(app, database, owner)
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env: {
      ...GC_TEST_ENV,
      NERVE_DATABASE_POOL_MAX: trash ? '3' : '2',
      NERVE_TRASH_PURGE_ENABLED: String(trash),
    } })
    // 在应用自己的同一连接池上占住回收站的整轮会话锁，GC 还需自己的会话锁及逐项工作连接。
    const result = trash
      ? await app.runtime.get(ExclusiveRunner).run(TRASH_PURGE_LOCK, async () => run())
      : { ran: true, result: await run() }
    expect(result).toMatchObject({ ran: true, result: { ran: true, ending: 'drained', retiredObjects: 1 } })
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 1 })
  })
})

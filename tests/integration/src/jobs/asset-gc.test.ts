import type { FileStorage } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_GC_LOCK, AssetGcJob, TRASH_PURGE_LOCK } from '@nerve-office/api'
import { ASSET_STORAGE, AssetRetirementService, AssetUploadService, ExclusiveRunner } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { GC_TEST_ENV, queueAsset, retirementState, stageOrphan } from '../support/asset-retirement.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { createAssetActor } from '../support/assets.ts'
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
const completed = async (id: string) => database.query(async client => (await client.query<{ done: boolean }>('SELECT completed_at IS NOT NULL AS done FROM asset_object_deletions WHERE id=$1', [id])).rows[0]!.done)
const TASK_FAILURE = '图片文件回收任务失败，保留待办并继续后续任务'
const WATERMARK_WARNING = '图片资源回收：宽限已满但被恢复水位挡住，请随备份轮换推进 NERVE_ASSET_GC_RECOVERY_BEFORE'

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

  it('M5R-M-02 单个文件任务的存储失败持续存在：记下任务 id 与有界原因，后面的任务照常回收并释放字节，本轮报告部分失败', async () => {
    const bad = await queueAsset(app, database, owner)
    const good = await queueAsset(app, database, owner)
    // 第一个任务的文件在卷部分恢复后变成 0644：真实存储按属主、权限、类型不符拒绝（unsafe-path），每轮都失败
    await chmod(join(testAssetRoot(database.url), bad.metadata.storageKey), 0o644)
    const logStart = app.logs.entries().length
    expect(await run()).toMatchObject({ ending: 'partial', retiredObjects: 1, failedTasks: 1 })
    expect(await retirementState(database)).toMatchObject({ pending: 1, completed: 1, bytes: bad.metadata.bytes })
    expect([await completed(bad.id), await completed(good.id)]).toEqual([false, true])
    const logs = app.logs.entries().slice(logStart)
    expect(logs.filter(line => line.msg === TASK_FAILURE)).toMatchObject([{ level: 'warn', taskId: bad.id, failure: 'unsafe-path' }])
    expect(JSON.stringify(logs)).not.toContain(testAssetRoot(database.url))
    expect(await run()).toMatchObject({ ending: 'partial', retiredObjects: 0, failedTasks: 1 })
    expect(await completed(bad.id)).toBe(false)
  })

  it('M5R-M-02 整卷故障时每个待办都失败：逐条只记前 5 个，其余计入 failedTasks；卷恢复后下一轮全部回收', async () => {
    const tasks = []
    for (let i = 0; i < 6; i++)
      tasks.push(await queueAsset(app, database, owner))
    const objects = join(testAssetRoot(database.url), 'objects')
    const logStart = app.logs.entries().length
    // objects 目录的权限被改成 0755：存储根检查对每个任务都拒绝
    await chmod(objects, 0o755)
    try {
      expect(await run()).toMatchObject({ ending: 'partial', retiredObjects: 0, failedTasks: 6 })
    }
    finally {
      await chmod(objects, 0o700)
    }
    const logs = app.logs.entries().slice(logStart)
    expect(logs.filter(line => line.msg === TASK_FAILURE).map(line => line.taskId)).toEqual(tasks.slice(0, 5).map(task => task.id))
    expect(logs.filter(line => line.msg === '图片文件回收本轮失败的任务较多，之后的只计入 failedTasks、不再逐条记录')).toMatchObject([{ level: 'warn', logged: 5 }])
    expect((await retirementState(database)).pending).toBe(6)
    expect(await run()).toMatchObject({ ending: 'drained', retiredObjects: 6, failedTasks: 0 })
    expect(await retirementState(database)).toMatchObject({ pending: 0, completed: 6, bytes: 0 })
  })

  it('M5R-M-03 宽限已满但候选时刻不早于恢复水位：不回收，每轮给出被水位挡住的计数并告警（D-05）', async () => {
    const image = await stageOrphan(app, database, owner)
    // 对象在水位（2020-02-01）之后才变为无引用：宽限已满，但最近的备份可能还需要它
    await database.query(async client => client.query('UPDATE asset_objects SET unreferenced_at=\'2020-03-01T00:00:00.000Z\' WHERE sha256=$1', [image.metadata.sha256]))
    const logStart = app.logs.entries().length
    expect(await run()).toMatchObject({ ending: 'drained', queuedObjects: 0, blockedObjects: 1 })
    expect(app.logs.entries().slice(logStart).filter(line => line.msg === WATERMARK_WARNING)).toMatchObject([{ level: 'warn', blockedAssets: 0, blockedObjects: 1, blockedTasks: 0 }])
    expect((await retirementState(database)).pending).toBe(0)
  })

  it('M5R-M-03 资源记录与已登记的文件任务被水位挡住时同样计数，任务保持待办', async () => {
    await queueAsset(app, database, owner)
    const input = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
    const uploaded = await app.runtime.get(AssetUploadService).upload(await createAssetActor(database, owner), async () => ({ data: input, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
    await database.query(async client => client.query('UPDATE assets SET created_at=\'2019-12-01T00:00:00.000Z\',unreferenced_at=\'2020-01-01T00:00:00.000Z\' WHERE id=$1', [uploaded.assetId]))
    // 水位被挪回到候选时刻之前（例如改用更早的一份备份）：已登记的任务与资源记录都宽限已满，但那份备份之后它们仍可能被需要
    await app.close()
    app = await startTestApp({ databaseUrl: database.url, env: { ...GC_TEST_ENV, NERVE_ASSET_GC_BATCH: '1', NERVE_ASSET_GC_RECOVERY_BEFORE: '2019-12-31T00:00:00.000Z' } })
    const logStart = app.logs.entries().length
    expect(await run()).toMatchObject({ ending: 'paused', pauseReason: 'recovery-blocked', blockedAssets: 1, blockedTasks: 1, retiredObjects: 0, removedAssets: 0 })
    expect(app.logs.entries().slice(logStart).filter(line => line.msg === WATERMARK_WARNING)).toMatchObject([{ level: 'warn', blockedAssets: 1, blockedTasks: 1 }])
    expect((await retirementState(database)).pending).toBe(1)
  })
})

import type { TestApp } from '../support/api-app.ts'
import type { ApiProcess } from '../support/api-process.ts'
import type { TestDatabase } from '../support/database.ts'
import { fork } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { TransactionRunner } from '@nerve-office/api'
import { AssetReadService, AssetUploadService } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { serverEnvironment, startTestApp } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { GC_TEST_ENV, queueAsset, retirementState, stageOrphan } from '../support/asset-retirement.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { whileHolding } from '../support/held-lock.ts'

let database: TestDatabase
let owner: string
let app: TestApp | undefined
const processes: ApiProcess[] = []
const GATE_LOCK = 'asset-gc-process-gate'

beforeAll(async () => {
  database = await createTestDatabase()
  owner = (await createPassiveAccount(database, { username: 'gc-process-owner' })).id
  // 仅在隔离测试库注入边界停顿；真正的应用进程、SQL 事务和私有卷不作替换。
  await database.query(async client => client.query(`CREATE TABLE asset_gc_process_gate (stage text PRIMARY KEY, task_id uuid);
    CREATE FUNCTION asset_gc_process_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE boundary text;
    BEGIN
      IF TG_OP='INSERT' THEN boundary='queue';
      ELSIF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN boundary='complete';
      ELSE RETURN NEW;
      END IF;
      IF EXISTS (SELECT 1 FROM asset_gc_process_gate WHERE stage=boundary AND (task_id IS NULL OR task_id=NEW.id)) THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('asset-gc-process-gate',0));
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER asset_gc_process_gate BEFORE INSERT OR UPDATE ON asset_object_deletions FOR EACH ROW EXECUTE FUNCTION asset_gc_process_gate();`))
})
beforeEach(async () => {
  await database.query(async client => client.query('TRUNCATE asset_gc_process_gate, document_asset_links, document_checkpoint_assets, asset_reference_activity, assets, asset_objects, asset_object_claims, asset_object_deletions, asset_quota CASCADE'))
  app = await startTestApp({ databaseUrl: database.url, env: GC_TEST_ENV })
})
afterEach(async () => {
  for (const child of processes)
    child.kill('SIGKILL')
  await Promise.all(processes.map(async child => child.exited))
  processes.length = 0
  await app?.close()
  app = undefined
})
afterAll(async () => database?.drop())

async function stopApp() {
  await app?.close()
  app = undefined
}

function startGcProcess() {
  const child = startApiProcess(serverEnvironment(database.url, { ...GC_TEST_ENV, NERVE_ASSET_GC_INTERVAL_MS: '1000', NERVE_ASSET_GC_BATCH: '1' }))
  processes.push(child)
  return child
}

async function waitForBoundary() {
  await expect.poll(async () => database.query(async client => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND application_name='nerve-office-api' AND cardinality(pg_blocking_pids(pid))>0`)).rows[0]!.n), { timeout: 8000 }).toBe(1)
}

async function finishInFreshProcess(count: number) {
  const child = startGcProcess()
  const round = await child.waitForLog(line => line.job === 'asset-gc' && line.ending === 'drained')
  expect(round.retiredObjects).toBe(count)
  child.kill('SIGTERM')
  expect(await child.exited, child.output()).toEqual({ code: 0, signal: null })
  expect(child.output()).not.toContain(database.url)
}

describe('资源退休的真实进程边界与重启', () => {
  it.each(['before-rename', 'after-rename'])('%s：SIGKILL 保留收费，新进程接续且同 hash 新代次可读', async (stage) => {
    const task = await queueAsset(app!, database, owner)
    const root = testAssetRoot(database.url)
    await stopApp()
    const child = fork(new URL('./retirement-crash.test-support.mjs', import.meta.url), [stage], {
      execArgv: [],
      env: { PATH: process.env.PATH, ...serverEnvironment(database.url, GC_TEST_ENV) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      stderr += text
    })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    try {
      expect(await new Promise<unknown>((resolve, reject) => {
        child.once('message', resolve)
        child.once('exit', code => reject(new Error(`退休崩溃夹具提前退出 ${String(code)}：${stderr}`)))
        child.once('error', reject)
      })).toEqual({ stage })
      expect((await stat(join(root, task.metadata.storageKey))).size).toBe(stage === 'before-rename' ? task.metadata.bytes : 0)
      expect(await retirementState(database)).toEqual({ bytes: task.metadata.bytes, assets: 0, pending: 1, completed: 0 })
      child.kill('SIGKILL')
      await closed
      expect(child.signalCode).toBe('SIGKILL')
      app = await startTestApp({ databaseUrl: database.url, env: GC_TEST_ENV })
      const data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
      const actor = await createAssetActor(database, owner)
      const fresh = await app.runtime.get(AssetUploadService).upload(actor, async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
      const reader = app.runtime.get(AssetReadService)
      const metadata = (await app.runtime.get(TransactionRunner).readSnapshot(async tx => reader.metadata(fresh.assetId, tx)))!
      expect(metadata.storageKey).not.toBe(task.metadata.storageKey)
      expect((await retirementState(database)).bytes).toBe(task.metadata.bytes * 2)
      await stopApp()
      await finishInFreshProcess(1)
      expect(await retirementState(database)).toEqual({ bytes: metadata.bytes, assets: 1, pending: 0, completed: 1 })
      expect(await readFile(join(root, metadata.storageKey))).toEqual(task.data)
      expect((await stat(join(root, task.metadata.storageKey))).size).toBe(0)
      // 另一全新应用走正式读取服务；再跑一轮不再释放已经确认的旧代次费用。
      app = await startTestApp({ databaseUrl: database.url, env: GC_TEST_ENV })
      expect((await app.runtime.get(AssetReadService).readAuthorized(metadata)).data).toEqual(task.data)
      await stopApp()
      await finishInFreshProcess(0)
      expect((await retirementState(database)).bytes).toBe(metadata.bytes)
    }
    finally {
      child.kill('SIGKILL')
      await closed
    }
  })

  it.each(['queue', 'complete'])('%s 提交前 SIGKILL：当前短事务回滚，重启只完成一次', async (boundary) => {
    const task = boundary === 'queue' ? await stageOrphan(app!, database, owner) : await queueAsset(app!, database, owner)
    await stopApp()
    await database.query(async client => client.query('INSERT INTO asset_gc_process_gate(stage) VALUES($1)', [boundary]))
    await whileHolding(database, async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [GATE_LOCK]), async () => {
      const child = startGcProcess()
      await waitForBoundary()
      expect((await stat(join(testAssetRoot(database.url), task.metadata.storageKey))).size).toBe(boundary === 'queue' ? task.metadata.bytes : 0)
      child.kill('SIGKILL')
      expect(await child.exited).toEqual({ code: null, signal: 'SIGKILL' })
    })
    expect(await retirementState(database)).toEqual({ bytes: task.metadata.bytes, assets: 0, pending: boundary === 'queue' ? 0 : 1, completed: 0 })
    const objects = await database.query(async client => (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM asset_objects')).rows[0]!.n)
    expect(objects).toBe(boundary === 'queue' ? 1 : 0)
    await database.query(async client => client.query('DELETE FROM asset_gc_process_gate'))
    await finishInFreshProcess(1)
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 1 })
  })

  it('SIGTERM 完成手上文件的确认后退出，下一进程接续剩余两项', async () => {
    const tasks: Awaited<ReturnType<typeof queueAsset>>[] = []
    for (let i = 0; i < 3; i++)
      tasks.push(await queueAsset(app!, database, owner))
    tasks.sort((a, b) => a.id.localeCompare(b.id))
    await stopApp()
    await database.query(async client => client.query('INSERT INTO asset_gc_process_gate(stage,task_id) VALUES(\'complete\',$1)', [tasks[0]!.id]))
    let child: ApiProcess | undefined
    await whileHolding(database, async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [GATE_LOCK]), async () => {
      child = startGcProcess()
      await waitForBoundary()
      child.kill('SIGTERM')
      await child.waitForLog(line => line.msg === '开始退出' && line.reason === 'SIGTERM')
    })
    expect(await child!.exited, child!.output()).toEqual({ code: 0, signal: null })
    expect(await retirementState(database)).toEqual({ bytes: tasks[0]!.metadata.bytes * 2, assets: 0, pending: 2, completed: 1 })
    const round = await child!.waitForLog(line => line.job === 'asset-gc' && line.ending === 'stopped')
    expect(round.retiredObjects).toBe(1)
    await database.query(async client => client.query('DELETE FROM asset_gc_process_gate'))
    await finishInFreshProcess(2)
    expect(await retirementState(database)).toEqual({ bytes: 0, assets: 0, pending: 0, completed: 3 })
  })
})

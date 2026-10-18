import type { AssetUploadActor } from '@nerve-office/api'
import type { FileStorage } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import fs, { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransactionRunner } from '@nerve-office/api'
import { ASSET_STORAGE, AssetUploadService, ImageRunner } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { invariantViolations } from '../support/invariants.ts'

let database: TestDatabase
let app: TestApp
let directory: string
let root: string
let uploader: AssetUploadActor
let uploads: AssetUploadService
let storage: FileStorage
let transactions: TransactionRunner
let data: Buffer
beforeAll(async () => {
  database = await createTestDatabase()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'nerve-assets-faults-')))
  root = join(directory, 'assets')
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
  uploads = app.runtime.get(AssetUploadService)
  storage = app.runtime.get<FileStorage>(ASSET_STORAGE)
  transactions = app.runtime.get(TransactionRunner)
  uploader = await createAssetActor(database, (await createPassiveAccount(database, { username: 'asset-fault-uploader' })).id)
  data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
})
beforeEach(async () => {
  await database.query(async client => client.query('TRUNCATE assets, asset_objects, asset_object_claims, asset_quota'))
  await rm(join(root, 'objects'), { recursive: true })
  await mkdir(join(root, 'objects'), { mode: 0o700 })
})
afterEach(async () => {
  vi.restoreAllMocks()
  expect(await database.query(invariantViolations)).toEqual([])
  expect(await readdir(join(root, 'staging'))).toEqual([])
  expect(app.runtime.get(ImageRunner).liveProcesses).toBe(0)
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
})

async function upload(signal = new AbortController().signal) {
  return uploads.upload(uploader, async () => ({ data, mimeType: 'image/png', extension: 'png' }), signal)
}
async function state() {
  return database.query(async client => (await client.query<{ bytes: number, count: number, claims: number, objects: number }>(`SELECT used_bytes::integer AS bytes, used_assets AS count,
    (SELECT count(*)::integer FROM asset_object_claims) AS claims, (SELECT count(*)::integer FROM asset_objects) AS objects FROM asset_quota`)).rows[0]!)
}
async function objectFiles(): Promise<string[]> {
  return (await readdir(join(root, 'objects'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

describe('真实配额与文件的失败边界', () => {
  it('预留后文件系统拒绝发布，保留收费 claim；修复目录后同图恢复且只计一次', async () => {
    const staging = join(root, 'staging')
    await rename(staging, join(root, 'held-staging'))
    await mkdir(staging, { mode: 0o755 })
    try {
      await expect(upload()).rejects.toMatchObject({ name: 'AssetStorageError', reason: 'unsafe-path' })
      expect(await state()).toMatchObject({ count: 0, claims: 1, objects: 0 })
      expect(await objectFiles()).toEqual([])
    }
    finally {
      await rm(staging, { recursive: true })
      await rename(join(root, 'held-staging'), staging)
    }
    const reserved = (await state()).bytes
    await upload()
    expect(await state()).toEqual({ bytes: reserved, count: 1, claims: 0, objects: 1 })
  })

  it('文件发布后数据库真实语句失败，文件仍完整且预留仍在，恢复数据库后能转正', async () => {
    await database.query(async (client) => {
      await client.query('CREATE FUNCTION reject_test_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'controlled asset insert failure\'; END $$')
      await client.query('CREATE TRIGGER reject_test_asset BEFORE INSERT ON assets FOR EACH ROW EXECUTE FUNCTION reject_test_asset()')
    })
    try {
      await expect(upload()).rejects.toThrow()
      expect(await state()).toMatchObject({ count: 0, claims: 1, objects: 0 })
      expect(await objectFiles()).toHaveLength(1)
    }
    finally {
      await database.query(async (client) => {
        await client.query('DROP TRIGGER reject_test_asset ON assets')
        await client.query('DROP FUNCTION reject_test_asset()')
      })
    }
    const reserved = (await state()).bytes
    const response = await upload()
    expect((await readFile((await objectFiles())[0]!)).length).toBe(response.bytes)
    expect(await state()).toEqual({ bytes: reserved, count: 1, claims: 0, objects: 1 })
  })

  it.each([1, 2])('第 %i 个真实事务提交后向服务抛出回执丢失，保守留账且重试不绕过字节配额', async (lostAt) => {
    const original = transactions.run.bind(transactions)
    let calls = 0
    // 不 mock 数据库：事务照常真实提交，仅在提交返回到业务调用方的边界注入回执丢失。
    const injected = vi.spyOn(transactions, 'run').mockImplementation(async (work, options) => {
      const result = await original(work, options)
      calls++
      if (calls === lostAt)
        throw new Error('controlled commit acknowledgement loss')
      return result
    })
    await expect(upload()).rejects.toThrow('controlled commit acknowledgement loss')
    injected.mockRestore()
    const before = await state()
    expect(before).toMatchObject(lostAt === 1 ? { count: 0, claims: 1, objects: 0 } : { count: 1, claims: 0, objects: 1 })
    expect(await objectFiles()).toHaveLength(lostAt === 1 ? 0 : 1)
    await upload()
    expect(await state()).toEqual({ bytes: before.bytes, count: lostAt, claims: 0, objects: 1 })
  })

  it('现有完整对象被改坏时不覆盖、不创建第二个 asset；修复后恢复', async () => {
    await upload()
    const path = (await objectFiles())[0]!
    const original = await readFile(path)
    const corrupted = Buffer.from(original)
    corrupted[0] = corrupted[0]! ^ 1
    await writeFile(path, corrupted)
    const before = await state()
    await expect(upload()).rejects.toMatchObject({ name: 'AssetStorageError', reason: 'integrity' })
    expect(await readFile(path)).toEqual(corrupted)
    expect(await state()).toEqual(before)
    await writeFile(path, original)
    await upload()
    expect((await state()).count).toBe(2)
  })

  it('完成真实发布后客户端取消，不转正、不释放预留；下一次恢复', async () => {
    const controller = new AbortController()
    const original = storage.publish.bind(storage)
    const injected = vi.spyOn(storage, 'publish').mockImplementationOnce(async (image) => {
      const key = await original(image)
      controller.abort()
      return key
    })
    await expect(upload(controller.signal)).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
    injected.mockRestore()
    expect(await state()).toMatchObject({ count: 0, claims: 1, objects: 0 })
    expect(await objectFiles()).toHaveLength(1)
    await upload()
    expect(await state()).toMatchObject({ count: 1, claims: 0, objects: 1 })
  })

  it.each([false, true])('占用连接丢失=%s：新实例仅清无人占用的临时文件；两份发布不会覆盖同一对象', async (lost) => {
    let reached: () => void
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    let resume: () => void
    const continuation = new Promise<void>((resolve) => {
      resume = resolve
    })
    const link = fs.link
    vi.spyOn(fs, 'link').mockImplementationOnce(async (source, target) => {
      reached()
      await continuation
      return link(source, target)
    })
    const old = upload().then(() => undefined, (error: unknown) => error)
    let second: TestApp | undefined
    try {
      await paused
      const holders = await database.query(async client => (await client.query<{ pid: number }>('SELECT DISTINCT a.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = \'advisory\' AND a.datname = current_database()')).rows)
      expect(holders).toHaveLength(1)
      // 真正终止数据库占用连接，原业务调用仍停在文件 IO 前：模拟连接断开但进程还活着。
      if (lost)
        await database.query(async client => client.query('SELECT pg_terminate_backend($1)', [holders[0]!.pid]))
      second = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
      expect(await readdir(join(root, 'staging'))).toHaveLength(1)
      await second.runtime.get(AssetUploadService).upload(uploader, async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
      expect(await readdir(join(root, 'staging'))).toHaveLength(lost ? 0 : 1)
      resume!()
      if (lost)
        expect(await old).toMatchObject({ name: 'AssetStorageError', reason: 'io' })
      else
        expect(await old).toBeUndefined()
      expect(await state()).toMatchObject({ count: lost ? 1 : 2, claims: 0, objects: 1 })
      expect(await objectFiles()).toHaveLength(1)
    }
    finally {
      resume!()
      await old
      await second?.close()
    }
  })

  it('文件发布后撤销会话，转正事务回滚；已发布文件保留预留，新的登录可继续恢复', async () => {
    const actor = await createAssetActor(database, uploader.userId)
    const original = storage.publish.bind(storage)
    const injected = vi.spyOn(storage, 'publish').mockImplementationOnce(async (image) => {
      const key = await original(image)
      await database.query(async client => client.query('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = \'logout\' WHERE id = $1', [actor.sessionId]))
      return key
    })
    await expect(uploads.upload(actor, async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal))
      .rejects
      .toMatchObject({ code: 'SESSION_EXPIRED', details: { reason: 'logout' } })
    injected.mockRestore()
    expect(await state()).toMatchObject({ count: 0, claims: 1, objects: 0 })
    expect(await objectFiles()).toHaveLength(1)
    const reserved = (await state()).bytes
    await upload()
    expect(await state()).toEqual({ bytes: reserved, count: 1, claims: 0, objects: 1 })
  })
})

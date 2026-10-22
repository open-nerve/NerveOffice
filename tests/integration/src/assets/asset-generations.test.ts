import type { AssetObjectMetadata, FileStorage } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TransactionRunner } from '@nerve-office/api'
import { ASSET_STORAGE, assetObjectKey, AssetReadService, AssetsRepository, AssetUploadService } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { invariantViolations } from '../support/invariants.ts'

let database: TestDatabase
let app: TestApp
let repository: AssetsRepository
let transactions: TransactionRunner
let storage: FileStorage
let reader: AssetReadService
let uploader: string
const limits = { quotaBytes: 1_000_000, quotaCount: 100 }
const data = Buffer.from('abc')
const image: AssetObjectMetadata = { sha256: createHash('sha256').update(data).digest('hex'), bytes: 3, mimeType: 'image/png', width: 1, height: 1, frames: 1 }

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  repository = app.runtime.get(AssetsRepository)
  transactions = app.runtime.get(TransactionRunner)
  storage = app.runtime.get<FileStorage>(ASSET_STORAGE)
  reader = app.runtime.get(AssetReadService)
  uploader = (await createPassiveAccount(database, { username: 'asset-generation-owner' })).id
})
beforeEach(async () => database.query(async client => client.query('TRUNCATE document_asset_links, document_checkpoint_assets, asset_reference_activity, assets, asset_objects, asset_object_claims, asset_quota')))
afterEach(async () => expect(await database.query(invariantViolations)).toEqual([]))
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function reserve() {
  return transactions.run(async tx => repository.reserve(image, limits, tx))
}

describe('持久上传代次回执', () => {
  it('新 hash 分配代次，同 hash 并发预留/转正共用代次并只占一次字节', async () => {
    const reservations = await Promise.all(Array.from({ length: 8 }, async () => reserve()))
    expect(reservations[0]?.sha256).toBe(image.sha256)
    expect(reservations[0]?.generation).toMatch(/^[0-9a-f-]{36}$/)
    expect(reservations[0]?.storageKey).toMatch(/\.[0-9a-f-]{36}$/)
    expect(new Set(reservations.map(item => item.storageKey)).size).toBe(1)
    for (const reservation of reservations) {
      await storage.publish({ ...image, data }, reservation.storageKey)
      await transactions.run(async tx => repository.finalize(randomUUID(), uploader, image, limits, tx, reservation))
    }
    expect(await reserve()).toEqual(reservations[0])
    expect(await database.query(async client => (await client.query<{ used_bytes: number, used_assets: number }>('SELECT used_bytes::integer, used_assets FROM asset_quota')).rows)).toEqual([{ used_bytes: 3, used_assets: 8 }])
  })

  it.each(['generation', 'sha256', 'storageKey'])('回执的 %s 不匹配不能转正，原预留仍可继续', async (field) => {
    const reservation = await reserve()
    const other = randomUUID()
    const stale = {
      ...reservation,
      ...(field === 'generation' ? { generation: other } : field === 'sha256' ? { sha256: 'c'.repeat(64) } : { storageKey: assetObjectKey(image.sha256, other) }),
    }
    await expect(transactions.run(async tx => repository.finalize(randomUUID(), uploader, image, limits, tx, stale))).rejects.toMatchObject({ code: 'ASSET_BUSY' })
    await storage.publish({ ...image, data }, reservation.storageKey)
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, image, limits, tx, reservation))
    expect(await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM assets')).rows)).toEqual([{ count: 1 }])
  })

  it('旧 claim 被替换后，新代次不能被旧发布借用，正式读取只使用新代次', async () => {
    const first = await reserve()
    expect(first).toBeDefined()
    await storage.publish({ ...image, data }, first.storageKey)
    // 本用例只验证代次栅栏；真实持久退休与收费接续由后续 GC 用例覆盖。
    await database.query(async (client) => {
      await client.query('BEGIN')
      await client.query('DELETE FROM asset_object_claims WHERE sha256=$1', [image.sha256])
      await client.query('UPDATE asset_quota SET used_bytes=0')
      await client.query('COMMIT')
    })
    const second = await reserve()
    expect(second.storageKey).not.toBe(first.storageKey)
    await storage.publish({ ...image, data }, second.storageKey)
    await expect(transactions.run(async tx => repository.finalize(randomUUID(), uploader, image, limits, tx, first))).rejects.toThrow()
    const id = randomUUID()
    await transactions.run(async tx => repository.finalize(id, uploader, image, limits, tx, second))
    const metadata = (await transactions.readSnapshot(async tx => reader.metadata(id, tx)))!
    expect(metadata.storageKey).toBe(second.storageKey)
    expect((await reader.readAuthorized(metadata)).data).toEqual(data)
  })

  it('迁移前的 claim 和固定 hash 文件仍能继续转正和读取，不改写旧文件', async () => {
    await database.query(async (client) => {
      await client.query('INSERT INTO asset_quota(id,used_bytes,used_assets) VALUES (1,3,0)')
      await client.query('INSERT INTO asset_object_claims(sha256,bytes) VALUES ($1,3)', [image.sha256])
    })
    const reservation = await reserve()
    expect(reservation).toEqual({ sha256: image.sha256, generation: null, storageKey: `objects/ba/${image.sha256}` })
    await storage.publish({ ...image, data }, reservation.storageKey)
    const id = randomUUID()
    await transactions.run(async tx => repository.finalize(id, uploader, image, limits, tx, reservation))
    const metadata = (await transactions.readSnapshot(async tx => reader.metadata(id, tx)))!
    expect(metadata.storageKey).toBe(`objects/ba/${image.sha256}`)
    expect((await reader.readAuthorized(metadata)).data).toEqual(data)
  })

  it('真实图片上传的公开响应不泄露路径，实际文件和服务器读取使用预留代次', async () => {
    const actor = await createAssetActor(database, uploader)
    const input = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
    const uploaded = await app.runtime.get(AssetUploadService).upload(actor, async () => ({ data: input, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
    const metadata = (await transactions.readSnapshot(async tx => reader.metadata(uploaded.assetId, tx)))!
    expect(metadata.storageKey).toMatch(/\.[0-9a-f-]{36}$/)
    expect(JSON.stringify(uploaded)).not.toContain(metadata.storageKey)
    expect(await readFile(join(testAssetRoot(database.url), metadata.storageKey))).toEqual((await reader.readAuthorized(metadata)).data)
  })

  it('数据库同时接受旧键与对应代次键，拒绝路径和代次交叉组合', async () => {
    const generation = randomUUID()
    const other = randomUUID()
    const legacy = `objects/ba/${image.sha256}`
    for (const [key, gen] of [[legacy, generation], [`${legacy}.${generation}`, null], [`${legacy}.${generation}`, other]]) {
      await expect(database.query(async client => client.query('INSERT INTO asset_objects(sha256, generation, storage_key, mime_type, width, height, frames, bytes) VALUES ($1,$2,$3,\'image/png\',1,1,1,3)', [image.sha256, gen, key])))
        .rejects
        .toMatchObject({ code: '23514', constraint: 'asset_objects_key_check' })
    }
  })
})

import type { AssetUploadActor } from '@nerve-office/api'
import type { AssetMetadata, Database } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TransactionRunner } from '@nerve-office/api'
import { AssetReadService, AssetUploadService } from '@nerve-office/api/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'

let database: TestDatabase
let app: TestApp
let reader: AssetReadService
let uploads: AssetUploadService
let transactions: TransactionRunner
let actor: AssetUploadActor
let other: AssetUploadActor
let spaceId: string

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  reader = app.runtime.get(AssetReadService)
  uploads = app.runtime.get(AssetUploadService)
  transactions = app.runtime.get(TransactionRunner)
  const account = await createPassiveAccount(database, { username: 'asset-reader-owner' })
  actor = await createAssetActor(database, account.id)
  spaceId = account.personalSpaceId
  other = await createAssetActor(database, (await createPassiveAccount(database, { username: 'asset-reader-other' })).id)
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function upload(file = 'minimum.png', mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' = 'image/png', extension: 'png' | 'jpg' | 'webp' | 'gif' = 'png', uploader = actor) {
  const data = await readFile(new URL(`../../../../apps/api/src/modules/assets/testdata/${file}`, import.meta.url))
  return uploads.upload(uploader, async () => ({ data, mimeType, extension }), new AbortController().signal)
}
async function metadata(id: string): Promise<AssetMetadata | undefined> {
  return transactions.readSnapshot(async transaction => reader.metadata(id, transaction))
}

describe('资源元数据与已授权文件读取的公开边界', () => {
  it.each([
    ['minimum.png', 'image/png', 'png'],
    ['orientation.jpg', 'image/jpeg', 'jpg'],
    ['animated.webp', 'image/webp', 'webp'],
    ['zero-delay-gif.gif', 'image/gif', 'gif'],
  ] as const)('%s：真实上传的元数据与完整重编码字节一致', async (file, mimeType, extension) => {
    const uploaded = await upload(file, mimeType, extension)
    const record = await metadata(uploaded.assetId)
    expect(record).toMatchObject({ assetId: uploaded.assetId, uploaderId: actor.userId, withinUploadWindow: true, mimeType, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes })
    expect(record!.createdAt).toBeInstanceOf(Date)
    const image = await reader.readAuthorized(record!)
    expect(image.mimeType).toBe(mimeType)
    expect(image.data.length).toBe(uploaded.bytes)
    expect(createHash('sha256').update(image.data).digest('hex')).toBe(record!.sha256)
  })

  it('不存在 ID 没有元数据；同物理对象仍保留各自上传者与创建时间', async () => {
    expect(await metadata(randomUUID())).toBeUndefined()
    const first = await upload()
    const second = await upload('minimum.png', 'image/png', 'png', other)
    await database.query(async client => client.query('UPDATE assets SET created_at = now() - interval \'25 hours\' WHERE id = $1', [first.assetId]))
    const a = (await metadata(first.assetId))!
    const b = (await metadata(second.assetId))!
    expect(a.sha256).toBe(b.sha256)
    expect(a).toMatchObject({ uploaderId: actor.userId, withinUploadWindow: false })
    expect(b).toMatchObject({ uploaderId: other.userId, withinUploadWindow: true })
    expect(a.createdAt.getTime()).toBeLessThan(b.createdAt.getTime())
  })

  it.each([[86_399_999, true], [86_400_000, false], [86_400_001, false]] as const)('数据库同一时刻距上传 %i ms：24h 窗口为 %s', async (age, allowed) => {
    const uploaded = await upload()
    await transactions.run(async (transaction) => {
      // 仅测试在实际事务内控制 created_at；生产服务不持有可执行 SQL 的句柄。
      await (transaction as unknown as Database).execute(sql`UPDATE assets SET created_at = now() - ${age} * interval '1 millisecond' WHERE id = ${uploaded.assetId}`)
      expect((await reader.metadata(uploaded.assetId, transaction))!.withinUploadWindow).toBe(allowed)
    })
  })

  it('缺失与损坏文件不能返回假成功，存储错误不带实际路径', async () => {
    const record = (await metadata((await upload('rgba-text.png')).assetId))!
    const path = join(testAssetRoot(database.url), record.storageKey)
    const original = await readFile(path)
    await rename(path, `${path}.held`)
    try {
      const error: unknown = await reader.readAuthorized(record).catch((cause: unknown) => cause)
      expect(error).toMatchObject({ name: 'AssetStorageError', reason: 'io' })
      expect(String(error)).not.toContain(path)
    }
    finally {
      await rename(`${path}.held`, path)
    }
    try {
      await writeFile(path, 'broken')
      await expect(reader.readAuthorized(record)).rejects.toMatchObject({ name: 'AssetStorageError', reason: 'integrity' })
    }
    finally {
      await writeFile(path, original)
    }
    expect((await reader.readAuthorized(record)).data).toEqual(original)
  })
})

describe('当前引用表的真实约束', () => {
  it('引用唯一、两端必须存在；资源不能直接删除，文档删除级联引用且保留资源', async () => {
    const uploaded = await upload()
    const document = await seedDocument(database, { spaceId, createdBy: actor.userId, title: '资源引用约束' })
    const insert = 'INSERT INTO document_asset_links (document_id, asset_id) VALUES ($1, $2)'
    await database.query(async client => client.query(insert, [document.id, uploaded.assetId]))
    await expect(database.query(async client => client.query(insert, [document.id, uploaded.assetId]))).rejects.toMatchObject({ code: '23505' })
    await expect(database.query(async client => client.query(insert, [randomUUID(), uploaded.assetId]))).rejects.toMatchObject({ code: '23503' })
    await expect(database.query(async client => client.query(insert, [document.id, randomUUID()]))).rejects.toMatchObject({ code: '23503' })
    await expect(database.query(async client => client.query('DELETE FROM assets WHERE id = $1', [uploaded.assetId]))).rejects.toMatchObject({ code: '23001', constraint: 'document_asset_links_asset_id_assets_id_fk' })
    await database.query(async client => client.query('DELETE FROM documents WHERE id = $1', [document.id]))
    expect(await database.query(async client => (await client.query('SELECT * FROM document_asset_links WHERE document_id = $1', [document.id])).rowCount)).toBe(0)
    expect(await metadata(uploaded.assetId)).toBeDefined()
  })
})

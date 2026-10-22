import type { TestApp } from './api-app.ts'
import type { TestDatabase } from './database.ts'
import { readFile } from 'node:fs/promises'
import { TransactionRunner } from '@nerve-office/api'
import { AssetGcService, AssetReadService, AssetUploadService, DocumentAssetRetentionService } from '@nerve-office/api/testing'
import { createAssetActor } from './assets.ts'

/** 隔离测试库的备份声明；所有候选也显式布置为早于这个水位，不用于任何开发/部署数据。 */
export const GC_TEST_ENV = {
  NERVE_ASSET_GC_ENABLED: 'true',
  NERVE_ASSET_GC_GRACE_DAYS: '1',
  NERVE_BACKUP_RETENTION_DAYS: '1',
  NERVE_ASSET_GC_RECOVERY_BEFORE: '2020-02-01T00:00:00.000Z',
}

/** 实际 PNG 经正式处理/发布；仅把已验证过的候选时间条件布置为成熟，后续使用正式 GC 事务。 */
export async function stageOrphan(app: TestApp, database: TestDatabase, owner: string) {
  const input = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
  const actor = await createAssetActor(database, owner)
  const uploaded = await app.runtime.get(AssetUploadService).upload(actor, async () => ({ data: input, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
  const reader = app.runtime.get(AssetReadService)
  const metadata = (await app.runtime.get(TransactionRunner).readSnapshot(async tx => reader.metadata(uploaded.assetId, tx)))!
  const data = (await reader.readAuthorized(metadata)).data
  await database.query(async client => client.query('UPDATE assets SET created_at=\'2019-12-01T00:00:00.000Z\',unreferenced_at=\'2020-01-01T00:00:00.000Z\' WHERE id=$1', [uploaded.assetId]))
  const result = await app.runtime.get(AssetGcService).scanAssets(app.runtime.get(DocumentAssetRetentionService), { through: uploaded.assetId, limit: 100 })
  if (result.removed !== 1)
    throw new Error('文件回收夹具没有移除孤儿资源记录')
  await database.query(async (client) => {
    const changed = await client.query('UPDATE asset_objects o SET unreferenced_at=\'2020-01-01T00:00:00.000Z\' WHERE sha256=$1 AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.object_hash=o.sha256)', [metadata.sha256])
    if (changed.rowCount !== 1)
      throw new Error('文件回收夹具仍有资源引用')
  })
  const image = { sha256: metadata.sha256, bytes: metadata.bytes, mimeType: metadata.mimeType, width: metadata.width, height: metadata.height, frames: metadata.frames }
  return { metadata, data, image }
}

export async function queueAsset(app: TestApp, database: TestDatabase, owner: string) {
  const image = await stageOrphan(app, database, owner)
  const queued = await app.runtime.get(AssetGcService).scanObjects('object', { through: image.metadata.sha256, limit: 100 })
  if (queued.queued !== 1)
    throw new Error('文件回收夹具未登记持久任务')
  const id = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM asset_object_deletions WHERE storage_key=$1', [image.metadata.storageKey])).rows[0]!.id)
  return { ...image, id }
}

export async function retirementState(database: TestDatabase) {
  return database.query(async client => (await client.query<{ bytes: number, assets: number, pending: number, completed: number }>(`SELECT
    coalesce((SELECT used_bytes::int FROM asset_quota),0) AS bytes,
    coalesce((SELECT used_assets FROM asset_quota),0) AS assets,
    (SELECT count(*)::int FROM asset_object_deletions WHERE completed_at IS NULL) AS pending,
    (SELECT count(*)::int FROM asset_object_deletions WHERE completed_at IS NOT NULL) AS completed`)).rows[0]!)
}

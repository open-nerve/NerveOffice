// 仅由容器 E2E 编排器在本轮可销毁的库/卷内运行；不进入镜像、不提供生产 GC 命令。
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { AssetGcJob, AssetUploadService, ConfigError, createApplication, loadServerConfig } from '@nerve-office/api'
import pg from 'pg'

async function main() {
  assert.equal(process.env.NERVE_TEST_ASSET_GC_CONTAINER, 'disposable-compose')
  assert.equal(process.platform, 'linux')
  assert.notEqual(process.getuid(), 0)
  const timeout = setTimeout(() => process.exit(2), 30_000)
  const policy = {
    NERVE_ASSET_GC_ENABLED: 'true',
    NERVE_ASSET_GC_INTERVAL_MS: '3600000',
    NERVE_ASSET_GC_BATCH: '1',
    NERVE_ASSET_GC_GRACE_DAYS: '1',
    NERVE_BACKUP_RETENTION_DAYS: '1',
    NERVE_ASSET_GC_RECOVERY_BEFORE: '2020-02-01T00:00:00.000Z',
    NERVE_TRASH_PURGE_ENABLED: 'false',
    NERVE_HISTORY_PURGE_ENABLED: 'false',
    NERVE_REVISION_PURGE_ENABLED: 'false',
  }
  const environment = { ...process.env, ...policy }
  const config = loadServerConfig(environment)
  assert.equal(config.assets.root, '/var/lib/nerve-office/assets')
  const root = await stat(config.assets.root)
  assert.equal(root.mode & 0o777, 0o700)
  assert.equal(root.uid, process.getuid())
  const invalid = [
    [{ NERVE_BACKUP_RETENTION_DAYS: '2' }, 'NERVE_ASSET_GC_GRACE_DAYS'],
    [{ NERVE_ASSET_GC_RECOVERY_BEFORE: 'not-a-watermark' }, 'NERVE_ASSET_GC_RECOVERY_BEFORE'],
    [{ NERVE_TRASH_PURGE_ENABLED: 'true', NERVE_DATABASE_POOL_MAX: '2' }, 'NERVE_DATABASE_POOL_MAX'],
  ]
  for (const [values, variable] of invalid) {
    assert.throws(() => loadServerConfig({ ...environment, ...values }), error => error instanceof ConfigError && error.issues.some(issue => issue.variable === variable))
  }
  const db = new pg.Client({ connectionString: config.database.url.reveal() })
  let runtime
  const open = async extra => createApplication(loadServerConfig({ ...environment, ...extra }), { logDestination: process.stderr })
  const run = async () => runtime.get(AssetGcJob).runOnce(new Date())
  const usedBytes = async () => Number((await db.query('SELECT used_bytes FROM asset_quota')).rows[0]?.used_bytes ?? 0)
  try {
    await db.connect()
    const before = await usedBytes()
    const username = `gc-volume-${randomUUID().slice(0, 12)}`
    const userId = (await db.query('INSERT INTO users(username,display_name,password_hash,system_role,status) VALUES($1,$1,\'$argon2id$passive\',\'member\',\'active\') RETURNING id', [username])).rows[0].id
    await db.query('INSERT INTO spaces(type,name,owner_user_id) VALUES(\'personal\',$1,$2)', [username, userId])
    const sessionId = (await db.query('INSERT INTO auth_sessions(user_id,token_hash,idle_expires_at,absolute_expires_at) VALUES($1,$2,now()+interval \'1 hour\',now()+interval \'1 day\') RETURNING id', [userId, randomBytes(32)])).rows[0].id
    const input = Buffer.from(process.argv[1], 'base64')
    runtime = await open({ NERVE_BACKUP_RETENTION_DAYS: '', NERVE_ASSET_GC_RECOVERY_BEFORE: '' })
    const upload = async () => runtime.get(AssetUploadService).upload({ userId, sessionId }, async () => ({ data: input, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
    const metadata = async id => (await db.query('SELECT o.sha256,o.storage_key,o.bytes FROM assets a JOIN asset_objects o ON o.sha256=a.object_hash WHERE a.id=$1', [id])).rows[0]
    const asset = await upload()
    const old = await metadata(asset.assetId)
    const bytes = await readFile(join(config.assets.root, old.storage_key))
    await db.query('UPDATE assets SET created_at=\'2019-12-01T00:00:00.000Z\',unreferenced_at=\'2020-01-01T00:00:00.000Z\' WHERE id=$1', [asset.assetId])
    const paused = await run()
    assert.equal(paused.ending, 'paused')
    assert.equal(paused.removedAssets, 0)
    assert.deepEqual(await readFile(join(config.assets.root, old.storage_key)), bytes)
    await runtime.shutdown('容器 GC 配置切换')
    runtime = await open({})
    const records = await run()
    assert.equal(records.ending, 'drained')
    assert.equal(records.removedAssets, 1)
    assert.equal(records.retiredObjects, 0)
    assert.equal(await usedBytes(), before + asset.bytes)
    // 只推进本次上传的孤儿时刻；不扫描/改写其他候选，不替换正式 GC 事务。
    assert.equal((await db.query('UPDATE asset_objects SET unreferenced_at=\'2020-01-01T00:00:00.000Z\' WHERE storage_key=$1', [old.storage_key])).rowCount, 1)
    const collected = await run()
    assert.equal(collected.ending, 'drained')
    assert.equal(collected.retiredObjects, 1)
    assert.equal(collected.reclaimedBytes, asset.bytes)
    assert.equal(await usedBytes(), before)
    const marker = await stat(join(config.assets.root, old.storage_key))
    assert.equal(marker.size, 0)
    assert.equal(marker.mode & 0o777, 0o600)
    assert.equal(marker.uid, process.getuid())
    const fresh = await upload()
    const next = await metadata(fresh.assetId)
    assert.notEqual(next.storage_key, old.storage_key)
    assert.equal(next.sha256, old.sha256)
    assert.deepEqual(await readFile(join(config.assets.root, next.storage_key)), bytes)
    await runtime.shutdown('容器 GC 重开核对')
    runtime = await open({})
    const replay = await run()
    assert.equal(replay.ending, 'drained')
    assert.equal(replay.reclaimedBytes, 0)
    assert.equal(await usedBytes(), before + fresh.bytes)
    assert.deepEqual(await readFile(join(config.assets.root, next.storage_key)), bytes)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM asset_object_deletions WHERE storage_key=$1 AND completed_at IS NOT NULL', [old.storage_key])).rows[0].n, 1)
    process.stdout.write(`${JSON.stringify({ platform: process.platform, uid: process.getuid(), privateRoot: true, missingBackupPaused: true, invalidConfigurations: invalid.length, retiredObjects: collected.retiredObjects, markerBytes: marker.size, generationChanged: true, replayReleasedBytes: replay.reclaimedBytes, reuploadedReadable: true, verified: true })}\n`)
  }
  finally {
    await runtime?.shutdown('容器 GC 复核结束')
    await db.end()
    clearTimeout(timeout)
  }
}
void main()

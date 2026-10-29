import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { readExpectedMigrations, runMigrations } from '@nerve-office/api'
import { afterEach, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { migrationsUpTo, removeMigrationFolders } from '../support/migration-folders.ts'

const BASE = '0037_m5_asset_retirement'
const TARGET = '0038_m5_asset_reference_batch'
const ASSETS = [
  '0199a2c4-1111-7000-8000-000000000001',
  '0199a2c4-1111-7000-8000-000000000002',
  '0199a2c4-1111-7000-8000-000000000003',
  '0199a2c4-1111-7000-8000-000000000004',
] as const
let database: TestDatabase | undefined

afterEach(async () => {
  try {
    await database?.drop()
  }
  finally {
    database = undefined
    removeMigrationFolders()
  }
})

/** JSON 保留数据库时间的微秒；事务号转成字符串，不能经 JS number 丢精度。 */
async function storedData(db: TestDatabase) {
  return db.query(async (client) => {
    await client.query('SET TIME ZONE \'UTC\'')
    return {
      assets: (await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(a) AS data FROM assets a ORDER BY id')).rows,
      objects: (await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(o) AS data FROM asset_objects o ORDER BY sha256')).rows,
      current: (await client.query<{ document_id: string, asset_id: string }>('SELECT * FROM document_asset_links ORDER BY document_id, asset_id')).rows,
      checkpoints: (await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(c) AS data FROM document_checkpoints c ORDER BY id')).rows,
      historical: (await client.query<{ checkpoint_id: string, asset_id: string }>('SELECT * FROM document_checkpoint_assets ORDER BY checkpoint_id, asset_id')).rows,
      activity: (await client.query<{ asset_id: string, transaction_id: string }>('SELECT asset_id, transaction_id::text FROM asset_reference_activity ORDER BY asset_id, asset_reference_activity.transaction_id')).rows,
    }
  })
}

async function activityTriggers(db: TestDatabase) {
  return db.query(async client => (await client.query<{
    table_name: string
    trigger_name: string
    per_row: boolean
    inserts: boolean
    updates: boolean
    transition_rows: boolean
    enabled: string
  }>(`SELECT c.relname AS table_name, t.tgname AS trigger_name,
      (t.tgtype & 1) <> 0 AS per_row, (t.tgtype & 4) <> 0 AS inserts,
      (t.tgtype & 16) <> 0 AS updates, t.tgnewtable IS NOT NULL AS transition_rows,
      t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('document_asset_links','document_checkpoint_assets')
      AND NOT t.tgisinternal AND (t.tgtype & 2)=0 AND (t.tgtype & 20)<>0
    ORDER BY c.relname, t.tgname`)).rows)
}

it('有数据的0037库向前迁移：候选时间、两类引用和逐事务活动原样保留；重复迁移不重复安装且新引用仍记账', async () => {
  const db = await createTestDatabase({ migrated: false })
  database = db
  await runMigrations({ connectionString: db.url, lockTimeoutMs: 10_000, migrationsFolder: migrationsUpTo(BASE) })
  // 旧库只用 SQL 种子，不绕过应用的迁移就绪检查启动 App。
  const owner = await createPassiveAccount(db, { username: 'activity-migration-owner' })
  const source = await seedDocument(db, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '迁移前引用' })
  const target = await seedDocument(db, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '迁移后引用' })
  const checkpoints = await db.query(async (client) => {
    const hash = 'a'.repeat(64)
    await client.query(`INSERT INTO asset_objects (sha256,storage_key,mime_type,width,height,frames,bytes,created_at)
      VALUES ($1,$2,'image/png',1,1,1,1,'2026-09-01T00:00:00.123456Z')`, [hash, `objects/aa/${hash}`])
    await client.query(`INSERT INTO assets (id,uploader_id,object_hash,created_at,unreferenced_at)
      VALUES ($1,$5,$6,'2026-09-02T00:00:00.123456Z','2026-10-01T01:02:03.123456Z'),
        ($2,$5,$6,'2026-09-03T00:00:00.654321Z',NULL),
        ($3,$5,$6,'2026-09-04T00:00:00.234567Z','2026-10-02T02:03:04.654321Z'),
        ($4,$5,$6,'2026-09-05T00:00:00.345678Z',NULL)`, [...ASSETS, owner.id, hash])
    await client.query('INSERT INTO asset_quota (id,used_bytes,used_assets) VALUES (1,1,4)')
    const ids: string[] = []
    for (const documentId of [source.id, target.id]) {
      const result = await client.query<{ id: string }>(`INSERT INTO document_checkpoints
        (source_document_id,kind,event_id,title,document_type,unit_id,profile,format_version,
         sdk_version,client_build,revision,formulas_pending,snapshot,raw_bytes,stored_bytes,
         content_hash,snapshot_hash,resource_names,saved_by,saved_at,created_at,expires_at)
        SELECT d.id,'before_upgrade',$2,d.title,d.type,d.unit_id,d.profile,d.format_version,
          d.sdk_version,d.client_build,d.revision,d.formulas_pending,c.snapshot,c.raw_bytes,c.stored_bytes,
          c.content_hash,sha256(c.snapshot),c.resource_names,r.saved_by,r.created_at,
          '2026-10-01T00:00:00.123456Z'::timestamptz,
          '2026-10-01T00:00:00.123456Z'::timestamptz + interval '30 days'
        FROM documents d JOIN document_contents c ON c.document_id=d.id
          JOIN document_revisions r ON r.document_id=d.id AND r.revision=d.revision
        WHERE d.id=$1 RETURNING id`, [documentId, randomUUID()])
      expect(result.rows).toHaveLength(1)
      ids.push(result.rows[0]!.id)
    }
    return ids
  })
  const firstTransaction = await db.query(async (client) => {
    await client.query('BEGIN')
    try {
      const xid = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid
      await client.query('INSERT INTO document_asset_links (document_id,asset_id) VALUES ($1,$2),($1,$3)', [source.id, ASSETS[0], ASSETS[1]])
      await client.query('INSERT INTO document_checkpoint_assets (checkpoint_id,asset_id) VALUES ($1,$2),($1,$3)', [checkpoints[0], ASSETS[0], ASSETS[2]])
      // 引用已经消失的活动也必须留到 GC 消费，迁移不能按现存关系重建活动表。
      await client.query('DELETE FROM document_asset_links WHERE asset_id=$1', [ASSETS[1]])
      await client.query('DELETE FROM document_checkpoint_assets WHERE asset_id=$1', [ASSETS[2]])
      await client.query('COMMIT')
      return xid
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
  const secondTransaction = await db.query(async (client) => {
    await client.query('BEGIN')
    try {
      const xid = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid
      await client.query('INSERT INTO document_asset_links (document_id,asset_id) VALUES ($1,$2)', [target.id, ASSETS[0]])
      await client.query('DELETE FROM document_asset_links WHERE document_id=$1', [target.id])
      await client.query('COMMIT')
      return xid
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
  expect(secondTransaction).not.toBe(firstTransaction)
  const before = await storedData(db)
  expect(before.assets).toHaveLength(4)
  expect(before.assets.map(row => row.data.unreferenced_at)).toEqual(['2026-10-01T01:02:03.123456+00:00', null, '2026-10-02T02:03:04.654321+00:00', null])
  expect(before.current).toEqual([{ document_id: source.id, asset_id: ASSETS[0] }])
  expect(before.historical).toEqual([{ checkpoint_id: checkpoints[0], asset_id: ASSETS[0] }])
  expect(before.activity).toEqual([
    { asset_id: ASSETS[0], transaction_id: firstTransaction },
    { asset_id: ASSETS[0], transaction_id: secondTransaction },
    { asset_id: ASSETS[1], transaction_id: firstTransaction },
    { asset_id: ASSETS[2], transaction_id: firstTransaction },
  ])

  expect(readExpectedMigrations().map(row => row.tag)).toContain(TARGET)
  const migrationsFolder = migrationsUpTo(TARGET)
  expect(await runMigrations({ connectionString: db.url, lockTimeoutMs: 10_000, migrationsFolder })).toEqual({ status: 'applied', applied: 1 })
  expect(await storedData(db)).toEqual(before)
  const triggers = await activityTriggers(db)
  expect(triggers).toEqual([
    { table_name: 'document_asset_links', trigger_name: 'document_assets_note_reference', per_row: false, inserts: true, updates: false, transition_rows: true, enabled: 'O' },
    { table_name: 'document_asset_links', trigger_name: 'document_assets_note_reference_update', per_row: true, inserts: false, updates: true, transition_rows: false, enabled: 'O' },
    { table_name: 'document_checkpoint_assets', trigger_name: 'checkpoint_assets_note_reference', per_row: false, inserts: true, updates: false, transition_rows: true, enabled: 'O' },
    { table_name: 'document_checkpoint_assets', trigger_name: 'checkpoint_assets_note_reference_update', per_row: true, inserts: false, updates: true, transition_rows: false, enabled: 'O' },
  ])
  expect(await runMigrations({ connectionString: db.url, lockTimeoutMs: 10_000, migrationsFolder })).toEqual({ status: 'current' })
  expect(await storedData(db)).toEqual(before)
  expect(await activityTriggers(db)).toEqual(triggers)

  const newTransaction = await db.query(async (client) => {
    await client.query('BEGIN')
    try {
      const xid = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid
      await client.query('INSERT INTO document_asset_links (document_id,asset_id) VALUES ($1,$2),($1,$3)', [target.id, ASSETS[1], ASSETS[3]])
      await client.query('INSERT INTO document_checkpoint_assets (checkpoint_id,asset_id) VALUES ($1,$2),($1,$3)', [checkpoints[1], ASSETS[2], ASSETS[3]])
      await client.query('COMMIT')
      return xid
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
  const after = await storedData(db)
  expect(after.assets).toEqual(before.assets)
  expect(after.objects).toEqual(before.objects)
  expect(after.checkpoints).toEqual(before.checkpoints)
  expect(after.current).toHaveLength(3)
  expect(after.current).toEqual(expect.arrayContaining([
    ...before.current,
    { document_id: target.id, asset_id: ASSETS[1] },
    { document_id: target.id, asset_id: ASSETS[3] },
  ]))
  expect(after.historical).toHaveLength(3)
  expect(after.historical).toEqual(expect.arrayContaining([
    ...before.historical,
    { checkpoint_id: checkpoints[1], asset_id: ASSETS[2] },
    { checkpoint_id: checkpoints[1], asset_id: ASSETS[3] },
  ]))
  expect(after.activity.filter(row => row.transaction_id !== newTransaction)).toEqual(before.activity)
  expect(after.activity.filter(row => row.transaction_id === newTransaction)).toEqual([
    { asset_id: ASSETS[1], transaction_id: newTransaction },
    { asset_id: ASSETS[2], transaction_id: newTransaction },
    { asset_id: ASSETS[3], transaction_id: newTransaction },
  ])
})

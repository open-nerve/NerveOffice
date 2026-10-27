import type { Client } from 'pg'
import type { PassiveAccount } from '../support/accounts.ts'
import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'

let database: TestDatabase
let owner: PassiveAccount
const instant = '2026-10-22T10:59:59.999Z'
const hour = '2026-10-22T10:00:00.000Z'

beforeAll(async () => {
  database = await createTestDatabase()
  owner = await createPassiveAccount(database, { username: 'checkpoint-schema-owner' })
})
afterAll(async () => database?.drop())

async function document(): Promise<string> {
  return (await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '不可变历史' })).id
}

async function insert(client: Client, id: string, kind = 'hourly', eventId: string | null = null): Promise<string> {
  if (kind === 'hourly')
    await client.query('INSERT INTO document_history_buckets (document_id,hour_bucket) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, hour])
  const result = await client.query<{ id: string }>(`INSERT INTO document_checkpoints
    (source_document_id, kind, hour_bucket, event_id, title, document_type, unit_id, profile, format_version,
     sdk_version, client_build, revision, formulas_pending, snapshot, raw_bytes, stored_bytes, content_hash,
     snapshot_hash, resource_names, saved_by, saved_at, created_at, expires_at)
    SELECT d.id, $2, CASE WHEN $2 = 'hourly' THEN $4::timestamptz END, $3::uuid, d.title, d.type, d.unit_id, d.profile,
      d.format_version, d.sdk_version, d.client_build, d.revision, d.formulas_pending, c.snapshot, c.raw_bytes,
      c.stored_bytes, c.content_hash, sha256(c.snapshot), c.resource_names, r.saved_by, r.created_at,
      $5::timestamptz, $5::timestamptz + CASE WHEN $2 = 'hourly' THEN interval '7 days' ELSE interval '30 days' END
    FROM documents d JOIN document_contents c ON c.document_id = d.id
      JOIN document_revisions r ON r.document_id = d.id AND r.revision = d.revision
    WHERE d.id = $1 RETURNING id`, [id, kind, eventId, hour, instant])
  expect(result.rowCount).toBe(1)
  return result.rows[0]!.id
}

describe('历史存储的真实迁移边界', () => {
  it('提供独立正文、引用和小时占位，旧修订表不能代替历史正文', async () => {
    const names = ['document_checkpoints', 'document_checkpoint_assets', 'document_history_buckets']
    const found = await database.query(async client => (await client.query<{ name: string | null }>('SELECT to_regclass(name)::text AS name FROM unnest($1::text[]) AS n(name)', [names])).rows.map(row => row.name))
    expect(found).toEqual(names)
  })

  it('每份文档的同一 UTC 小时唯一；重复占位不能在删除历史后重建', async () => {
    const id = await document()
    await database.query(async (client) => {
      await client.query('INSERT INTO document_history_buckets (document_id, hour_bucket) VALUES ($1,$2)', [id, hour])
      const checkpoint = await insert(client, id)
      await expect(insert(client, id)).rejects.toMatchObject({ code: '23505' })
      await client.query('DELETE FROM document_checkpoints WHERE id=$1', [checkpoint])
      const result = await client.query('INSERT INTO document_history_buckets (document_id, hour_bucket) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING document_id', [id, hour])
      expect(result.rowCount).toBe(0)
    })
  })

  it('运维事件独立幂等，允许不同删除/升级事件，检查点不随源永久删除丢失', async () => {
    const id = await document()
    const event = randomUUID()
    await database.query(async (client) => {
      const checkpoint = await insert(client, id, 'before_delete', event)
      await expect(insert(client, id, 'before_delete', event)).rejects.toMatchObject({ code: '23505' })
      await insert(client, id, 'before_delete', randomUUID())
      await insert(client, id, 'before_upgrade', event)
      await client.query('DELETE FROM documents WHERE id=$1', [id])
      expect((await client.query('SELECT id FROM document_checkpoints WHERE id=$1', [checkpoint])).rowCount).toBe(1)
    })
  })

  it.each(['snapshot', 'title', 'expires_at', 'saved_by'] as const)('禁止覆盖既有检查点的 %s，即使写回同值也拒绝', async (column) => {
    const id = await document()
    await database.query(async (client) => {
      const checkpoint = await insert(client, id)
      // 列来自封闭测试枚举；证明数据库边界，避免只测仓储没有 update 方法。
      await expect(client.query(`UPDATE document_checkpoints SET ${column}=${column} WHERE id=$1`, [checkpoint])).rejects.toMatchObject({ code: '23514', constraint: 'document_checkpoints_immutable' })
      expect((await client.query('DELETE FROM document_checkpoints WHERE id=$1 RETURNING id', [checkpoint])).rowCount).toBe(1)
    })
  })

  it.each(['unknown', 'before_delete', 'before_upgrade'])('拒绝非法种类或缺运维事件：%s', async (kind) => {
    const id = await document()
    await expect(database.query(async client => insert(client, id, kind))).rejects.toMatchObject({ code: '23514' })
  })

  it('小时占位拒绝不存在源与非自然小时；源删除只级联清理占位', async () => {
    const id = await document()
    await database.query(async (client) => {
      await expect(client.query('INSERT INTO document_history_buckets (document_id,hour_bucket) VALUES ($1,$2)', [randomUUID(), hour])).rejects.toMatchObject({ code: '23503' })
      await expect(client.query('INSERT INTO document_history_buckets (document_id,hour_bucket) VALUES ($1,$2)', [id, instant])).rejects.toMatchObject({ code: '23514' })
      await client.query('INSERT INTO document_history_buckets (document_id,hour_bucket) VALUES ($1,$2)', [id, hour])
      await client.query('DELETE FROM documents WHERE id=$1', [id])
      expect((await client.query('SELECT * FROM document_history_buckets WHERE document_id=$1', [id])).rowCount).toBe(0)
    })
  })

  it('保存原 gzip 与旧空哈希，不伪造规范化哈希；图片引用必须指向实际 assetId', async () => {
    const id = await document()
    await database.query(async (client) => {
      const checkpoint = await insert(client, id)
      const result = await client.query(`SELECT p.snapshot = c.snapshot AS identical,
        p.snapshot_hash = sha256(c.snapshot) AS integrity, p.content_hash, p.resource_names,
        p.expires_at - p.created_at = interval '7 days' AS retained
        FROM document_checkpoints p JOIN document_contents c ON c.document_id=p.source_document_id WHERE p.id=$1`, [checkpoint])
      expect(result.rows).toEqual([{ identical: true, integrity: true, content_hash: null, resource_names: null, retained: true }])
      await expect(client.query('INSERT INTO document_checkpoint_assets (checkpoint_id,asset_id) VALUES ($1,$2)', [checkpoint, randomUUID()])).rejects.toMatchObject({ code: '23503' })
    })
  })

  it.each([
    { stored_bytes: 0 },
    { stored_bytes: 1 },
    { raw_bytes: 0 },
    { snapshot_hash: '\\x00' },
    { snapshot_hash: `\\x${'00'.repeat(32)}` },
    { content_hash: '\\x00', resource_names: [] },
    { content_hash: null, resource_names: [] },
    { revision: 0 },
    { format_version: 0 },
    { profile: '' },
    { event_id: '00000000-0000-4000-8000-000000000001' },
    { hour_bucket: null },
    { hour_bucket: '2026-10-22T11:00:00Z' },
    { expires_at: '2026-10-29T10:59:59.998Z' },
    { created_at: 'infinity', expires_at: 'infinity', hour_bucket: 'infinity' },
  ])('拒绝不一致的检查点元数据：%j', async (invalid) => {
    const id = await document()
    await database.query(async (client) => {
      const checkpoint = await insert(client, id)
      await expect(client.query(`INSERT INTO document_checkpoints
        SELECT (jsonb_populate_record(NULL::document_checkpoints,
          to_jsonb(p) || jsonb_build_object('id', $2::uuid) || $3::jsonb)).*
        FROM document_checkpoints p WHERE p.id=$1`, [checkpoint, randomUUID(), JSON.stringify(invalid)])).rejects.toMatchObject({ code: '23514' })
    })
  })
})

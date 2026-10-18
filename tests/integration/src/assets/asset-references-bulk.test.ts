import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { StatementCapture } from '../support/statement-capture.ts'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TransactionRunner } from '@nerve-office/api'
import { AssetUploadService, DocumentAssetReferences, DocumentsRepository } from '@nerve-office/api/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { captureStatements } from '../support/statement-capture.ts'

let database: TestDatabase
let app: TestApp
let capture: StatementCapture
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  capture = captureStatements(database.name)
})
afterAll(async () => {
  capture?.restore()
  await app?.close()
  await database?.drop()
})

const digest = (ids: readonly string[]): string => createHash('sha256').update(JSON.stringify(ids)).digest('hex')

it('七万个真实资源的来源查询、加锁和关系替换完整往返；绑定参数不随 ID 数量展开', async () => {
  const owner = await createPassiveAccount(database, { username: 'bulk-owner' })
  const editor = await createPassiveAccount(database, { username: 'bulk-editor' })
  const data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
  const uploaded = await app.runtime.get(AssetUploadService).upload(await createAssetActor(database, owner.id), async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
  const source = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '大集合来源' })
  const target = await seedDocument(database, { spaceId: editor.personalSpaceId, createdBy: editor.id, title: '大集合目标' })
  const ids = Array.from({ length: 70_000 }, (_, index) => `0199a2c4-1111-7000-8000-${index.toString(16).padStart(12, '0')}`)
  await database.query(async (client) => {
    await client.query(`INSERT INTO assets (id, uploader_id, object_hash, created_at)
      SELECT id, $2, (SELECT object_hash FROM assets WHERE id=$3), now() - interval '25 hours'
      FROM unnest($1::uuid[]) AS generated(id)`, [ids, owner.id, uploaded.assetId])
    await client.query('UPDATE asset_quota SET used_assets = used_assets + $1 WHERE id=1', [ids.length])
    await client.query('INSERT INTO document_asset_links (document_id, asset_id) SELECT $1, unnest($2::uuid[])', [source.id, ids])
    await client.query('INSERT INTO document_grants (document_id, user_id, role, granted_by) VALUES ($1,$2,\'viewer\',$3)', [source.id, editor.id, owner.id])
  })
  const references = app.runtime.get(DocumentAssetReferences)
  const targetRow = (await app.runtime.get(DocumentsRepository).findById(target.id))!
  const observed = await capture.during(async () => app.runtime.get(TransactionRunner).run(async (transaction) => {
    const prepared = await references.prepare(editor.id, ids, transaction, targetRow)
    expect(prepared.sources.map(row => row.id)).toEqual([source.id])
    const held = await references.hold(prepared, { mode: 'update' }, transaction)
    const authorized = await references.authorize(held, transaction)
    expect(authorized).toHaveLength(ids.length)
    expect(digest(authorized)).toBe(digest(ids))
    await references.replace(target.id, authorized, transaction)
  }))
  const actual = await database.query(async client => (await client.query<{ id: string }>('SELECT asset_id AS id FROM document_asset_links WHERE document_id=$1 ORDER BY asset_id', [target.id])).rows.map(row => row.id))
  expect(actual).toHaveLength(ids.length)
  expect(digest(actual)).toBe(digest(ids))
  expect(Math.max(...observed.queries.map(query => query.values.length))).toBeLessThan(16)
  expect(new Set(observed.queries.map(query => query.connection)).size).toBe(1)
  const locks = observed.statements.filter(statement => / for (?:share|update)$/u.test(statement))
  expect(locks).toHaveLength(3)
  expect(locks[0]).toMatch(/from "spaces".*order by "spaces"\."id" asc for share$/u)
  expect(locks[1]).toMatch(/from "documents".*order by "documents"\."id" asc for update$/u)
  expect(locks[2]).toMatch(/from "assets".*order by "assets"\."id" asc for share$/u)
}, 60_000)

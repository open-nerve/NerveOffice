import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { APPLICATION_NAME, DocumentCheckpointClock, DocumentCheckpointService } from '@nerve-office/api/testing'
import { createdFolderSchema, saveContentResponseSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let owner: TestAccount
let session: LoggedIn
let clock: DocumentCheckpointClock
let at: Date

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createAccount(database, { username: 'history-delete-owner' })
  session = await login(app.baseUrl, owner.username, owner.password)
  clock = app.runtime.get(DocumentCheckpointClock)
})
beforeEach(() => {
  at = new Date('2026-10-22T10:15:00Z')
  vi.spyOn(clock, 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

interface Checkpoint {
  source_document_id: string
  event_id: string
  revision: number
  snapshot: Buffer
  saved_by: string
  created_at: Date
  retained: boolean
  asset_ids: string[]
}

async function checkpoints(ids: readonly string[]): Promise<Checkpoint[]> {
  return database.query(async client => (await client.query<Checkpoint>(`SELECT p.source_document_id,p.event_id,p.revision,p.snapshot,p.saved_by,p.created_at,
    p.expires_at-p.created_at=interval '720 hours' AS retained,
    ARRAY(SELECT asset_id::text FROM document_checkpoint_assets WHERE checkpoint_id=p.id ORDER BY asset_id) AS asset_ids
    FROM document_checkpoints p WHERE p.source_document_id=ANY($1::uuid[]) AND p.kind='before_delete' ORDER BY p.source_document_id,p.id`, [ids])).rows)
}

async function document(folderId?: string, title = '删除前正文'): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title, ...(folderId === undefined ? {} : { folderId }) })
}

async function folder(parentId?: string): Promise<string> {
  const response = await asUser(app.baseUrl, session, '/api/folders', { method: 'POST', body: {
    spaceId: owner.personalSpaceId,
    name: '历史目录',
    requestId: randomUUID(),
    ...(parentId === undefined ? {} : { parentId }),
  } })
  expect(response.status, await response.clone().text()).toBe(201)
  return createdFolderSchema.parse(await response.json()).id
}

async function remove(path: string): Promise<Response> {
  return asUser(app.baseUrl, session, path, { method: 'DELETE' })
}

async function completed(response: Response, status = 204): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status)
  await response.arrayBuffer()
}

async function states(ids: readonly string[]) {
  return database.query(async client => (await client.query<{
    id: string
    status: string
    write_epoch: number
    trash_entry_id: string | null
  }>('SELECT id,status,write_epoch,trash_entry_id FROM documents WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows)
}

function signal() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('US-M5-11 删除前独立检查点', () => {
  it('捕获删除时的最新正文与图片，恢复再删除是新事件，永久删除不带走检查点', async () => {
    const doc = await document()
    const image = (await uploadTestAsset(app.baseUrl, session)).assetId
    const workbook = JSON.parse(pageSnapshot(doc.unitId, '删除前最新正文').toString('utf8')) as Record<string, unknown>
    const bytes = gzipSync(Buffer.from(JSON.stringify({ ...workbook, images: [`/api/assets/${image}`] })))
    const saved = await saveContent(app.baseUrl, session, doc.id, bytes, { baseRevision: 1 })
    expect(saved.status).toBe(200)
    await saved.arrayBuffer()
    await completed(await remove(`/api/documents/${doc.id}`))
    const first = await checkpoints([doc.id])
    expect(first).toEqual([expect.objectContaining({ source_document_id: doc.id, revision: 2, snapshot: bytes, saved_by: owner.id, retained: true, asset_ids: [image] })])
    const entry = first[0]!.event_id
    const audit = await database.query(async client => (await client.query<{ entry: string }>('SELECT details->>\'trashEntryId\' AS entry FROM audit_events WHERE action=\'documents.deleted\' AND target_id=$1', [doc.id])).rows)
    expect(audit).toEqual([{ entry }])
    await completed(await remove(`/api/documents/${doc.id}`), 404)
    expect(await checkpoints([doc.id])).toEqual(first)
    await completed(await asUser(app.baseUrl, session, `/api/trash/${entry}/restore`, { method: 'POST' }), 200)
    await completed(await remove(`/api/documents/${doc.id}`))
    const both = await checkpoints([doc.id])
    expect(both).toHaveLength(2)
    expect(both[1]!.event_id).not.toBe(entry)
    await completed(await remove(`/api/trash/${both[1]!.event_id}`))
    expect(await states([doc.id])).toEqual([])
    expect(await checkpoints([doc.id])).toEqual(both)
    await expect(database.query(async client => client.query('DELETE FROM assets WHERE id=$1', [image]))).rejects.toMatchObject({ code: '23001' })
  })

  it('文件夹只捕获活动子树，一次事件使用同一时刻，不重新包含早先单独删除的文档', async () => {
    const parent = await folder()
    const child = await folder(parent)
    const a = await document(parent)
    const b = await document(child)
    const alreadyDeleted = await document(child)
    await completed(await remove(`/api/documents/${alreadyDeleted.id}`))
    const old = await checkpoints([alreadyDeleted.id])
    vi.spyOn(clock, 'now').mockImplementation(async () => {
      const result = at
      at = new Date(at.getTime() + 1000)
      return result
    })
    await completed(await remove(`/api/folders/${parent}`))
    const captured = await checkpoints([a.id, b.id])
    expect(captured.map(row => row.source_document_id)).toEqual([a.id, b.id].sort())
    expect(new Set(captured.map(row => row.event_id)).size).toBe(1)
    expect(new Set(captured.map(row => row.created_at.getTime())).size).toBe(1)
    expect(await checkpoints([alreadyDeleted.id])).toEqual(old)
    await completed(await asUser(app.baseUrl, session, `/api/trash/${captured[0]!.event_id}/restore`, { method: 'POST' }), 200)
    expect((await states([a.id, b.id])).map(row => row.status)).toEqual(['active', 'active'])
    expect((await states([alreadyDeleted.id]))[0]!.status).toBe('trashed')
  })

  it('第二份检查点插入后失败，整个文件夹、所有文档代次、删除单元和已写检查点回滚', async () => {
    const parent = await folder()
    const docs = [await document(parent), await document(parent), await document(parent)].sort((a, b) => a.id.localeCompare(b.id))
    await database.query(async client => client.query('UPDATE documents SET title=\'阻断检查点\' WHERE id=$1', [docs[1]!.id]))
    const ids = docs.map(doc => doc.id)
    const before = await states(ids)
    const trashCount = async () => database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM trash_entries')).rows[0]!.count)
    const count = await trashCount()
    await database.query(async (client) => {
      await client.query(`CREATE FUNCTION reject_second_checkpoint_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.title='阻断检查点' THEN RAISE EXCEPTION '第二份检查点故障注入'; END IF; RETURN NEW; END $$`)
      await client.query('CREATE TRIGGER reject_second_checkpoint_for_test AFTER INSERT ON document_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_second_checkpoint_for_test()')
    })
    try {
      await completed(await remove(`/api/folders/${parent}`), 500)
      expect(await states(ids)).toEqual(before)
      expect(await checkpoints(ids)).toEqual([])
      expect(await trashCount()).toBe(count)
      expect(await database.query(async client => (await client.query<{ status: string }>('SELECT status FROM folders WHERE id=$1', [parent])).rows)).toEqual([{ status: 'active' }])
    }
    finally {
      await database.query(async (client) => {
        await client.query('DROP TRIGGER reject_second_checkpoint_for_test ON document_checkpoints')
        await client.query('DROP FUNCTION reject_second_checkpoint_for_test()')
      })
    }
    await completed(await remove(`/api/folders/${parent}`))
    expect(await checkpoints(ids)).toHaveLength(3)
  })

  it('删除等在途正式保存提交后才捕获，检查点正文不会取到锁前的旧版', async () => {
    const doc = await document()
    const lease = await acquireLease(app.baseUrl, session, doc.id)
    const bytes = gzipSync(pageSnapshot(doc.unitId, '正在提交的最新版'))
    const service = app.runtime.get(DocumentCheckpointService)
    const capture = service.captureHourly.bind(service)
    const reached = signal()
    const release = signal()
    vi.spyOn(service, 'captureHourly').mockImplementationOnce(async (...args) => {
      const id = await capture(...args)
      reached.resolve()
      await release.promise
      return id
    })
    const save = saveContent(app.baseUrl, session, doc.id, bytes, { baseRevision: 1, lease })
    let deletion: Promise<Response> | undefined
    try {
      expect(await Promise.race([reached.promise.then(() => true), save.then(() => false)])).toBe(true)
      deletion = remove(`/api/documents/${doc.id}`)
      await vi.waitFor(async () => {
        const waiting = await database.query(async client => (await client.query(`SELECT pid FROM pg_stat_activity WHERE datname=$1
          AND application_name=$2 AND wait_event_type='Lock'`, [database.name, APPLICATION_NAME])).rowCount)
        expect(waiting).toBe(1)
      }, { timeout: 10_000 })
      release.resolve()
      const response = await save
      expect(response.status).toBe(200)
      expect(saveContentResponseSchema.parse(await response.json())).toMatchObject({ revision: 2 })
      await completed(await deletion)
      expect(await checkpoints([doc.id])).toEqual([expect.objectContaining({ revision: 2, snapshot: bytes })])
    }
    finally {
      release.resolve()
      await Promise.allSettled(deletion === undefined ? [save] : [save, deletion])
      await releaseLease(app.baseUrl, session, doc.id, lease)
    }
  })
})

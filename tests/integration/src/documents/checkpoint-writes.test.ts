import type { CreatedDocument } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { SaveOptions } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { DocumentCheckpointClock, DocumentCheckpointService } from '@nerve-office/api/testing'
import { createdDocumentSchema, saveContentResponseSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot, postConflictCopy } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let owner: TestAccount
let session: LoggedIn
let foreignSession: LoggedIn
let at: Date

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createAccount(database, { username: 'history-writes-owner' })
  const foreign = await createAccount(database, { username: 'history-writes-foreign' })
  session = await login(app.baseUrl, owner.username, owner.password)
  foreignSession = await login(app.baseUrl, foreign.username, foreign.password)
})
beforeEach(() => {
  at = new Date('2026-10-22T10:15:00Z')
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

interface Checkpoint {
  id: string
  revision: number
  snapshot: Buffer
  unit_id: string
  saved_by: string
  asset_ids: string[]
}

async function histories(id: string): Promise<Checkpoint[]> {
  return database.query(async client => (await client.query<Checkpoint>(`SELECT p.id,p.revision,p.snapshot,p.unit_id,p.saved_by,
    ARRAY(SELECT asset_id::text FROM document_checkpoint_assets WHERE checkpoint_id=p.id ORDER BY asset_id) AS asset_ids
    FROM document_checkpoints p WHERE p.source_document_id=$1 AND p.kind='hourly' ORDER BY p.created_at,p.id`, [id])).rows)
}

async function facts(id: string) {
  return database.query(async client => (await client.query<{
    id: string
    unitId: string
    revision: number
    snapshot: Buffer
    references: string[]
    revisions: number
    receipts: number
    audits: number
    buckets: number
  }>(`SELECT d.id,d.unit_id AS "unitId",d.revision,c.snapshot,
    ARRAY(SELECT asset_id::text FROM document_asset_links WHERE document_id=d.id ORDER BY asset_id) AS references,
    (SELECT count(*)::int FROM document_revisions WHERE document_id=d.id) AS revisions,
    (SELECT count(*)::int FROM document_save_receipts WHERE document_id=d.id) AS receipts,
    (SELECT count(*)::int FROM audit_events WHERE action='documents.content_saved' AND target_id=d.id) AS audits,
    (SELECT count(*)::int FROM document_history_buckets WHERE document_id=d.id) AS buckets
    FROM documents d JOIN document_contents c ON c.document_id=d.id WHERE d.id=$1`, [id])).rows[0]!)
}

async function totals(): Promise<Record<string, number>> {
  return database.query(async client => (await client.query<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM documents) AS documents,
    (SELECT count(*)::int FROM document_contents) AS contents,
    (SELECT count(*)::int FROM document_revisions) AS revisions,
    (SELECT count(*)::int FROM document_history_buckets) AS buckets,
    (SELECT count(*)::int FROM document_checkpoints) AS checkpoints,
    (SELECT count(*)::int FROM document_asset_links) AS links,
    (SELECT count(*)::int FROM document_checkpoint_assets) AS checkpoint_links,
    (SELECT count(*)::int FROM audit_events WHERE action IN ('documents.created','documents.copied','documents.conflict_copied')) AS audits`)).rows[0]!)
}

async function document(): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '历史写入' })
}

function raw(doc: SeededDocument, marker: string, ids: readonly string[] = []): Buffer {
  const workbook = JSON.parse(pageSnapshot(doc.unitId, marker).toString('utf8')) as Record<string, unknown>
  return Buffer.from(JSON.stringify({ ...workbook, images: ids.map(id => `/api/assets/${id}`) }))
}

async function put(doc: SeededDocument, bytes: Buffer, options: SaveOptions): Promise<Response> {
  return saveContent(app.baseUrl, session, doc.id, gzipSync(bytes), options)
}

async function saved(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200)
  return saveContentResponseSchema.parse(await response.json())
}

async function created(response: Response): Promise<CreatedDocument> {
  expect(response.status, await response.clone().text()).toBe(201)
  return createdDocumentSchema.parse(await response.json())
}

async function create(requestId: string): Promise<Response> {
  return asUser(app.baseUrl, session, '/api/documents', { method: 'POST', body: { type: 'sheet', title: '初始历史', requestId } })
}

async function copy(doc: SeededDocument, kind: '普通' | '本页', requestId: string, bytes: Buffer): Promise<Response> {
  return kind === '普通'
    ? asUser(app.baseUrl, session, `/api/documents/${doc.id}/copy`, { method: 'POST', body: { spaceId: owner.personalSpaceId, requestId } })
    : postConflictCopy(app.baseUrl, session, doc.id, doc.unitId, { requestId, bytes: gzipSync(bytes) })
}

/** 真正写完历史与引用以后失败，证明业务、历史、占位使用同一真实事务。 */
function failNextCapture(): void {
  const checkpoints = app.runtime.get(DocumentCheckpointService)
  const capture = checkpoints.captureHourly.bind(checkpoints)
  vi.spyOn(checkpoints, 'captureHourly').mockImplementationOnce(async (...args) => {
    await capture(...args)
    throw new Error('检查点完成后的故障注入')
  })
}

describe('US-M5-10 正式写入的小时历史', () => {
  it('新建初始正文生成自己的首份历史，跨小时重放创建不会再采样', async () => {
    const requestId = randomUUID()
    const doc = await created(await create(requestId))
    const current = await facts(doc.id)
    const initial = await histories(doc.id)
    expect(initial).toEqual([expect.objectContaining({ revision: 1, snapshot: current.snapshot, unit_id: current.unitId, saved_by: owner.id, asset_ids: [] })])
    at = new Date('2026-10-22T11:00:00Z')
    expect(await created(await create(requestId))).toMatchObject({ id: doc.id, replayed: true })
    expect(await histories(doc.id)).toEqual(initial)
    expect((await facts(doc.id)).buckets).toBe(1)
  })

  it('同小时只保留第一次 changed，下一小时 unchanged、重放和失败不采样，changed 才新增', async () => {
    const doc = await document()
    const firstBody = raw(doc, '第一份')
    const firstOptions = { baseRevision: 1, requestId: randomUUID() }
    const firstOutcome = await saved(await put(doc, firstBody, firstOptions))
    expect(firstOutcome).toMatchObject({ revision: 2, unchanged: false })
    const first = await histories(doc.id)
    expect(first).toEqual([expect.objectContaining({ revision: 2, snapshot: gzipSync(firstBody), saved_by: owner.id })])
    const secondBody = raw(doc, '同小时后续正文')
    await saved(await put(doc, secondBody, { baseRevision: 2 }))
    expect(await histories(doc.id)).toEqual(first)
    at = new Date('2026-10-22T11:00:00Z')
    const noopOptions = { baseRevision: 3, requestId: randomUUID() }
    const noop = await saved(await put(doc, secondBody, noopOptions))
    expect(noop).toMatchObject({ revision: 3, unchanged: true })
    expect(await saved(await put(doc, firstBody, firstOptions))).toEqual(firstOutcome)
    expect(await histories(doc.id)).toEqual(first)
    expect((await facts(doc.id)).buckets).toBe(1)
    const thirdBody = raw(doc, '下一小时首份')
    await saved(await put(doc, thirdBody, { baseRevision: 3 }))
    const both = await histories(doc.id)
    expect(both).toEqual([first[0], expect.objectContaining({ revision: 4, snapshot: gzipSync(thirdBody) })])
    at = new Date('2026-10-22T12:00:00Z')
    expect(await saved(await put(doc, secondBody, noopOptions))).toEqual(noop)
    const conflict = await put(doc, raw(doc, '过时写入'), { baseRevision: 1 })
    expect(conflict.status).toBe(409)
    await conflict.arrayBuffer()
    expect(await histories(doc.id)).toEqual(both)
    expect((await facts(doc.id)).buckets).toBe(2)
  })

  it('合法图片随首份历史保留，陌生/未知地址不获权；从当前移除不删除历史关系', async () => {
    const doc = await document()
    const allowed = (await uploadTestAsset(app.baseUrl, session)).assetId
    const foreign = (await uploadTestAsset(app.baseUrl, foreignSession)).assetId
    const bytes = raw(doc, '图片首份', [allowed, foreign, randomUUID()])
    await saved(await put(doc, bytes, { baseRevision: 1 }))
    const first = await histories(doc.id)
    expect(first).toEqual([expect.objectContaining({ snapshot: gzipSync(bytes), asset_ids: [allowed] })])
    await saved(await put(doc, raw(doc, '移除图片'), { baseRevision: 2 }))
    expect((await facts(doc.id)).references).toEqual([])
    expect(await histories(doc.id)).toEqual(first)
  })

  it.each(['普通', '本页'] as const)('%s副本只建立自己的初始历史，保留对应正文和合法图片；重放不再采样', async (kind) => {
    const source = await document()
    const a = (await uploadTestAsset(app.baseUrl, session)).assetId
    const b = (await uploadTestAsset(app.baseUrl, session)).assetId
    const serverBody = raw(source, '服务端正文', [a])
    const pageBody = raw(source, '本页待保存正文', [b])
    await saved(await put(source, serverBody, { baseRevision: 1 }))
    const sourceBefore = await histories(source.id)
    const requestId = randomUUID()
    const result = await created(await copy(source, kind, requestId, pageBody))
    const initial = await histories(result.id)
    expect(result.id).not.toBe(source.id)
    expect(initial).toEqual([expect.objectContaining({ revision: 1, unit_id: source.unitId, saved_by: owner.id, snapshot: gzipSync(kind === '普通' ? serverBody : pageBody), asset_ids: [kind === '普通' ? a : b] })])
    expect(await histories(source.id)).toEqual(sourceBefore)
    at = new Date('2026-10-22T11:00:00Z')
    expect(await created(await copy(source, kind, requestId, pageBody))).toMatchObject({ id: result.id, replayed: true })
    expect(await histories(result.id)).toEqual(initial)
  })

  it('新建在历史完成后失败则所有行回滚，同 requestId 可重试完成', async () => {
    const before = await totals()
    const requestId = randomUUID()
    failNextCapture()
    const failed = await create(requestId)
    expect(failed.status).toBe(500)
    await failed.arrayBuffer()
    expect(await totals()).toEqual(before)
    const result = await created(await create(requestId))
    expect(result.replayed).toBe(false)
    expect(await histories(result.id)).toHaveLength(1)
  })

  it('保存在历史完成后失败，当前正文、修订、审计、图片和占位一起回滚；重试只产生一次', async () => {
    const doc = await document()
    const a = (await uploadTestAsset(app.baseUrl, session)).assetId
    const b = (await uploadTestAsset(app.baseUrl, session)).assetId
    await saved(await put(doc, raw(doc, '旧正文', [a]), { baseRevision: 1 }))
    const before = await facts(doc.id)
    const beforeHistory = await histories(doc.id)
    at = new Date('2026-10-22T11:00:00Z')
    const bytes = raw(doc, '下一小时新正文', [b])
    const options = { baseRevision: 2, requestId: randomUUID() }
    failNextCapture()
    const failed = await put(doc, bytes, options)
    expect(failed.status).toBe(500)
    await failed.arrayBuffer()
    expect(await facts(doc.id)).toEqual(before)
    expect(await histories(doc.id)).toEqual(beforeHistory)
    expect(await saved(await put(doc, bytes, options))).toMatchObject({ revision: 3, unchanged: false })
    expect(await histories(doc.id)).toEqual([beforeHistory[0], expect.objectContaining({ revision: 3, snapshot: gzipSync(bytes), asset_ids: [b] })])
  })

  it.each(['普通', '本页'] as const)('%s副本历史完成后失败不留下正文或图片关系，同请求可重试', async (kind) => {
    const source = await document()
    const asset = (await uploadTestAsset(app.baseUrl, session)).assetId
    const bytes = raw(source, '待复制正文', [asset])
    await saved(await put(source, bytes, { baseRevision: 1 }))
    const before = await totals()
    const requestId = randomUUID()
    failNextCapture()
    const failed = await copy(source, kind, requestId, bytes)
    expect(failed.status).toBe(500)
    await failed.arrayBuffer()
    expect(await totals()).toEqual(before)
    const result = await created(await copy(source, kind, requestId, bytes))
    expect(result.replayed).toBe(false)
    expect(await histories(result.id)).toEqual([expect.objectContaining({ revision: 1, snapshot: gzipSync(bytes), asset_ids: [asset] })])
  })
})

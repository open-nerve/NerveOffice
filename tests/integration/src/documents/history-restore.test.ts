import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { TransactionRunner } from '@nerve-office/api'
import { DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { removeGrant, setGrant } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let owner: TestAccount
let restorer: TestAccount
let session: LoggedIn
let otherSession: LoggedIn
let at: Date
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createAccount(database, { username: 'history-restore-owner' })
  restorer = await createAccount(database, { username: 'history-restorer' })
  session = await login(app.baseUrl, owner.username, owner.password)
  otherSession = await login(app.baseUrl, restorer.username, restorer.password)
})
beforeEach(() => {
  at = new Date('2026-10-22T08:00:00Z')
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function source() {
  const doc = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '恢复前的表格' })
  await setGrant(database, { documentId: doc.id, userId: restorer.id, role: 'editor', grantedBy: owner.id })
  return doc
}
async function restore(id: string, history: string, requestId = randomUUID(), patch: Record<string, unknown> = {}, who = otherSession) {
  return asUser(app.baseUrl, who, `/api/documents/${id}/history/${history}/restore`, { method: 'POST', body: { requestId, spaceId: restorer.personalSpaceId, ...patch } })
}
async function created(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(createdDocumentSchema, await response.json())
}
async function state(id: string) {
  return database.query(async client => (await client.query<{
    id: string
    unit_id: string
    revision: number
    write_epoch: number
    created_by: string
    snapshot: Buffer
    content_hash: Buffer | null
    resource_names: string[] | null
    formulas_pending: boolean
    client_build: string | null
    assets: string[]
    histories: string[]
    leases: unknown[]
    grants: unknown[]
    saved_by: string
  }>(`SELECT d.id,d.unit_id,d.revision,d.write_epoch,d.created_by,c.snapshot,c.content_hash,c.resource_names,d.formulas_pending,d.client_build,
    ARRAY(SELECT asset_id::text FROM document_asset_links WHERE document_id=d.id ORDER BY asset_id) AS assets,
    ARRAY(SELECT id::text FROM document_checkpoints WHERE source_document_id=d.id ORDER BY id) AS histories,
    ARRAY(SELECT row_to_json(l) FROM document_edit_leases l WHERE document_id=d.id) AS leases,
    ARRAY(SELECT row_to_json(g) FROM document_grants g WHERE document_id=d.id) AS grants,
    (SELECT saved_by::text FROM document_revisions WHERE document_id=d.id AND revision=d.revision) AS saved_by
    FROM documents d JOIN document_contents c ON c.document_id=d.id WHERE d.id=$1`, [id])).rows[0]!)
}
async function totals() {
  return database.query(async client => (await client.query<{ documents: number, histories: number, revisions: number, links: number, audits: number }>(`SELECT
    (SELECT count(*)::int FROM documents) AS documents, (SELECT count(*)::int FROM document_checkpoints) AS histories,
    (SELECT count(*)::int FROM document_revisions) AS revisions, (SELECT count(*)::int FROM document_asset_links) AS links,
    (SELECT count(*)::int FROM audit_events WHERE action='documents.history_restored') AS audits`)).rows[0]!)
}

describe('US-M5-10 从历史恢复为独立副本', () => {
  it('保留历史的公式待更新标记和旧 clientBuild，不借用源当前信封', async () => {
    const doc = await source()
    await database.query(async client => client.query('UPDATE documents SET formulas_pending=true WHERE id=$1', [doc.id]))
    const history = await captureHistory(app, doc.id)
    await database.query(async client => client.query('UPDATE documents SET formulas_pending=false WHERE id=$1', [doc.id]))
    const copy = await created(await restore(doc.id, history))
    expect(await state(copy.id)).toMatchObject({ formulas_pending: true, client_build: null })
    expect(await state(doc.id)).toMatchObject({ formulas_pending: false })
  })

  it('别的源的历史、运维检查点与不存在的历史均不能作为恢复来源', async () => {
    const doc = await source()
    const other = await source()
    const foreign = await captureHistory(app, other.id)
    const operation = await app.runtime.get(TransactionRunner).run(async (transaction) => {
      await app.runtime.get(DocumentsRepository).lockById(doc.id, transaction)
      return app.runtime.get(DocumentCheckpointService).captureOperation(doc.id, 'before_upgrade', randomUUID(), transaction)
    })
    expect(operation).toBeDefined()
    const before = await totals()
    for (const id of [foreign, operation!, randomUUID()])
      expect((await restore(doc.id, id)).status).toBe(404)
    expect(await totals()).toEqual(before)
  })

  it('不能把副本放到目标空间以外的文件夹', async () => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const folder = await asUser(app.baseUrl, session, '/api/folders', { method: 'POST', body: { requestId: randomUUID(), spaceId: owner.personalSpaceId, name: '不属于恢复目标' } })
    expect(folder.status).toBe(201)
    const folderId = (await folder.json() as { id: string }).id
    const before = await totals()
    expect((await restore(doc.id, history, randomUUID(), { folderId })).status).toBe(404)
    expect(await totals()).toEqual(before)
  })

  it('普通复制与历史恢复不能借用彼此的请求标识', async () => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const requestId = randomUUID()
    const ordinary = await created(await asUser(app.baseUrl, otherSession, `/api/documents/${doc.id}/copy`, {
      method: 'POST',
      body: { requestId, spaceId: restorer.personalSpaceId },
    }))
    expect((await restore(doc.id, history, requestId)).status).toBe(409)
    const historyRequest = randomUUID()
    const historical = await created(await restore(doc.id, history, historyRequest))
    expect(historical.id).not.toBe(ordinary.id)
    expect((await asUser(app.baseUrl, otherSession, `/api/documents/${doc.id}/copy`, {
      method: 'POST',
      body: { requestId: historyRequest, spaceId: restorer.personalSpaceId },
    })).status).toBe(409)
  })

  it('保留旧原字节和 unitId，独立权限/修订/历史，不改原正文、租约或代次', async () => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const lease = await acquireLease(app.baseUrl, session, doc.id)
    try {
      const before = await state(doc.id)
      const copy = await created(await restore(doc.id, history))
      expect(copy.id).not.toBe(doc.id)
      expect(copy).toMatchObject({ replayed: false, title: '恢复前的表格 的副本', revision: 1, spaceId: restorer.personalSpaceId, permissions: { canEdit: true, canClearHistory: true } })
      const after = await state(copy.id)
      expect(after).toMatchObject({ unit_id: before.unit_id, snapshot: before.snapshot, content_hash: null, resource_names: null, revision: 1, write_epoch: 0, created_by: restorer.id, saved_by: restorer.id, assets: [], grants: [], leases: [] })
      expect(after.histories).toHaveLength(1)
      expect(after.histories).not.toContain(history)
      expect(await state(doc.id)).toEqual(before)
      const audit = await database.query(async client => (await client.query<{ details: unknown }>('SELECT details FROM audit_events WHERE action=\'documents.history_restored\' AND target_id=$1', [copy.id])).rows)
      expect(audit).toEqual([{ details: { sourceId: doc.id, historyId: history, spaceId: restorer.personalSpaceId, folderId: null } }])
    }
    finally {
      await releaseLease(app.baseUrl, session, doc.id, lease)
    }
  })

  it('现代正文的规范摘要、合法图片和格式信封一同恢复，源当前正文/身份损坏不妨碍有效旧历史', async () => {
    const doc = await source()
    const asset = await uploadTestAsset(app.baseUrl, session)
    const bytes = gzipSync(Buffer.from(JSON.stringify({ ...JSON.parse(pageSnapshot(doc.unitId, '历史有内容').toString('utf8')) as Record<string, unknown>, images: [`/api/assets/${asset.assetId}`] })))
    expect((await saveContent(app.baseUrl, session, doc.id, bytes, { baseRevision: 1 })).status).toBe(200)
    const original = await state(doc.id)
    expect(original.content_hash).not.toBeNull()
    const history = original.histories[0]!
    await database.query(async (client) => {
      await client.query('UPDATE document_contents SET snapshot=decode(\'00\',\'hex\'),stored_bytes=1 WHERE document_id=$1', [doc.id])
      await client.query('UPDATE documents SET unit_id=\'broken-current-identity\' WHERE id=$1', [doc.id])
    })
    const copy = await created(await restore(doc.id, history, randomUUID(), { title: '恢复的独立表格' }))
    expect(await state(copy.id)).toMatchObject({ snapshot: bytes, unit_id: doc.unitId, content_hash: original.content_hash, resource_names: original.resource_names, client_build: original.client_build, assets: [asset.assetId] })
    const image = await asUser(app.baseUrl, otherSession, `/api/assets/${asset.assetId}`)
    expect(image.headers.get('x-asset-status')).toBe('200')
    await image.arrayBuffer()
  })

  it('回包丢失后源撤权/历史清除仍返回同一已完成副本；改负载或换人拒绝', async () => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const requestId = randomUUID()
    const copy = await created(await restore(doc.id, history, requestId))
    await removeGrant(database, doc.id, restorer.id)
    await database.query(async client => client.query('DELETE FROM document_checkpoints WHERE id=$1', [history]))
    const replay = await created(await restore(doc.id, history, requestId))
    expect(replay).toMatchObject({ id: copy.id, replayed: true })
    expect((await restore(doc.id, history, requestId, { title: '另一请求' })).status).toBe(409)
    expect((await restore(doc.id, history, requestId, {}, session)).status).toBe(409)
    expect((await restore(doc.id, randomUUID(), requestId)).status).toBe(409)
    expect((await asUser(app.baseUrl, otherSession, `/api/documents/${copy.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await restore(doc.id, history, requestId)).status).toBe(409)
  })

  it.each(['损坏 gzip', '不支持格式', '规范摘要不符'] as const)('%s 不能恢复，返回 422 并且没有任何半成品', async (kind) => {
    const doc = await source()
    await database.query(async (client) => {
      if (kind === '损坏 gzip') {
        await client.query('UPDATE document_contents SET snapshot=decode(\'00\',\'hex\'),stored_bytes=1 WHERE document_id=$1', [doc.id])
      }
      else if (kind === '不支持格式') {
        await client.query('UPDATE documents SET sdk_version=\'999.0.0\' WHERE id=$1', [doc.id])
      }
      else {
        await client.query('UPDATE document_contents SET content_hash=decode(repeat(\'00\',32),\'hex\'),resource_names=ARRAY[]::text[] WHERE document_id=$1', [doc.id])
        await client.query('UPDATE document_revisions SET content_hash=decode(repeat(\'00\',32),\'hex\') WHERE document_id=$1', [doc.id])
      }
    })
    const history = await captureHistory(app, doc.id)
    const before = await totals()
    const response = await restore(doc.id, history)
    expect(response.status, await response.clone().text()).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'HISTORY_UNUSABLE' } })
    expect(await totals()).toEqual(before)
  })

  it('写完新历史后故障：副本、原正文关系、请求账本和审计同事务回滚，原请求可重试', async () => {
    const doc = await source()
    const history = await captureHistory(app, doc.id)
    const before = await totals()
    const checkpoints = app.runtime.get(DocumentCheckpointService)
    const capture = checkpoints.captureHourly.bind(checkpoints)
    vi.spyOn(checkpoints, 'captureHourly').mockImplementationOnce(async (...args) => {
      await capture(...args)
      throw new Error('恢复后历史写入故障')
    })
    const requestId = randomUUID()
    expect((await restore(doc.id, history, requestId)).status).toBe(500)
    expect(await totals()).toEqual(before)
    expect((await created(await restore(doc.id, history, requestId))).replayed).toBe(false)
  })
})

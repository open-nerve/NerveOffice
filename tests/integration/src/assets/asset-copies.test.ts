import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { DocumentAssetReferences, DocumentAssetsRepository } from '@nerve-office/api/testing'
import { createdDocumentSchema, saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'

interface Client { readonly account: TestAccount, readonly session: LoggedIn }
let database: TestDatabase
let app: TestApp
let owner: Client
let editor: Client
let viewer: Client
async function person(username: string): Promise<Client> {
  const account = await createAccount(database, { username })
  return { account, session: await login(app.baseUrl, username, account.password) }
}
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await person('image-copy-owner')
  editor = await person('image-copy-editor')
  viewer = await person('image-copy-viewer')
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function document(client = owner): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: client.account.personalSpaceId, createdBy: client.account.id, title: '图片副本' })
}
function raw(document: SeededDocument, ids: readonly string[], marker = '正文'): Buffer {
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId, extra: { marker, images: ids.map(id => `/api/assets/${id}`) } }))
}
async function save(client: Client, doc: SeededDocument, body: Buffer): Promise<void> {
  const response = await saveContent(app.baseUrl, client.session, doc.id, gzipSync(body), { baseRevision: 1 })
  expect(response.status).toBe(200)
  expect(saveContentResponseSchema.parse(await response.json()).revision).toBe(2)
}
async function uploaded(client = owner): Promise<string> {
  return (await uploadTestAsset(app.baseUrl, client.session)).assetId
}
async function expire(ids: readonly string[]): Promise<void> {
  await database.query(async client => client.query('UPDATE assets SET created_at=now()-interval \'25 hours\' WHERE id=ANY($1::uuid[])', [ids]))
}
async function share(from: Client, docId: string, to: Client, enabled = true): Promise<void> {
  const response = await asUser(app.baseUrl, from.session, `/api/documents/${docId}/grants/${to.account.id}`, enabled ? { method: 'PUT', body: { role: 'viewer' } } : { method: 'DELETE' })
  expect(response.status).toBe(enabled ? 200 : 204)
  await response.arrayBuffer()
}
async function ordinary(docId: string, requestId: string): Promise<Response> {
  return asUser(app.baseUrl, editor.session, `/api/documents/${docId}/copy`, { method: 'POST', body: { requestId, spaceId: editor.account.personalSpaceId } })
}
async function created(response: Response) {
  expect(response.status).toBe(201)
  return createdDocumentSchema.parse(await response.json())
}
async function facts(id: string) {
  return database.query(async client => (await client.query<{
    unit_id: string
    snapshot: Buffer
    references: string[]
    grants: string
  }>(`SELECT d.unit_id,c.snapshot,
      ARRAY(SELECT asset_id::text FROM document_asset_links WHERE document_id=$1 ORDER BY asset_id) AS references,
      (SELECT count(*) FROM document_grants WHERE document_id=$1) AS grants
      FROM documents d JOIN document_contents c ON c.document_id=d.id WHERE d.id=$1`, [id])).rows[0]!)
}
async function counts() {
  return database.query(async client => (await client.query<Record<'assets' | 'objects' | 'documents' | 'contents' | 'revisions' | 'links' | 'audits', string>>(`SELECT
    (SELECT count(*) FROM assets) AS assets,
    (SELECT count(*) FROM asset_objects) AS objects,
    (SELECT count(*) FROM documents) AS documents,
    (SELECT count(*) FROM document_contents) AS contents,
    (SELECT count(*) FROM document_revisions) AS revisions,
    (SELECT count(*) FROM document_asset_links) AS links,
    (SELECT count(*) FROM audit_events WHERE action IN ('documents.copied','documents.conflict_copied')) AS audits`)).rows[0]!)
}
async function status(client: Client, id: string): Promise<string | null> {
  const response = await asUser(app.baseUrl, client.session, `/api/assets/${id}`)
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  return response.headers.get('x-asset-status')
}

describe('US-M5-09 两种副本的独立图片引用', () => {
  it.each(['撤销原授权', '删除原文档'] as const)('普通复制只复制当前集合，gzip/unitId 原样保留；%s后副本可读，重放不补正文中的其他地址', async (change) => {
    const source = await document()
    const kept = await uploaded()
    const unlinked = await uploaded(editor)
    const body = raw(source, [kept, unlinked, randomUUID()])
    await save(owner, source, body)
    expect((await facts(source.id)).references).toEqual([kept])
    await share(owner, source.id, editor)
    const before = await counts()
    const requestId = randomUUID()
    const copy = await created(await ordinary(source.id, requestId))
    expect(copy.replayed).toBe(false)
    expect(await facts(copy.id)).toEqual({ unit_id: source.unitId, snapshot: gzipSync(body), references: [kept], grants: '0' })
    const after = await counts()
    expect([after.assets, after.objects]).toEqual([before.assets, before.objects])
    await expire([kept, unlinked])
    if (change === '撤销原授权') {
      await share(owner, source.id, editor, false)
    }
    else {
      const response = await asUser(app.baseUrl, owner.session, `/api/documents/${source.id}`, { method: 'DELETE' })
      expect(response.status).toBe(204)
      await response.arrayBuffer()
    }
    expect(await status(editor, kept)).toBe('200')
    expect(await status(editor, unlinked)).toBe('404')
    const copyRelations = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'copy')
    const beforeReplay = await counts()
    const replayed = await created(await ordinary(source.id, requestId))
    expect(replayed).toMatchObject({ id: copy.id, replayed: true })
    expect(await counts()).toEqual(beforeReplay)
    expect(copyRelations).not.toHaveBeenCalled()
  })

  it('本机副本仅承接上传正文实际包含的合法 ID，保留上传字节；源撤权之后三类图片均由副本独立授权', async () => {
    const source = await document()
    const other = await document()
    const kept = await uploaded()
    const omitted = await uploaded()
    const external = await uploaded()
    const foreign = await uploaded()
    await save(owner, source, raw(source, [kept, omitted]))
    await save(owner, other, raw(other, [external]))
    await expire([kept, omitted, external])
    await share(owner, source.id, editor)
    await share(owner, other.id, editor)
    const recent = await uploaded(editor)
    const body = raw(source, [kept, external, recent, foreign, randomUUID()], '本机未同步内容')
    const request = { raw: body, requestId: randomUUID() }
    const before = await counts()
    const copy = await created(await postConflictCopy(app.baseUrl, editor.session, source.id, source.unitId, request))
    expect(copy.spaceId).toBe(editor.account.personalSpaceId)
    expect(await facts(copy.id)).toEqual({ unit_id: source.unitId, snapshot: gzipSync(body), references: [kept, external, recent].sort(), grants: '0' })
    const after = await counts()
    expect([after.assets, after.objects]).toEqual([before.assets, before.objects])
    await expire([recent])
    await share(owner, source.id, editor, false)
    await share(owner, other.id, editor, false)
    await share(editor, copy.id, viewer)
    for (const id of [kept, external, recent])
      expect(await status(viewer, id)).toBe('200')
    for (const id of [omitted, foreign])
      expect(await status(viewer, id)).toBe('404')
    const replace = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'replace')
    const beforeReplay = await counts()
    expect(await created(await postConflictCopy(app.baseUrl, editor.session, source.id, source.unitId, request))).toMatchObject({ id: copy.id, replayed: true })
    expect(await counts()).toEqual(beforeReplay)
    expect(replace).not.toHaveBeenCalled()
    const rejected = await postConflictCopy(app.baseUrl, editor.session, source.id, source.unitId, { ...request, requestId: randomUUID() })
    expect(rejected.status).toBe(404)
    await rejected.arrayBuffer()
    expect(await counts()).toEqual(beforeReplay)
  })

  it('预选的另一来源失效后，可用一开始就必须锁住的原文档证明引用，不临时补锁', async () => {
    const docs = [await document(), await document()].sort((a, b) => a.id.localeCompare(b.id))
    const [alternative, source] = docs as [SeededDocument, SeededDocument]
    const id = await uploaded()
    for (const doc of docs) {
      await save(owner, doc, raw(doc, [id]))
      await share(owner, doc.id, editor)
    }
    await expire([id])
    const references = app.runtime.get(DocumentAssetReferences)
    const hold = references.hold.bind(references)
    const spy = vi.spyOn(references, 'hold').mockImplementationOnce(async (...args) => {
      expect(args[0].sources.map(row => row.id)).toEqual([alternative.id])
      await share(owner, alternative.id, editor, false)
      return hold(...args)
    })
    const copy = await created(await postConflictCopy(app.baseUrl, editor.session, source.id, source.unitId, { raw: raw(source, [id]) }))
    expect(spy).toHaveBeenCalledOnce()
    expect((await facts(copy.id)).references).toEqual([id])
  })

  it.each(['普通复制', '本机副本'] as const)('%s 的引用写入后故障使新文档、正文、修订和审计全部回滚；同 requestId 可重新成功', async (kind) => {
    const source = await document()
    const id = await uploaded()
    const body = raw(source, [id])
    await save(owner, source, body)
    await share(owner, source.id, editor)
    const before = await counts()
    const links = app.runtime.get(DocumentAssetsRepository)
    if (kind === '普通复制') {
      const original = links.copyFrom.bind(links)
      vi.spyOn(links, 'copyFrom').mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new Error('复制关系写入后故障')
      })
    }
    else {
      const original = links.replace.bind(links)
      vi.spyOn(links, 'replace').mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new Error('本机副本关系写入后故障')
      })
    }
    const requestId = randomUUID()
    const send = async () => kind === '普通复制'
      ? ordinary(source.id, requestId)
      : postConflictCopy(app.baseUrl, editor.session, source.id, source.unitId, { raw: body, requestId })
    const failed = await send()
    expect(failed.status).toBe(500)
    await failed.arrayBuffer()
    expect(await counts()).toEqual(before)
    const copy = await created(await send())
    expect(copy.replayed).toBe(false)
    expect((await facts(copy.id)).references).toEqual([id])
  })
})

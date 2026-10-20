import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { SaveOptions } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { APPLICATION_NAME, DocumentAssetReferences, DocumentAssetsRepository, DocumentsRepository } from '@nerve-office/api/testing'
import { errorResponseSchema, saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
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
  owner = await person('image-save-owner')
  editor = await person('image-save-editor')
  viewer = await person('image-save-viewer')
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function document(client = editor): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: client.account.personalSpaceId, createdBy: client.account.id, title: '图片保存' })
}
function raw(document: SeededDocument, ids: readonly string[], marker = '正文', viewId?: string): Buffer {
  const sheet = { ...SHEET_TEMPLATE.sheets['sheet-1'], ...(viewId === undefined ? {} : { zoomRatio: `/api/assets/${viewId}` }) }
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId, sheets: { 'sheet-1': sheet }, extra: { marker, images: ids.map(id => `/api/assets/${id}`) } }))
}
async function put(client: Client, doc: SeededDocument, body: Buffer, options: SaveOptions): Promise<Response> {
  return saveContent(app.baseUrl, client.session, doc.id, gzipSync(body), options)
}
async function saved(response: Response) {
  expect(response.status).toBe(200)
  return saveContentResponseSchema.parse(await response.json())
}
async function uploaded(client = editor): Promise<string> {
  return (await uploadTestAsset(app.baseUrl, client.session)).assetId
}
async function expire(ids: readonly string[]): Promise<void> {
  await database.query(async client => client.query('UPDATE assets SET created_at=now()-interval \'25 hours\' WHERE id=ANY($1::uuid[])', [ids]))
}
async function share(from: Client, doc: SeededDocument, to: Client, enabled = true): Promise<void> {
  const response = await asUser(app.baseUrl, from.session, `/api/documents/${doc.id}/grants/${to.account.id}`, enabled ? { method: 'PUT', body: { role: 'viewer' } } : { method: 'DELETE' })
  expect(response.status).toBe(enabled ? 200 : 204)
  await response.arrayBuffer()
}
async function facts(id: string) {
  return database.query(async client => (await client.query<{
    revision: number
    snapshot: Buffer
    references: string[]
    revisions: string
    audits: string
  }>(`SELECT d.revision,c.snapshot,
      ARRAY(SELECT asset_id::text FROM document_asset_links WHERE document_id=$1 ORDER BY asset_id) AS references,
      (SELECT count(*) FROM document_revisions WHERE document_id=$1) AS revisions,
      (SELECT count(*) FROM audit_events WHERE action='documents.content_saved' AND target_id=$1) AS audits
      FROM documents d JOIN document_contents c ON c.document_id=d.id WHERE d.id=$1`, [id])).rows[0]!)
}
async function status(client: Client, id: string): Promise<string | null> {
  const response = await asUser(app.baseUrl, client.session, `/api/assets/${id}`)
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  return response.headers.get('x-asset-status')
}
function signal() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('US-M5-07 正式保存与图片当前引用', () => {
  it('图片位置经真实保存和副本返回，拒绝时内容、修订与引用不变；纠正后保存成功', async () => {
    const target = await document()
    const kept = await uploaded()
    const next = await uploaded()
    await saved(await put(editor, target, raw(target, [kept]), { baseRevision: 1 }))
    const before = await facts(target.id)
    const counts = async () => database.query(async client => (await client.query<{ documents: string, links: string }>('SELECT (SELECT count(*) FROM documents) AS documents, (SELECT count(*) FROM document_asset_links) AS links')).rows[0])
    const beforeCounts = await counts()
    const secret = 'https://private.example/private-picture.png'
    const sheet = { ...SHEET_TEMPLATE.sheets['sheet-1'], name: '不能回传的名称', cellData: { 2: { 1: { p: { source: secret, body: { dataStream: '不能回传的正文\r\n' } } } } } }
    const snapshot = { ...SHEET_TEMPLATE, id: target.unitId, sheets: { 'sheet-1': sheet }, images: [`/api/assets/${next}`] }
    const body = Buffer.from(JSON.stringify(snapshot))
    const logStart = app.logs.entries().length
    for (const response of [await put(editor, target, body, { baseRevision: 2 }), await postConflictCopy(app.baseUrl, editor.session, target.id, target.unitId, { raw: body })]) {
      expect(response.status).toBe(422)
      const text = await response.text()
      const result = errorResponseSchema.parse(JSON.parse(text))
      expect(result.error).toMatchObject({ code: 'SNAPSHOT_INVALID', details: { rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 'sheet-1', row: 2, column: 1 }] } })
      expect(text).not.toMatch(/private|不能回传/)
    }
    expect(await facts(target.id)).toEqual(before)
    expect(await counts()).toEqual(beforeCounts)
    const logs = app.logs.entries().slice(logStart)
    expect(logs.filter(entry => entry.msg === '快照不合格，拒绝写入')).toHaveLength(2)
    expect(JSON.stringify(logs)).not.toMatch(/imageLocations|sheet-1|private|不能回传/)
    const corrected = raw(target, [kept, next], '已纠正')
    expect(await saved(await put(editor, target, corrected, { baseRevision: 2 }))).toMatchObject({ revision: 3 })
    expect((await facts(target.id)).references).toEqual([kept, next].sort())
  })

  it('新修订合并三类合法来源，无权/未知地址照常存正文但不授予读权；移除地址清空引用并保留资源', async () => {
    const target = await document()
    const source = await document(owner)
    const kept = await uploaded()
    const shared = await uploaded(owner)
    await saved(await put(editor, target, raw(target, [kept]), { baseRevision: 1 }))
    await saved(await put(owner, source, raw(source, [shared]), { baseRevision: 1 }))
    await expire([kept, shared])
    await share(owner, source, editor)
    await share(editor, target, viewer)
    const recent = await uploaded()
    const foreign = await uploaded(owner)
    const unknown = randomUUID()
    const body = raw(target, [kept, shared, recent, foreign, unknown], '新正文')
    expect(await saved(await put(editor, target, body, { baseRevision: 2 }))).toMatchObject({ revision: 3, unchanged: false })
    const stored = await facts(target.id)
    expect(stored.snapshot).toEqual(gzipSync(body))
    expect(stored.references).toEqual([kept, shared, recent].sort())
    for (const id of [kept, shared, recent])
      expect(await status(viewer, id)).toBe('200')
    for (const id of [foreign, unknown])
      expect(await status(viewer, id)).toBe('404')
    const prepare = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'prepare')
    const hold = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'hold')
    await saved(await put(editor, target, raw(target, [], '移除图片'), { baseRevision: 3 }))
    expect(prepare).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
    expect((await facts(target.id)).references).toEqual([])
    for (const id of [kept, shared, recent])
      expect(await status(viewer, id)).toBe('404')
    expect(await database.query(async client => (await client.query('SELECT id FROM assets WHERE id=ANY($1::uuid[])', [[kept, shared, recent, foreign]])).rowCount)).toBe(4)
  })

  it('unchanged 不替换原 gzip，也不根据被规范化忽略的不同视图地址增加或删除引用', async () => {
    const target = await document()
    const a = await uploaded()
    const b = await uploaded()
    const first = raw(target, [], '相同正文', a)
    await saved(await put(editor, target, first, { baseRevision: 1 }))
    const replace = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'replace')
    for (const body of [raw(target, [], '相同正文', b), raw(target, [], '相同正文')])
      expect(await saved(await put(editor, target, body, { baseRevision: 2 }))).toMatchObject({ revision: 2, unchanged: true })
    expect((await facts(target.id)).snapshot).toEqual(gzipSync(first))
    expect((await facts(target.id)).references).toEqual([a])
    expect(replace).not.toHaveBeenCalled()
  })

  it('原来无权的正文地址不会因 unchanged 被升级；下一次真实修改才按新权限授权', async () => {
    const source = await document(owner)
    const target = await document()
    const id = await uploaded(owner)
    await saved(await put(owner, source, raw(source, [id]), { baseRevision: 1 }))
    await expire([id])
    const initial = raw(target, [id])
    await saved(await put(editor, target, initial, { baseRevision: 1 }))
    expect((await facts(target.id)).references).toEqual([])
    await share(owner, source, editor)
    expect(await saved(await put(editor, target, initial, { baseRevision: 2 }))).toMatchObject({ unchanged: true })
    await share(owner, source, editor, false)
    expect((await facts(target.id)).references).toEqual([])
    expect(await status(editor, id)).toBe('404')
    await share(owner, source, editor)
    await saved(await put(editor, target, raw(target, [id], '真正改动'), { baseRevision: 2 }))
    await share(owner, source, editor, false)
    expect((await facts(target.id)).references).toEqual([id])
    expect(await status(editor, id)).toBe('200')
  })

  it('前置重放旧保存或 unchanged 回执，不改变后来已提交的正文与引用', async () => {
    const target = await document()
    const a = await uploaded()
    const b = await uploaded()
    const body = raw(target, [a])
    const firstOptions = { baseRevision: 1, requestId: randomUUID() }
    const first = await saved(await put(editor, target, body, firstOptions))
    const noopOptions = { baseRevision: 2, requestId: randomUUID() }
    const noop = await saved(await put(editor, target, body, noopOptions))
    await saved(await put(editor, target, raw(target, [b], '后续正文'), { baseRevision: 2 }))
    const before = await facts(target.id)
    const replace = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'replace')
    expect(await saved(await put(editor, target, body, firstOptions))).toEqual(first)
    expect(await saved(await put(editor, target, body, noopOptions))).toEqual(noop)
    expect(await facts(target.id)).toEqual(before)
    expect(before.references).toEqual([b])
    expect(replace).not.toHaveBeenCalled()
  })

  it.each(['新修订', 'unchanged'] as const)('并发同 requestId 的%s在账本锁内重放，引用仅随首次真实写入变更', async (kind) => {
    const target = await document()
    const id = await uploaded()
    const body = raw(target, [id])
    if (kind === 'unchanged')
      await saved(await put(editor, target, body, { baseRevision: 1 }))
    const lease = await acquireLease(app.baseUrl, editor.session, target.id)
    const options = { baseRevision: kind === 'unchanged' ? 2 : 1, requestId: randomUUID(), lease }
    const reached = signal()
    const release = signal()
    const repository = app.runtime.get(DocumentsRepository)
    const lock = repository.lockByIds.bind(repository)
    vi.spyOn(repository, 'lockByIds').mockImplementationOnce(async (...args) => {
      const rows = await lock(...args)
      reached.resolve()
      await release.promise
      return rows
    })
    const replace = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'replace')
    const first = put(editor, target, body, options)
    let second: Promise<Response> | undefined
    try {
      expect(await Promise.race([reached.promise.then(() => true), first.then(() => false)])).toBe(true)
      second = put(editor, target, body, options)
      await vi.waitFor(async () => {
        const waiting = await database.query(async client => (await client.query(`SELECT pid FROM pg_stat_activity WHERE datname=$1
          AND application_name=$2 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`, [database.name, APPLICATION_NAME])).rowCount)
        expect(waiting).toBe(1)
      }, { timeout: 10_000 })
      release.resolve()
      const original = await saved(await first)
      expect(await saved(await second)).toEqual(original)
      expect(replace).toHaveBeenCalledTimes(kind === 'unchanged' ? 0 : 1)
      expect((await facts(target.id)).references).toEqual([id])
    }
    finally {
      release.resolve()
      await Promise.allSettled(second === undefined ? [first] : [first, second])
      await releaseLease(app.baseUrl, editor.session, target.id, lease)
    }
  })

  it('关系写入之后故障：正文、修订、审计和关系一起回滚，不出现半次保存', async () => {
    const target = await document()
    const a = await uploaded()
    const b = await uploaded()
    await saved(await put(editor, target, raw(target, [a]), { baseRevision: 1 }))
    const before = await facts(target.id)
    const repository = app.runtime.get(DocumentAssetsRepository)
    const replace = repository.replace.bind(repository)
    vi.spyOn(repository, 'replace').mockImplementationOnce(async (...args) => {
      await replace(...args)
      throw new Error('引用已写入后的故障注入')
    })
    const response = await put(editor, target, raw(target, [b], '将回滚的正文'), { baseRevision: 2 })
    expect(response.status).toBe(500)
    await response.arrayBuffer()
    expect(await facts(target.id)).toEqual(before)
  })

  it('目标隐藏、不存在或只能查看时先按原规则拒绝，不预选或锁住任何图片来源', async () => {
    const target = await document()
    const id = await uploaded(viewer)
    const prepare = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'prepare')
    const hold = vi.spyOn(app.runtime.get(DocumentAssetReferences), 'hold')
    const hidden = await put(viewer, target, raw(target, [id]), { baseRevision: 1 })
    const missing = { ...target, id: randomUUID() }
    const absent = await put(viewer, missing, raw(target, [id]), { baseRevision: 1 })
    expect([hidden.status, absent.status]).toEqual([404, 404])
    await hidden.arrayBuffer()
    await absent.arrayBuffer()
    await share(editor, target, viewer)
    const readonly = await put(viewer, target, raw(target, [id]), { baseRevision: 1 })
    expect(readonly.status).toBe(403)
    await readonly.arrayBuffer()
    expect(prepare).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
    expect((await facts(target.id)).references).toEqual([])
  })
})

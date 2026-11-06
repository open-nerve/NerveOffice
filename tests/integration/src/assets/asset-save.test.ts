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
import { createdDocumentSchema, errorResponseSchema, saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
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
async function grant(from: Client, doc: SeededDocument, to: Client, role: 'viewer' | 'editor'): Promise<void> {
  const response = await asUser(app.baseUrl, from.session, `/api/documents/${doc.id}/grants/${to.account.id}`, { method: 'PUT', body: { role } })
  expect(response.status).toBe(200)
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

  it('原来无权的正文地址：unchanged 与获权后的真实修改都不升级；删除后重新引入才按当时权限授权（D-01）', async () => {
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
    // 已在上一版里的地址是沿用，不按保存人后来的权限升级
    await saved(await put(editor, target, raw(target, [id], '真正改动'), { baseRevision: 2 }))
    expect((await facts(target.id)).references).toEqual([])
    // 删去后重新引入：这一次是新出现的，按引入者当时的权限授权
    await saved(await put(editor, target, raw(target, [], '删去'), { baseRevision: 3 }))
    await saved(await put(editor, target, raw(target, [id], '重新引入'), { baseRevision: 4 }))
    await share(owner, source, editor, false)
    expect((await facts(target.id)).references).toEqual([id])
    expect(await status(editor, id)).toBe('200')
  })

  it('M5R-I-02 他人预埋的无权地址，有权的第三人真实修改保存也不会“洗白”', async () => {
    // 乙（owner）拥有 X 与 A；甲（editor）读不到 X，但知道 A 的地址并预埋进两人都能编辑的 D
    const x = await document(owner)
    const a = await uploaded(owner)
    await saved(await put(owner, x, raw(x, [a]), { baseRevision: 1 }))
    await expire([a])
    const d = await document(editor)
    await grant(editor, d, owner, 'editor')
    await saved(await put(editor, d, raw(d, [a], '甲预埋'), { baseRevision: 1 }))
    expect((await facts(d.id)).references).toEqual([])
    await saved(await put(owner, d, raw(d, [a], '乙的真实修改'), { baseRevision: 2 }))
    expect((await facts(d.id)).references).toEqual([])
    expect(await status(editor, a)).toBe('404')
    // 乙明确删去后再引入才算乙的共享
    await saved(await put(owner, d, raw(d, [], '乙删去'), { baseRevision: 3 }))
    await saved(await put(owner, d, raw(d, [a], '乙重新引入'), { baseRevision: 4 }))
    expect((await facts(d.id)).references).toEqual([a])
    expect(await status(editor, a)).toBe('200')
  })

  it('M5R-I-02 只在他人文档历史中的图片：查看者预埋后，有历史资格者的保存也不升级', async () => {
    const x = await document(owner)
    const a = await uploaded(owner)
    await saved(await put(owner, x, raw(x, [a], '含 A'), { baseRevision: 1 }))
    await saved(await put(owner, x, raw(x, [], '去掉 A'), { baseRevision: 2 }))
    await expire([a])
    // 甲只是 X 的查看者：看得到 X 当前正文，看不到只在历史里的图片
    await share(owner, x, editor)
    expect(await status(editor, a)).toBe('404')
    const d = await document(editor)
    await grant(editor, d, owner, 'editor')
    await saved(await put(editor, d, raw(d, [a], '甲预埋'), { baseRevision: 1 }))
    await saved(await put(owner, d, raw(d, [a], '乙的真实修改'), { baseRevision: 2 }))
    expect((await facts(d.id)).references).toEqual([])
    expect(await status(editor, a)).toBe('404')
  })

  /** 乙（owner）拥有 X 与 A、甲（editor）读不到 X；甲把 A 预埋进两人都能编辑的 D（修订 2） */
  async function planted() {
    const x = await document(owner)
    const a = await uploaded(owner)
    await saved(await put(owner, x, raw(x, [a]), { baseRevision: 1 }))
    await expire([a])
    const d = await document(editor)
    await grant(editor, d, owner, 'editor')
    await saved(await put(editor, d, raw(d, [a], '甲预埋'), { baseRevision: 1 }))
    expect((await facts(d.id)).references).toEqual([])
    return { a, d }
  }
  /** 这一版里存在、却没有登记关系的图片标识（S14 审查 B1/B3：只记这一部分，不记完整集合） */
  async function revisionAssetIds(documentId: string, revision: number): Promise<string[] | null> {
    return database.query(async client => (await client.query<{ unlinked: string[] | null }>('SELECT unlinked_asset_ids::text[] AS unlinked FROM document_revisions WHERE document_id=$1 AND revision=$2', [documentId, revision])).rows[0]!.unlinked)
  }

  it('M5R-I-02 每一版修订记下存在但未登记的图片标识（含未授权与未知的），排重排序；已登记的不记', async () => {
    const { a, d } = await planted()
    const unknown = randomUUID()
    const own = await uploaded(owner)
    expect(await revisionAssetIds(d.id, 2)).toEqual([a])
    await saved(await put(owner, d, raw(d, [unknown, a, a, own], '再加未知与自己的图'), { baseRevision: 2 }))
    expect((await facts(d.id)).references).toEqual([own])
    expect(await revisionAssetIds(d.id, 3)).toEqual([a, unknown].sort())
  })

  it('M5R-I-02 另存为副本以较早的修订为基准：那一版已登记、之后被他人删掉的图片仍按原规则登记，不丢（S14 审查 B1）', async () => {
    // 乙（owner）在 D 里放进自己刚上传的 P（修订 2，已登记）；甲接管后删掉 P（修订 3）；乙基于修订 2 的草稿另存为副本
    const d = await document(editor)
    await grant(editor, d, owner, 'editor')
    const p = await uploaded(owner)
    await saved(await put(owner, d, raw(d, [p], '乙放进 P'), { baseRevision: 1 }))
    expect((await facts(d.id)).references).toEqual([p])
    await saved(await put(editor, d, raw(d, [], '甲删去 P'), { baseRevision: 2 }))
    const created = await postConflictCopy(app.baseUrl, owner.session, d.id, d.unitId, { raw: raw(d, [p], '乙基于修订 2 的草稿'), query: { baseRevision: '2' } })
    expect(created.status, await created.clone().text()).toBe(201)
    const copy = createdDocumentSchema.parse(await created.json())
    expect((await facts(copy.id)).references).toEqual([p])
    expect(await revisionAssetIds(copy.id, 1)).toEqual([])
  })

  it('M5R-I-02 另存为副本以草稿所基于的修订为基准：甲删掉预埋地址后，乙的旧草稿副本也不登记它', async () => {
    const { a, d } = await planted()
    await saved(await put(editor, d, raw(d, [], '甲删去'), { baseRevision: 2 }))
    const created = await postConflictCopy(app.baseUrl, owner.session, d.id, d.unitId, { raw: raw(d, [a], '乙基于修订 2 的草稿'), query: { baseRevision: '2' } })
    expect(created.status, await created.clone().text()).toBe(201)
    const copy = createdDocumentSchema.parse(await created.json())
    expect((await facts(copy.id)).references).toEqual([])
    expect(await revisionAssetIds(copy.id, 1)).toEqual([a])
    expect(await status(editor, a)).toBe('404')
  })

  it('M5R-I-02 另存为副本缺省基准修订（旧页面）或那一版已不存在时，退回源文档的当前版本', async () => {
    const { a, d } = await planted()
    // 源当前版本（修订 2）含 A：缺省与不存在的修订都按沿用处理，不升级
    const queries: readonly Readonly<Record<string, string>>[] = [{}, { baseRevision: '99' }]
    for (const query of queries) {
      const created = await postConflictCopy(app.baseUrl, owner.session, d.id, d.unitId, { raw: raw(d, [a], `草稿 ${JSON.stringify(query)}`), query })
      expect(created.status, await created.clone().text()).toBe(201)
      expect((await facts(createdDocumentSchema.parse(await created.json()).id)).references).toEqual([])
    }
  })

  it('M5R-I-02 普通复制照搬未登记的图片标识：副本里的预埋地址之后同样不升级', async () => {
    const { a, d } = await planted()
    const response = await asUser(app.baseUrl, editor.session, `/api/documents/${d.id}/copy`, { method: 'POST', body: { requestId: randomUUID(), spaceId: editor.account.personalSpaceId } })
    expect(response.status, await response.clone().text()).toBe(201)
    const copy = createdDocumentSchema.parse(await response.json())
    expect((await facts(copy.id)).references).toEqual([])
    expect(await revisionAssetIds(copy.id, 1)).toEqual([a])
    const target = { ...d, id: copy.id }
    await grant(editor, target, owner, 'editor')
    await saved(await put(owner, target, raw(target, [a], '乙在副本里的修改'), { baseRevision: 1 }))
    expect((await facts(copy.id)).references).toEqual([])
  })

  it('M5R-I-02 存量修订没有记未登记标识：锁下按当前正文减去已登记的关系回退，同样不升级预埋地址', async () => {
    const { a, d } = await planted()
    await database.query(async client => client.query('UPDATE document_revisions SET unlinked_asset_ids=NULL WHERE document_id=$1', [d.id]))
    await saved(await put(owner, d, raw(d, [a], '乙的真实修改'), { baseRevision: 2 }))
    expect((await facts(d.id)).references).toEqual([])
    expect(await revisionAssetIds(d.id, 3)).toEqual([a])
  })

  it('M5R-I-02 存量回退时减去已登记的关系：已登记的图片照常保留，预埋地址同样不升级（S14 复验）', async () => {
    const { a, d } = await planted()
    const own = await uploaded(owner)
    await saved(await put(owner, d, raw(d, [a, own], '乙放进自己的图'), { baseRevision: 2 }))
    expect((await facts(d.id)).references).toEqual([own])
    // 上传窗口过期：之后只能凭 D 上已有的关系证明它
    await expire([own])
    await database.query(async client => client.query('UPDATE document_revisions SET unlinked_asset_ids=NULL WHERE document_id=$1', [d.id]))
    await saved(await put(owner, d, raw(d, [a, own], '乙的真实修改'), { baseRevision: 3 }))
    expect((await facts(d.id)).references).toEqual([own])
  })

  it('M5R-I-02 存量正文解析不了时以当前已登记的关系作基准并记警告（等于这一次沿用旧语义）', async () => {
    const { a, d } = await planted()
    await database.query(async (client) => {
      await client.query('UPDATE document_revisions SET unlinked_asset_ids=NULL WHERE document_id=$1', [d.id])
      await client.query('UPDATE document_contents SET snapshot=decode(\'00\',\'hex\'),stored_bytes=1 WHERE document_id=$1', [d.id])
    })
    const logStart = app.logs.entries().length
    await saved(await put(owner, d, raw(d, [a], '乙的真实修改'), { baseRevision: 2 }))
    expect(app.logs.entries().slice(logStart).filter(entry => entry.msg === '存量的正文解析不出图片标识，这一次以当前已登记的图片关系作授权基准')).toHaveLength(1)
    expect((await facts(d.id)).references).toEqual([a])
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

  it('M5R-I-04 正文里的长串结尾包裹符不拖住快照检查：保存在检查时限内正常返回，引用照常提取', async () => {
    const target = await document()
    const kept = await uploaded()
    // 原实现对每个这样的字符串二次回溯（百万字符约数百秒），检查子进程会超过 10 秒时限，保存失败
    const hostile = `${')'.repeat(1_000_000)}x`
    const body = raw(target, [kept], hostile)
    const extra = JSON.parse(body.toString('utf8')) as { extra: { images: string[] } }
    extra.extra.images.push(`/api/assets/${')'.repeat(1_000_000)}x`)
    const hostileBody = Buffer.from(JSON.stringify(extra))
    expect(await saved(await put(editor, target, hostileBody, { baseRevision: 1 }))).toMatchObject({ revision: 2, unchanged: false })
    const stored = await facts(target.id)
    expect(stored.snapshot).toEqual(gzipSync(hostileBody))
    expect(stored.references).toEqual([kept])
  })
})

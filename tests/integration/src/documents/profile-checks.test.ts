// 页面上报的档案与文档的档案（DEF-055，M6-P1 S5 设计 §3.4；US-M6-13 的服务端部分）。经真实的应用与数据库核对：
// - 快照按页面上报、已通过格式核对的档案检查（文字文档按 doc@1 的规则，被拒时位置是段落）；
// - 保存：上报的档案与文档的档案不同时 409 CLIENT_OUTDATED（format），排在访问判断与 DOCUMENT_TOO_NEW 之后，看不到的照样 404；
//   不缩水按文档的档案；
// - 另存为副本：上报的档案对照这类文档在服务端的档案（不比文档行里存的），回滚之后照样能存副本（审查 A7）；信封记服务端的档案。
// 文字文档在 P1 还不能经接口新建，直接写库摆下（support/documents.ts 的 type: 'doc'）
import type { ClientFormat } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { canonicalContentText, contentHashInput, createdDocumentSchema, DOCUMENT_PROFILE_OF, errorResponseSchema, saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { CURRENT_CLIENT } from '../support/client-format.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { docSnapshotFor, seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let amy: TestAccount
let amySession: LoggedIn
let outsiderSession: LoggedIn

/** 文字文档的页面上报的四项 */
const DOC_CLIENT: ClientFormat = { ...CURRENT_CLIENT, profile: DOCUMENT_PROFILE_OF.doc }

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  amy = await createAccount(database, { username: 'profile-amy' })
  const outsider = await createAccount(database, { username: 'profile-outsider' })
  amySession = await login(app.baseUrl, amy.username, amy.password)
  outsiderSession = await login(app.baseUrl, outsider.username, outsider.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function amyDocument(type: 'sheet' | 'doc', title = '文档'): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title, type })
}

function sheetBytes(unitId: string): Buffer {
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId }), 'utf8')
}

function docBytes(unitId: string, overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify(docSnapshotFor(unitId, overrides, body)), 'utf8')
}

async function errorOf(response: Response): Promise<{ status: number, code: string, details: unknown }> {
  const { code, details } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, details }
}

async function save(document: SeededDocument, raw: Buffer, clientFormat: ClientFormat, baseRevision = 1): Promise<Response> {
  return saveContent(app.baseUrl, amySession, document.id, zlib.gzipSync(raw), { baseRevision, clientFormat })
}

async function rowOf(id: string): Promise<{ type: string, profile: string, revision: number, content_hash: Buffer | null, resource_names: string[] | null }> {
  const row = await database.query(async client => (await client.query<{ type: string, profile: string, revision: number, content_hash: Buffer | null, resource_names: string[] | null }>(
    'SELECT d.type, d.profile, d.revision, c.content_hash, c.resource_names FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1',
    [id],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有文档：${id}`)
  return row
}

async function documentCount(): Promise<number> {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM documents')).rows[0]?.count ?? 0)
}

const OUTDATED = { status: 409, code: 'CLIENT_OUTDATED', details: { reason: 'format' } }

describe('US-M6-13 保存：上报的档案与文档的档案（DEF-055）', () => {
  it('表格的文档、文字文档的页面（上传文字文档）：按 doc@1 检查通过，事务里 409 CLIENT_OUTDATED（format），什么也不写；看不到的照样 404', async () => {
    const document = await amyDocument('sheet')
    expect(await errorOf(await save(document, docBytes(document.unitId), DOC_CLIENT))).toEqual(OUTDATED)
    expect(await rowOf(document.id)).toMatchObject({ type: 'sheet', profile: 'sheet@1', revision: 1 })
    const hidden = await saveContent(app.baseUrl, outsiderSession, document.id, zlib.gzipSync(docBytes(document.unitId)), { baseRevision: 1, clientFormat: DOC_CLIENT })
    expect((await errorOf(hidden)).code).toBe('NOT_FOUND')
  })

  it('文字文档、表格的页面（上传表格）：409 CLIENT_OUTDATED（format）', async () => {
    const document = await amyDocument('doc')
    expect(await errorOf(await save(document, sheetBytes(document.unitId), CURRENT_CLIENT))).toEqual(OUTDATED)
    expect(await rowOf(document.id)).toMatchObject({ type: 'doc', profile: 'doc@1', revision: 1 })
  })

  it('文字文档、文字文档的页面：按 doc@1 检查与保存，内容哈希按 doc@1 规范化；不合规的链接 422（位置是段落）；不缩水按文档的档案', async () => {
    const document = await amyDocument('doc')
    const drawings = { img: { drawingId: 'img', docTransform: { size: { width: 120, height: 80 } } } }
    const raw = docBytes(document.unitId, { drawings, drawingsOrder: ['img'], resources: [{ name: 'DOC_DRAWING_PLUGIN', data: JSON.stringify({ data: drawings, order: ['img'] }) }] })
    const saved = await save(document, raw, DOC_CLIENT)
    expect(saved.status, await saved.clone().text()).toBe(200)
    expect(parseExact(saveContentResponseSchema, await saved.json())).toMatchObject({ revision: 2, unchanged: false })
    const row = await rowOf(document.id)
    expect(row).toMatchObject({ revision: 2, resource_names: ['DOC_DRAWING_PLUGIN'] })
    expect(row.content_hash?.equals(createHash('sha256').update(contentHashInput(canonicalContentText(raw.toString('utf8'), 'doc@1'))).digest())).toBe(true)

    const link = { startIndex: 4, endIndex: 5, rangeId: 'r1', rangeType: 0, properties: { url: 'javascript:alert(1)' } }
    expect(await errorOf(await save(document, docBytes(document.unitId, {}, { customRanges: [link] }), DOC_CLIENT, 2)))
      .toEqual({ status: 422, code: 'SNAPSHOT_INVALID', details: { rule: 'link-address', linkLocations: [{ kind: 'paragraph', paragraph: 1 }] } })
    // 上一版非空的图片资源这一版不在了
    expect(await errorOf(await save(document, docBytes(document.unitId, { resources: [] }), DOC_CLIENT, 2)))
      .toEqual({ status: 422, code: 'SNAPSHOT_INVALID', details: { rule: 'resource-missing' } })
    expect((await rowOf(document.id)).revision).toBe(2)
  })
})

describe('US-M6-13 另存为副本：上报的档案对照这类文档在服务端的档案（DEF-055）', () => {
  it('表格的原文档、文字文档的页面：409 CLIENT_OUTDATED（format），不建副本', async () => {
    const source = await amyDocument('sheet', '表格原文档')
    const before = await documentCount()
    expect(await errorOf(await postConflictCopy(app.baseUrl, amySession, source.id, source.unitId, { raw: docBytes(source.unitId), clientFormat: DOC_CLIENT }))).toEqual(OUTDATED)
    expect(await documentCount()).toBe(before)
  })

  it('文字文档的原文档、文字文档的页面：201，副本是文字文档，信封记服务端的档案', async () => {
    const source = await amyDocument('doc', '文字原文档')
    const response = await postConflictCopy(app.baseUrl, amySession, source.id, source.unitId, { raw: docBytes(source.unitId), clientFormat: DOC_CLIENT })
    expect(response.status, await response.clone().text()).toBe(201)
    const copy = parseExact(createdDocumentSchema, await response.json())
    expect(copy).toMatchObject({ type: 'doc', profile: 'doc@1' })
    expect(await rowOf(copy.id)).toMatchObject({ type: 'doc', profile: 'doc@1', revision: 1, resource_names: [] })
  })

  it('审查 A7 照旧：原文档由更新的版本写过（SDK 版本比服务端新），保存是 DOCUMENT_TOO_NEW，另存为副本照常 201', async () => {
    const source = await amyDocument('doc', '回滚之后')
    await database.query(async client => client.query('UPDATE documents SET sdk_version = \'99.0.0\' WHERE id = $1', [source.id]))
    expect((await errorOf(await save(source, docBytes(source.unitId), DOC_CLIENT))).code).toBe('DOCUMENT_TOO_NEW')
    const response = await postConflictCopy(app.baseUrl, amySession, source.id, source.unitId, { raw: docBytes(source.unitId), clientFormat: DOC_CLIENT })
    expect(response.status, await response.clone().text()).toBe(201)
    expect(parseExact(createdDocumentSchema, await response.json())).toMatchObject({ type: 'doc', profile: 'doc@1' })
  })
})

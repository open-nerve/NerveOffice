// 文档的内容（P4 设计 §3.3、§3.5，US-M1-05、06、07、08）：读取（gzip 原样下发、修订号作 ETag）；
// 保存（条件写入、requestId 幂等含并发、冲突附来源、解压上限与压缩炸弹、内容类型、基本校验、别人的与不存在的相同、未登录、CSRF）。
import type { SaveContentResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { AuthenticatedRequest, LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import {
  CSRF_TOKEN_HEADER,
  documentDetailSchema,
  errorResponseSchema,
  revisionConflictDetailsSchema,
  saveContentResponseSchema,
  SHEET_TEMPLATE,
  sheetSnapshotFor,
  SNAPSHOT_MAX_RAW_BYTES,
} from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount
let bob: TestAccount
let aliceSession: LoggedIn
let bobSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'alice' })
  bob = await createAccount(database, { username: 'bob' })
  aliceSession = await login(app.baseUrl, 'alice', alice.password)
  bobSession = await login(app.baseUrl, 'bob', bob.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

const TAB_A = randomUUID()
const TAB_B = randomUUID()

async function aliceDocument(title = '表格'): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title })
}

/** 模板换上 unitId，A1 写入 value：每次保存的内容都不同 */
function snapshotOf(unitId: string, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  const snapshot = { ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }
  return Buffer.from(JSON.stringify(snapshot), 'utf8')
}

interface SaveParams {
  readonly baseRevision?: number | string
  readonly requestId?: string
  readonly clientInstanceId?: string
  readonly localSeq?: number | string
}

function contentPath(id: string, params?: SaveParams): string {
  if (params === undefined)
    return `/api/documents/${id}/content`
  const query = new URLSearchParams({
    baseRevision: String(params.baseRevision ?? 1),
    requestId: params.requestId ?? randomUUID(),
    clientInstanceId: params.clientInstanceId ?? TAB_A,
    localSeq: String(params.localSeq ?? 1),
  })
  return `/api/documents/${id}/content?${query.toString()}`
}

async function put(user: LoggedIn, id: string, raw: Buffer, params: SaveParams = {}, request: Omit<AuthenticatedRequest, 'method'> = {}): Promise<Response> {
  return asUser(app.baseUrl, user, contentPath(id, params), { method: 'PUT', binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(raw) }, ...request })
}

async function saved(response: Response): Promise<SaveContentResponse> {
  expect(response.status).toBe(200)
  return parseExact(saveContentResponseSchema, await response.json())
}

/** 错误码、说明与详情（请求标识每次不同，不比较） */
async function errorOf(response: Response): Promise<{ code: string, message: string, details?: Record<string, unknown> }> {
  const { requestId: _requestId, ...error } = parseExact(errorResponseSchema, await response.json()).error
  return error
}

async function read(user: LoggedIn, id: string): Promise<Response> {
  return asUser(app.baseUrl, user, contentPath(id))
}

async function storedRevision(id: string): Promise<number> {
  return database.query(async client => (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [id])).rows[0]?.revision ?? 0)
}

describe('US-M1-06 读取内容', () => {
  it('200：gzip 字节原样下发（Content-Encoding: gzip），修订号作 ETag，不缓存', async () => {
    const document = await aliceDocument()
    const response = await read(aliceSession, document.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('etag')).toBe('"1"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const stored = await database.query(async client => (await client.query<{ stored_bytes: number }>('SELECT stored_bytes FROM document_contents WHERE document_id = $1', [document.id])).rows[0]?.stored_bytes)
    expect(Number(response.headers.get('content-length'))).toBe(stored)
    // fetch 按 Content-Encoding 自动解压
    expect(await response.text()).toBe(sheetSnapshotFor(document.unitId))
  })

  it('别人的与不存在的：同样的 404', async () => {
    const document = await aliceDocument()
    const others = await read(bobSession, document.id)
    const missing = await read(aliceSession, randomUUID())
    expect([others.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(others)).toEqual(await errorOf(missing))
  })

  it('有记录却没有内容：500，写日志，不伪装成 404', async () => {
    const document = await aliceDocument()
    await database.query(async client => client.query('DELETE FROM document_contents WHERE document_id = $1', [document.id]))
    const response = await read(aliceSession, document.id)
    expect(response.status).toBe(500)
    expect((await errorOf(response)).code).toBe('INTERNAL_ERROR')
    expect(app.logs.text()).toContain('文档有记录却没有内容')
  })

  it('id 不是 UUID：400；没有登录：401', async () => {
    expect((await read(aliceSession, 'not-a-uuid')).status).toBe(400)
    const anonymous = await fetch(`${app.baseUrl}${contentPath(randomUUID())}`)
    expect(anonymous.status).toBe(401)
  })
})

describe('US-M1-05 保存', () => {
  it('成功：修订号加一；重开读到保存的内容与新的 ETag；元数据、修订记录与审计同步', async () => {
    const document = await aliceDocument()
    const raw = snapshotOf(document.unitId, '第一次保存')
    const requestId = randomUUID()
    const result = await saved(await put(aliceSession, document.id, raw, { baseRevision: 1, requestId, clientInstanceId: TAB_A, localSeq: 7 }))
    expect(result.revision).toBe(2)

    const reopened = await read(aliceSession, document.id)
    expect(reopened.headers.get('etag')).toBe('"2"')
    expect(Buffer.from(await reopened.arrayBuffer())).toEqual(raw)
    const detail = parseExact(documentDetailSchema, await (await asUser(app.baseUrl, aliceSession, `/api/documents/${document.id}`)).json())
    expect(detail.revision).toBe(2)
    expect(detail.updatedAt).toBe(result.savedAt)

    const revision = await database.query(async client => (await client.query<Record<string, unknown>>('SELECT kind, client_instance_id, local_seq, saved_by FROM document_revisions WHERE document_id = $1 AND revision = 2', [document.id])).rows[0])
    expect(revision).toEqual({ kind: 'saved', client_instance_id: TAB_A, local_seq: 7, saved_by: alice.id })
    const audits = await database.query(async client => (await client.query<Record<string, unknown>>('SELECT actor_id, details FROM audit_events WHERE action = \'documents.content_saved\' AND target_id = $1', [document.id])).rows)
    expect(audits).toEqual([{ actor_id: alice.id, details: { revision: 2 } }])
  })

  it('没有修改也可以保存：修订号照常加一', async () => {
    const document = await aliceDocument()
    const raw = Buffer.from(sheetSnapshotFor(document.unitId), 'utf8')
    expect((await saved(await put(aliceSession, document.id, raw, { baseRevision: 1 }))).revision).toBe(2)
    expect((await saved(await put(aliceSession, document.id, raw, { baseRevision: 2 }))).revision).toBe(3)
  })

  it('解压后恰好 5 MiB 可以保存', async () => {
    const document = await aliceDocument()
    const base = snapshotOf(document.unitId, '')
    const padding = SNAPSHOT_MAX_RAW_BYTES - base.length
    const raw = snapshotOf(document.unitId, 'x'.repeat(padding))
    expect(raw.length).toBe(SNAPSHOT_MAX_RAW_BYTES)
    expect((await saved(await put(aliceSession, document.id, raw))).revision).toBe(2)
  })
})

describe('US-M1-05 同一次保存重发不会保存两次', () => {
  it('同一个 requestId 重放：返回原来的结果，修订号不再增加', async () => {
    const document = await aliceDocument()
    const raw = snapshotOf(document.unitId, '重放')
    const params = { baseRevision: 1, requestId: randomUUID() }
    const first = await saved(await put(aliceSession, document.id, raw, params))
    const second = await saved(await put(aliceSession, document.id, raw, params))
    expect(second).toEqual(first)
    expect(await storedRevision(document.id)).toBe(2)
  })

  it('并发的相同请求：只保存一次，每个请求都拿到同一个结果', async () => {
    const document = await aliceDocument()
    const raw = snapshotOf(document.unitId, '并发')
    const params = { baseRevision: 1, requestId: randomUUID() }
    const results = await Promise.all(Array.from({ length: 5 }, async () => saved(await put(aliceSession, document.id, raw, params))))
    expect(new Set(results.map(result => JSON.stringify(result))).size).toBe(1)
    expect(await storedRevision(document.id)).toBe(2)
  })

  it('同一个 requestId、不同的内容：409 REQUEST_ID_CONFLICT', async () => {
    const document = await aliceDocument()
    const params = { baseRevision: 1, requestId: randomUUID() }
    await saved(await put(aliceSession, document.id, snapshotOf(document.unitId, '甲'), params))
    const response = await put(aliceSession, document.id, snapshotOf(document.unitId, '乙'), params)
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('同一个 requestId 用到另一份文档：409 REQUEST_ID_CONFLICT', async () => {
    const [first, second] = [await aliceDocument(), await aliceDocument()]
    const requestId = randomUUID()
    await saved(await put(aliceSession, first.id, snapshotOf(first.unitId, '甲'), { requestId }))
    const response = await put(aliceSession, second.id, snapshotOf(second.unitId, '甲'), { requestId })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
    expect(await storedRevision(second.id)).toBe(1)
  })
})

describe('US-M1-07 旧页面的保存不覆盖新内容', () => {
  it('B 基于旧修订号保存：409 DOCUMENT_REVISION_CONFLICT，详情是当前修订号与 A 的来源；服务器上是 A 的版本', async () => {
    const document = await aliceDocument()
    const fromA = snapshotOf(document.unitId, 'A 的内容')
    await saved(await put(aliceSession, document.id, fromA, { baseRevision: 1, clientInstanceId: TAB_A, localSeq: 3 }))
    const response = await put(aliceSession, document.id, snapshotOf(document.unitId, 'B 的内容'), { baseRevision: 1, clientInstanceId: TAB_B, localSeq: 9 })
    expect(response.status).toBe(409)
    const error = await errorOf(response)
    expect(error.code).toBe('DOCUMENT_REVISION_CONFLICT')
    expect(revisionConflictDetailsSchema.parse(error.details)).toEqual({ currentRevision: 2, source: { clientInstanceId: TAB_A, localSeq: 3 } })
    expect(Buffer.from(await (await read(aliceSession, document.id)).arrayBuffer())).toEqual(fromA)
  })

  it('当前修订是新建出来的：冲突的来源为 null', async () => {
    const document = await aliceDocument()
    const response = await put(aliceSession, document.id, snapshotOf(document.unitId, 'x'), { baseRevision: 5 })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).details).toEqual({ currentRevision: 1, source: null })
  })
})

describe('保存的请求体：上限、压缩与内容类型', () => {
  it('解压后超过 5 MiB：413 PAYLOAD_TOO_LARGE', async () => {
    const document = await aliceDocument()
    const raw = snapshotOf(document.unitId, 'x'.repeat(SNAPSHOT_MAX_RAW_BYTES))
    const response = await put(aliceSession, document.id, raw)
    expect(response.status).toBe(413)
    expect((await errorOf(response)).code).toBe('PAYLOAD_TOO_LARGE')
    expect(await storedRevision(document.id)).toBe(1)
  })

  it('压缩炸弹（压缩后约 100 KiB，解压后 100 MiB）：413，解压到上限就停下', async () => {
    const document = await aliceDocument()
    const bomb = zlib.gzipSync(Buffer.alloc(100 * 1024 * 1024, 0x20))
    const started = performance.now()
    const response = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT', binary: { contentType: 'application/gzip', bytes: bomb } })
    expect(response.status).toBe(413)
    expect((await errorOf(response)).code).toBe('PAYLOAD_TOO_LARGE')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('压缩后超过 5 MiB：413，不再读取', async () => {
    const document = await aliceDocument()
    const response = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT', binary: { contentType: 'application/gzip', bytes: randomBytes(SNAPSHOT_MAX_RAW_BYTES + 1) } })
    expect(response.status).toBe(413)
    expect((await errorOf(response)).code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('不是 gzip：400 REQUEST_INVALID', async () => {
    const document = await aliceDocument()
    const response = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT', binary: { contentType: 'application/gzip', bytes: snapshotOf(document.unitId, 'x') } })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'REQUEST_INVALID', message: '请求体不是完整的 gzip 数据' })
  })

  it('内容类型不是 application/gzip 或者没有：415；带了 Content-Encoding：415；空的请求体：400', async () => {
    const document = await aliceDocument()
    const raw = snapshotOf(document.unitId, 'x')
    const asJson = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT', binary: { contentType: 'application/json', bytes: raw } })
    expect(asJson.status).toBe(415)
    expect(await errorOf(asJson)).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE', message: '请求体的内容类型必须是 application/gzip' })
    const untyped = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT' })
    expect(untyped.status).toBe(415)
    const encoded = await put(aliceSession, document.id, raw, {}, { headers: { 'content-encoding': 'gzip' } })
    expect(encoded.status).toBe(415)
    const empty = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT', binary: { contentType: 'application/gzip', bytes: new Uint8Array() } })
    expect(empty.status).toBe(400)
    expect((await errorOf(empty)).code).toBe('REQUEST_INVALID')
    expect(await storedRevision(document.id)).toBe(1)
  })
})

describe('保存的基本校验：422 SNAPSHOT_INVALID', () => {
  it.each([
    ['不是 JSON', (_unitId: string) => Buffer.from('{"id":', 'utf8')],
    ['不是 UTF-8', (_unitId: string) => Buffer.from([0x7B, 0xFF, 0x7D])],
    ['顶层是数组', (unitId: string) => Buffer.from(JSON.stringify([unitId]), 'utf8')],
    ['sheets 不是对象', (unitId: string) => Buffer.from(JSON.stringify({ id: unitId, sheetOrder: [], sheets: [] }), 'utf8')],
    ['嵌套超过 64 层', (unitId: string) => Buffer.from(`{"id":"${unitId}","sheetOrder":[],"sheets":{"a":${'['.repeat(80)}${']'.repeat(80)}}}`, 'utf8')],
    ['unitId 是别的文档的', (_unitId: string) => snapshotOf(randomUUID(), 'x')],
  ])('%s', async (_case, build) => {
    const document = await aliceDocument()
    const response = await put(aliceSession, document.id, build(document.unitId))
    expect(response.status).toBe(422)
    expect((await errorOf(response)).code).toBe('SNAPSHOT_INVALID')
    expect(await storedRevision(document.id)).toBe(1)
  })
})

describe('US-M1-08 保存：别人的与不存在的相同；登录与防护', () => {
  it('别人的文档与不存在的文档：同样的 404，内容不变', async () => {
    const document = await aliceDocument()
    const others = await put(bobSession, document.id, snapshotOf(document.unitId, '鲍勃'))
    const missing = await put(bobSession, randomUUID(), snapshotOf(document.unitId, '鲍勃'))
    expect([others.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(others)).toEqual(await errorOf(missing))
    expect(await storedRevision(document.id)).toBe(1)
  })

  it('查询参数不合法：400 REQUEST_INVALID', async () => {
    const document = await aliceDocument()
    for (const params of [{ baseRevision: 0 }, { baseRevision: 'x' }, { requestId: 'abc' }, { clientInstanceId: 'abc' }, { localSeq: -1 }]) {
      const response = await put(aliceSession, document.id, snapshotOf(document.unitId, 'x'), params)
      expect(response.status, JSON.stringify(params)).toBe(400)
      expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
    }
  })

  it('没有登录：401；Origin 不是本站：403；缺少 CSRF 令牌：403；都不写入', async () => {
    const document = await aliceDocument()
    const raw = snapshotOf(document.unitId, '拦下')
    const anonymous = await fetch(`${app.baseUrl}${contentPath(document.id, {})}`, { method: 'PUT', headers: { 'content-type': 'application/gzip', 'origin': TEST_PUBLIC_ORIGIN }, body: zlib.gzipSync(raw) })
    expect(anonymous.status).toBe(401)
    const foreign = await put(aliceSession, document.id, raw, {}, { headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    expect((await errorOf(foreign)).code).toBe('ORIGIN_NOT_ALLOWED')
    const noToken = await put(aliceSession, document.id, raw, {}, { headers: { [CSRF_TOKEN_HEADER]: undefined } })
    expect(noToken.status).toBe(403)
    expect((await errorOf(noToken)).code).toBe('CSRF_TOKEN_INVALID')
    expect(await storedRevision(document.id)).toBe(1)
  })
})

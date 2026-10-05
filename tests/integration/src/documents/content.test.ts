// 文档的内容（P4 设计 §3.3、§3.5，US-M1-05、06、07、08）：读取（gzip 原样下发、修订号作 ETag；M3-P2 起带 If-None-Match 而修订号没变时 304，US-M3-05）；
// 保存（条件写入、requestId 幂等含并发、冲突附来源、解压上限与压缩炸弹、内容类型、基本校验、别人的与不存在的相同、未登录、CSRF）。
// M3-P1 起保存要求编辑租约：每次保存经 support/edit-leases.ts 的 saveContent 先申请、保存之后释放（编辑租约本身的用例在 save-leases.test.ts）。
import type { SaveContentResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { AuthenticatedRequest, LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { connect } from 'node:net'
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
import { acquireLease, saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

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
  /** 用这份编辑租约（几次并发的保存共用同一个页面的租约）；没给时每次保存先申请、保存之后释放 */
  readonly lease?: HeldLease
}

/**
 * 内容的地址。带 params 时是保存的地址：只给读取正文就被拒绝的用例（请求体的上限、压缩、内容类型，拦截器在校验与服务之前）直接用，
 * 带着合法的代次，不带租约——这些请求到不了租约那一步；要走到服务的保存经 put（先申请租约）
 */
function contentPath(id: string, params?: SaveParams): string {
  if (params === undefined)
    return `/api/documents/${id}/content`
  const query = new URLSearchParams({
    baseRevision: String(params.baseRevision ?? 1),
    requestId: params.requestId ?? randomUUID(),
    clientInstanceId: params.clientInstanceId ?? TAB_A,
    localSeq: String(params.localSeq ?? 1),
    writeEpoch: '0',
  })
  return `/api/documents/${id}/content?${query.toString()}`
}

/** 保存：先以这个人、这个标签页申请编辑租约，带着它保存，再释放（给了 params.lease 就用它，不申请也不释放） */
async function put(user: LoggedIn, id: string, raw: Buffer, params: SaveParams = {}, request: Omit<AuthenticatedRequest, 'method'> = {}): Promise<Response> {
  return saveContent(app.baseUrl, user, id, zlib.gzipSync(raw), {
    baseRevision: params.baseRevision ?? 1,
    requestId: params.requestId,
    localSeq: params.localSeq ?? 1,
    clientInstanceId: params.clientInstanceId ?? TAB_A,
    lease: params.lease,
    headers: request.headers,
  })
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

describe('US-M3-05 读取内容的条件请求（M3-P2 设计 §3.2，DEF-017）：修订号没变时 304，不传内容', () => {
  async function conditional(user: LoggedIn, id: string, ifNoneMatch: string): Promise<Response> {
    return asUser(app.baseUrl, user, contentPath(id), { headers: { 'if-none-match': ifNoneMatch } })
  }

  it('US-M3-05 带着读到的 ETag 再读、修订号没变：304，只带 ETag（与 200 的相同）与不缓存，没有正文、内容编码与内容类型', async () => {
    const document = await aliceDocument()
    const first = await read(aliceSession, document.id)
    const etag = first.headers.get('etag') ?? ''
    await first.arrayBuffer()
    const response = await conditional(aliceSession, document.id, etag)
    expect(response.status).toBe(304)
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect([response.headers.get('content-encoding'), response.headers.get('content-type')]).toEqual([null, null])
    expect(await response.text()).toBe('')
  })

  it('US-M3-05 有人保存了新版本：修订号比手里的新，200 给新内容与新的 ETag；再带新的 ETag 读又是 304', async () => {
    const document = await aliceDocument()
    expect((await put(aliceSession, document.id, snapshotOf(document.unitId, '第二版'))).status).toBe(200)
    const response = await conditional(aliceSession, document.id, '"1"')
    expect([response.status, response.headers.get('etag'), response.headers.get('content-encoding')]).toEqual([200, '"2"', 'gzip'])
    expect(await response.text()).toBe(snapshotOf(document.unitId, '第二版').toString('utf8'))
    expect((await conditional(aliceSession, document.id, '"2"')).status).toBe(304)
  })

  it('弱校验器 W/"n"（反向代理改了编码会这样标）、列表里有当前修订、*：304；列表里没有、认不出的标签：200 照常给内容', async () => {
    const document = await aliceDocument()
    for (const value of ['W/"1"', '"7", "1"', '*'])
      expect((await conditional(aliceSession, document.id, value)).status, value).toBe(304)
    for (const value of ['"2"', '"abc"', '1', '']) {
      const response = await conditional(aliceSession, document.id, value)
      expect([response.status, response.headers.get('etag')], value).toEqual([200, '"1"'])
      expect(await response.text()).toBe(sheetSnapshotFor(document.unitId))
    }
  })

  it('US-M3-05 先判断权限（M3-P2 设计 §3.6）：别人的文档带着对得上的修订号也是 404，与不存在的相同，不因为 304 透露它在不在、是第几版', async () => {
    const document = await aliceDocument()
    for (const value of ['"1"', '*', 'W/"1"']) {
      const others = await conditional(bobSession, document.id, value)
      const missing = await conditional(bobSession, randomUUID(), value)
      expect([others.status, missing.status], value).toEqual([404, 404])
      expect(await errorOf(others)).toEqual(await errorOf(missing))
    }
  })

  it('没有登录：401（条件请求不放宽认证）', async () => {
    const document = await aliceDocument()
    const anonymous = await fetch(`${app.baseUrl}${contentPath(document.id)}`, { headers: { 'if-none-match': '"1"' } })
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

  it('US-M3-14 没有修改的保存（M3-P3 设计 §3.7）：存量（没有内容哈希）的第一次保存照常加一、补上哈希；之后内容相同的保存不加修订号——给出当前修订与它的时间，unchanged 为真', async () => {
    const document = await aliceDocument()
    const raw = Buffer.from(sheetSnapshotFor(document.unitId), 'utf8')
    const first = await saved(await put(aliceSession, document.id, raw, { baseRevision: 1 }))
    expect(first).toMatchObject({ revision: 2, unchanged: false })
    expect(await saved(await put(aliceSession, document.id, raw, { baseRevision: 2 }))).toEqual({ revision: 2, savedAt: first.savedAt, unchanged: true })
    expect(await storedRevision(document.id)).toBe(2)
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
    // 同一个页面的几次重发（M3-P1 起保存要求租约）：共用这个页面申请到的一份租约，各自申请会互相改写成新的一代
    const params = { baseRevision: 1, requestId: randomUUID(), lease: await acquireLease(app.baseUrl, aliceSession, document.id, TAB_A) }
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

  // 重放只把原来的结果交给同一个人对同一份文档的同一次保存（M2-P6 第 3 片复验）：下面两条的负载逐字节相同、摘要一致，
  // 挡住它们的只能是"保存的人"与"文档"这两条核对
  it('查看者拿别人在同一份文档上用过的 requestId、逐字节相同的负载：409 REQUEST_ID_CONFLICT，不把别人的结果给他', async () => {
    const spaceId = await createTeamSpace(database, { name: '重放的核对', createdBy: alice.id, members: { [alice.id]: 'editor', [bob.id]: 'viewer' } })
    const document = await seedDocument(database, { spaceId, createdBy: alice.id, title: '表格' })
    const raw = snapshotOf(document.unitId, '爱丽丝保存的')
    const params = { baseRevision: 1, requestId: randomUUID() }
    await saved(await put(aliceSession, document.id, raw, params))
    const response = await put(bobSession, document.id, raw, params)
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
    expect(await storedRevision(document.id)).toBe(2)
  })

  it('同一个人对 unitId 相同的副本发同一个 requestId 与负载：409 REQUEST_ID_CONFLICT，副本的修订号不变', async () => {
    const original = await aliceDocument('原件')
    const copy = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: '副本', unitId: original.unitId })
    const raw = snapshotOf(original.unitId, '同样的内容')
    const params = { baseRevision: 1, requestId: randomUUID() }
    await saved(await put(aliceSession, original.id, raw, params))
    const response = await put(aliceSession, copy.id, raw, params)
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
    expect(await storedRevision(copy.id)).toBe(1)
  })
})

describe('US-M1-07 旧页面的保存不覆盖新内容', () => {
  it('B 基于旧修订号保存：409 DOCUMENT_REVISION_CONFLICT，详情是当前修订号与 A 的来源；服务器上是 A 的版本', async () => {
    const document = await aliceDocument()
    // M3-P1 起两个标签页不能同时持有编辑权：A 申请、保存、释放之后 B 才申请到（put 每次都这样），B 仍是基于旧修订号保存——
    // 要验证的冲突与来源不变（B 打开时的修订号是 1，期间 A 保存了 2）
    const fromA = snapshotOf(document.unitId, 'A 的内容')
    await saved(await put(aliceSession, document.id, fromA, { baseRevision: 1, clientInstanceId: TAB_A, localSeq: 3 }))
    const response = await put(aliceSession, document.id, snapshotOf(document.unitId, 'B 的内容'), { baseRevision: 1, clientInstanceId: TAB_B, localSeq: 9 })
    expect(response.status).toBe(409)
    const error = await errorOf(response)
    expect(error.code).toBe('DOCUMENT_REVISION_CONFLICT')
    expect(revisionConflictDetailsSchema.parse(error.details)).toEqual({ currentRevision: 2, source: { clientInstanceId: TAB_A, localSeq: 3 } })
    expect(Buffer.from(await (await read(aliceSession, document.id)).arrayBuffer())).toEqual(fromA)
  })

  it('同一个基准修订号的并发保存（各自的 requestId）：只有一个成功，其余都是冲突，来源指向成功的那一次', async () => {
    const document = await aliceDocument()
    // M3-P1 起同一时刻只有一个标签页能写：原来六个标签页同时保存，改成持有租约的那一个页面并发发出六次保存（各自的 requestId 与本地序号）。
    // 要验证的仍是修订号的条件写入在文档行的锁下只放过一个，其余都是冲突、来源指向成功的那一次
    const lease = await acquireLease(app.baseUrl, aliceSession, document.id)
    const tabs = Array.from<string>({ length: 6 }).fill(lease.clientInstanceId)
    const responses = await Promise.all(tabs.map(async (tab, index) => put(aliceSession, document.id, snapshotOf(document.unitId, `并发 ${index}`), { baseRevision: 1, clientInstanceId: tab, localSeq: index, lease })))
    const statuses = responses.map(response => response.status)
    expect(statuses.filter(status => status === 200)).toHaveLength(1)
    expect(statuses.filter(status => status === 409)).toHaveLength(tabs.length - 1)
    const winner = statuses.indexOf(200)
    for (const [index, response] of responses.entries()) {
      if (index === winner)
        continue
      const error = await errorOf(response)
      expect(error.code).toBe('DOCUMENT_REVISION_CONFLICT')
      expect(error.details).toEqual({ currentRevision: 2, source: { clientInstanceId: tabs[winner], localSeq: winner } })
    }
    expect(await storedRevision(document.id)).toBe(2)
    const counts = await database.query(async client => (await client.query<{ revisions: string, audits: string }>(
      `SELECT (SELECT count(*) FROM document_revisions WHERE document_id = $1) AS revisions,
              (SELECT count(*) FROM audit_events WHERE action = 'documents.content_saved' AND target_id = $1) AS audits`,
      [document.id],
    )).rows[0])
    expect(counts).toEqual({ revisions: '2', audits: '1' })
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

  it.each([
    ['空成员加上合法的成员（浏览器只解第一个成员，得到空串）', (raw: Buffer) => Buffer.concat([zlib.gzipSync(Buffer.alloc(0)), zlib.gzipSync(raw)])],
    ['两个成员拼接', (raw: Buffer) => Buffer.concat([zlib.gzipSync(raw), zlib.gzipSync(raw)])],
    ['成员之后带着别的数据', (raw: Buffer) => {
      const member = zlib.gzipSync(raw)
      return Buffer.concat([member, Buffer.from([0]), randomBytes(64), member.subarray(member.length - 8)])
    }],
  ])('不是恰好一个完整的 gzip 成员：400，不入库（审查 A1）：%s', async (_case, build) => {
    const document = await aliceDocument()
    const response = await asUser(app.baseUrl, aliceSession, contentPath(document.id, {}), { method: 'PUT', binary: { contentType: 'application/gzip', bytes: build(snapshotOf(document.unitId, 'x')) } })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'REQUEST_INVALID', message: '请求体不是完整的 gzip 数据' })
    expect(await storedRevision(document.id)).toBe(1)
  })

  it('正文没传完客户端就断开：按请求中断处理，不记意外错误（审查 A3）', async () => {
    const document = await aliceDocument()
    const { port, hostname } = new URL(app.baseUrl)
    const path = contentPath(document.id, {})
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise<void>((resolve) => {
        const socket = connect(Number(port), hostname, () => {
          socket.write([
            `PUT ${path} HTTP/1.1`,
            `Host: ${hostname}:${port}`,
            `Cookie: ${aliceSession.cookie}`,
            `Origin: ${TEST_PUBLIC_ORIGIN}`,
            `${CSRF_TOKEN_HEADER}: ${aliceSession.session.csrfToken}`,
            'Content-Type: application/gzip',
            'Content-Length: 100000',
            '',
            '',
          ].join('\r\n'))
          // 请求头发完、正文只发一点就断开：服务端这时多半还在认证（查会话），读取正文时请求已经结束
          socket.write(randomBytes(10), () => socket.destroy())
        })
        socket.on('close', () => resolve())
        socket.on('error', () => resolve())
      })
    }
    await expect.poll(() => app.logs.entries().filter(entry => entry.aborted === true && String(entry.path).includes(document.id)).length).toBeGreaterThanOrEqual(5)
    // 中断的请求只记 warn"请求中断"：没有意外错误，也没有"中断之后处理失败"
    expect(app.logs.text()).not.toContain('请求体没有读成字节')
    expect(app.logs.entries().filter(entry => entry.msg === '请求中断之后处理失败')).toEqual([])
    expect(await storedRevision(document.id)).toBe(1)
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

describe('保存的快照检查：422 SNAPSHOT_INVALID，details 是违反的规则（M3-P3；每条规则的阳性与阴性见 save-protocol.test.ts）', () => {
  it.each([
    ['不是 JSON', 'json', (_unitId: string) => Buffer.from('{"id":', 'utf8')],
    ['不是 UTF-8', 'encoding', (_unitId: string) => Buffer.from([0x7B, 0xFF, 0x7D])],
    ['顶层是数组', 'structure', (unitId: string) => Buffer.from(JSON.stringify([unitId]), 'utf8')],
    ['sheets 不是对象', 'structure', (unitId: string) => Buffer.from(JSON.stringify({ id: unitId, sheetOrder: [], sheets: [] }), 'utf8')],
    ['嵌套超过 64 层', 'depth', (unitId: string) => Buffer.from(`{"id":"${unitId}","sheetOrder":[],"sheets":{"a":${'['.repeat(80)}${']'.repeat(80)}}}`, 'utf8')],
    ['unitId 是别的文档的', 'unit-id', (_unitId: string) => snapshotOf(randomUUID(), 'x')],
  ])('%s：%s', async (_case, rule, build) => {
    const document = await aliceDocument()
    const response = await put(aliceSession, document.id, build(document.unitId))
    expect(response.status).toBe(422)
    expect(await errorOf(response)).toMatchObject({ code: 'SNAPSHOT_INVALID', details: { rule } })
    expect(await storedRevision(document.id)).toBe(1)
  })
})

describe('复制文档时快照原样复制，unitId 相同（00 号计划书 §8.3，Codex 评审 CX5）', () => {
  it('两份 unitId 相同的文档可以并存；各自保存、读取互不影响；保存按各自的 unit_id 核对', async () => {
    const original = await aliceDocument('原件')
    const copy = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: '副本', unitId: original.unitId })
    expect(copy.unitId).toBe(original.unitId)

    expect((await saved(await put(aliceSession, original.id, snapshotOf(original.unitId, '原件的内容'), { baseRevision: 1 }))).revision).toBe(2)
    expect((await saved(await put(aliceSession, copy.id, snapshotOf(copy.unitId, '副本的内容'), { baseRevision: 1 }))).revision).toBe(2)
    expect(await (await read(aliceSession, original.id)).text()).toBe(snapshotOf(original.unitId, '原件的内容').toString('utf8'))
    expect(await (await read(aliceSession, copy.id)).text()).toBe(snapshotOf(copy.unitId, '副本的内容').toString('utf8'))

    // 别的 unitId 的快照仍然存不进副本
    const foreign = await put(aliceSession, copy.id, snapshotOf(randomUUID(), '别处的'), { baseRevision: 2 })
    expect(foreign.status).toBe(422)
    expect((await errorOf(foreign)).code).toBe('SNAPSHOT_INVALID')
    expect(await storedRevision(copy.id)).toBe(2)
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

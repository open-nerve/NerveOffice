// 新建文档（P4 设计 §3.3、§3.4，US-M1-04）：模板快照、修订号 1、requestId 幂等（含并发）、目标文件夹、审计、校验、未登录、Origin 与 CSRF。
import type { DocumentDetail, Folder } from '@nerve-office/contracts'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { CSRF_TOKEN_HEADER, documentDetailSchema, documentListResponseSchema, errorResponseSchema, folderSchema, sheetSnapshotFor, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount
let bob: TestAccount
let aliceSession: LoggedIn
let bobSession: LoggedIn

const MISSING_ID = '0199a2c4-0000-7000-8000-0000000000fe'

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'alice' })
  bob = await createAccount(database, { username: 'bob' })
  aliceSession = await login(app.baseUrl, 'alice', alice.password)
  bobSession = await login(app.baseUrl, 'bob', alice.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function create(user: LoggedIn, body: unknown): Promise<Response> {
  return asUser(app.baseUrl, user, '/api/documents', { method: 'POST', body })
}

async function created(user: LoggedIn, body: unknown): Promise<DocumentDetail> {
  const response = await create(user, body)
  expect(response.status).toBe(201)
  return parseExact(documentDetailSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function countWhere(sql: string, values: unknown[]): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(sql, values)).rows[0]?.count))
}

async function newFolder(user: LoggedIn, spaceId: string, name: string): Promise<Folder> {
  const response = await asUser(app.baseUrl, user, '/api/folders', { method: 'POST', body: { spaceId, name, requestId: randomUUID() } })
  expect(response.status).toBe(201)
  return parseExact(folderSchema, await response.json())
}

/** 一份文档现在的状态与所在的删除单元、文件夹 */
async function stateOf(id: string): Promise<{ status: string, folder_id: string | null, trash_entry_id: string | null } | undefined> {
  return database.query(async client => (await client.query<{ status: string, folder_id: string | null, trash_entry_id: string | null }>(
    'SELECT status, folder_id, trash_entry_id FROM documents WHERE id = $1',
    [id],
  )).rows[0])
}

/** 按标题找到的文档（并发的用例据此核对结果，不必先解析响应） */
async function statesOfTitle(title: string): Promise<{ status: string, folder_id: string | null, trash_entry_id: string | null }[]> {
  return database.query(async client => (await client.query<{ status: string, folder_id: string | null, trash_entry_id: string | null }>(
    'SELECT status, folder_id, trash_entry_id FROM documents WHERE title = $1',
    [title],
  )).rows)
}

/** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
function holdSpaceTree(spaceId: string) {
  return async (client: pg.Client) =>
    client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
}

/** 并发的用例里取某一个请求的响应 */
function responseOf(response: Response | undefined): Response {
  if (response === undefined)
    throw new Error('并发的请求没有给出响应')
  return response
}

describe('US-M1-04 新建表格', () => {
  it('201：元数据（修订号 1、档案、格式版本、可编辑），默认标题；个人空间的列表里第一条就是它', async () => {
    const document = await created(aliceSession, { type: 'sheet', requestId: randomUUID() })
    expect(document).toMatchObject({ title: '未命名表格', type: 'sheet', spaceId: alice.personalSpaceId, revision: 1, profile: 'sheet@1', formatVersion: 1, permissions: { canEdit: true } })
    const list = await asUser(app.baseUrl, aliceSession, '/api/documents')
    expect(parseExact(documentListResponseSchema, await list.json()).items[0]?.id).toBe(document.id)
  })

  it('内容是模板快照换上文档自己的 unitId；写了修订号 1 的修订记录与审计', async () => {
    const requestId = randomUUID()
    const document = await created(aliceSession, { type: 'sheet', title: '  周报  ', requestId })
    expect(document.title).toBe('周报')
    const row = await database.query(async client => (await client.query<{ unit_id: string, sdk_version: string, snapshot: Buffer, raw_bytes: number, stored_bytes: number }>(
      'SELECT d.unit_id, d.sdk_version, c.snapshot, c.raw_bytes, c.stored_bytes FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1',
      [document.id],
    )).rows[0])
    expect(row?.sdk_version).toBe(UNIVER_SDK_VERSION)
    const raw = zlib.gunzipSync(row?.snapshot ?? Buffer.alloc(0))
    expect(raw.toString('utf8')).toBe(sheetSnapshotFor(row?.unit_id ?? ''))
    expect([row?.raw_bytes, row?.stored_bytes]).toEqual([raw.length, row?.snapshot.length])

    const revisions = await database.query(async client => (await client.query<Record<string, unknown>>('SELECT revision, kind, request_id, client_instance_id, local_seq, saved_by FROM document_revisions WHERE document_id = $1', [document.id])).rows)
    expect(revisions).toEqual([{ revision: 1, kind: 'created', request_id: requestId, client_instance_id: null, local_seq: null, saved_by: alice.id }])
    const audits = await database.query(async client => (await client.query<Record<string, unknown>>('SELECT actor_id, target_type, details, request_id FROM audit_events WHERE action = \'documents.created\' AND target_id = $1', [document.id])).rows)
    expect(audits).toEqual([{ actor_id: alice.id, target_type: 'document', details: { revision: 1, folderId: null }, request_id: expect.any(String) as unknown }])
  })

  it('每份文档的 unitId 各不相同，与文档 id 独立', async () => {
    const first = await created(aliceSession, { type: 'sheet', requestId: randomUUID() })
    const second = await created(aliceSession, { type: 'sheet', requestId: randomUUID() })
    const rows = await database.query(async client => (await client.query<{ id: string, unit_id: string }>('SELECT id, unit_id FROM documents WHERE id = ANY($1)', [[first.id, second.id]])).rows)
    expect(new Set(rows.map(row => row.unit_id)).size).toBe(2)
    for (const row of rows)
      expect(row.unit_id).not.toBe(row.id)
  })
})

describe('US-M1-04 同一个创建请求只生成一份', () => {
  it('同一个 requestId 重放：同样 201，返回同一份文档，不再新建', async () => {
    const requestId = randomUUID()
    const first = await created(aliceSession, { type: 'sheet', title: '重放', requestId })
    const second = await created(aliceSession, { type: 'sheet', title: '重放', requestId })
    expect(second).toEqual(first)
    expect(await countWhere('SELECT count(*) FROM document_revisions WHERE request_id = $1', [requestId])).toBe(1)
    expect(await countWhere('SELECT count(*) FROM audit_events WHERE action = \'documents.created\' AND target_id = $1', [first.id])).toBe(1)
  })

  it('并发的相同请求：只建一份，每个请求都拿到它', async () => {
    const requestId = randomUUID()
    const responses = await Promise.all(Array.from({ length: 6 }, async () => create(aliceSession, { type: 'sheet', title: '并发', requestId })))
    expect(responses.map(response => response.status)).toEqual(Array.from({ length: 6 }).fill(201))
    const ids = await Promise.all(responses.map(async response => parseExact(documentDetailSchema, await response.json()).id))
    expect(new Set(ids).size).toBe(1)
    expect(await countWhere('SELECT count(*) FROM documents WHERE title = $1', ['并发'])).toBe(1)
  })

  it('同一个 UUID 的小写与大写写法并发：同样只建一份，每个请求都拿到它（锁与唯一约束按同一个相等定义，Codex 评审 CX7）', async () => {
    for (let group = 0; group < 10; group++) {
      const requestId = randomUUID()
      const title = `大小写 ${group}`
      const spellings = [requestId, requestId.toUpperCase(), requestId, requestId.toUpperCase()]
      const responses = await Promise.all(spellings.map(async spelling => create(aliceSession, { type: 'sheet', title, requestId: spelling })))
      expect(responses.map(response => response.status), `第 ${group} 组`).toEqual([201, 201, 201, 201])
      const ids = await Promise.all(responses.map(async response => parseExact(documentDetailSchema, await response.json()).id))
      expect(new Set(ids).size, `第 ${group} 组`).toBe(1)
      expect(await countWhere('SELECT count(*) FROM documents WHERE title = $1', [title])).toBe(1)
      expect(await countWhere('SELECT count(*) FROM document_revisions WHERE request_id = $1', [requestId])).toBe(1)
      expect(await countWhere('SELECT count(*) FROM audit_events WHERE action = \'documents.created\' AND target_id = $1', [ids[0]])).toBe(1)
    }
  })

  it('同一个 requestId、不同的标题：409 REQUEST_ID_CONFLICT', async () => {
    const requestId = randomUUID()
    await created(aliceSession, { type: 'sheet', title: '甲', requestId })
    const response = await create(aliceSession, { type: 'sheet', title: '乙', requestId })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
  })

  it('别人用过的 requestId：409 REQUEST_ID_CONFLICT，不返回那份文档', async () => {
    const requestId = randomUUID()
    await created(aliceSession, { type: 'sheet', title: '爱丽丝的', requestId })
    const response = await create(bobSession, { type: 'sheet', title: '爱丽丝的', requestId })
    expect(response.status).toBe(409)
    const body = await response.text()
    expect(body).toContain('REQUEST_ID_CONFLICT')
    expect(body).not.toContain('爱丽丝的')
  })
})

describe('US-M2-07 新建到指定的文件夹（M2-P4）', () => {
  it('201：文档就在那个文件夹里，那一层的列表里有它、空间根目录的列表里没有；审计记下位置', async () => {
    const folder = await newFolder(aliceSession, alice.personalSpaceId, '资料')
    const document = await created(aliceSession, { type: 'sheet', title: '在文件夹里', requestId: randomUUID(), folderId: folder.id })
    expect(document.folderId).toBe(folder.id)
    expect(await stateOf(document.id)).toMatchObject({ status: 'active', folder_id: folder.id })

    const inFolder = await asUser(app.baseUrl, aliceSession, `/api/documents?spaceId=${alice.personalSpaceId}&folderId=${folder.id}`)
    expect(parseExact(documentListResponseSchema, await inFolder.json()).items.map(item => item.id)).toEqual([document.id])
    const atRoot = await asUser(app.baseUrl, aliceSession, `/api/documents?spaceId=${alice.personalSpaceId}`)
    expect(parseExact(documentListResponseSchema, await atRoot.json()).items.map(item => item.id)).not.toContain(document.id)

    const audits = await database.query(async client => (await client.query<{ details: unknown }>('SELECT details FROM audit_events WHERE action = \'documents.created\' AND target_id = $1', [document.id])).rows)
    expect(audits).toEqual([{ details: { revision: 1, folderId: folder.id } }])
  })

  it('目标文件夹不存在、在别的空间里、在回收站里：同一个 404 NOT_FOUND，什么也不建', async () => {
    const elsewhere = await newFolder(bobSession, bob.personalSpaceId, '鲍勃的')
    const removed = await newFolder(aliceSession, alice.personalSpaceId, '待删')
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${removed.id}`, { method: 'DELETE' })).status).toBe(204)

    const title = `找不到位置 ${randomUUID()}`
    const responses = await Promise.all([MISSING_ID, elsewhere.id, removed.id].map(async folderId =>
      create(aliceSession, { type: 'sheet', title, requestId: randomUUID(), folderId })))
    expect(responses.map(response => response.status)).toEqual([404, 404, 404])
    const errors = await Promise.all(responses.map(async response => errorOf(response)))
    expect(errors).toEqual([errors[0], errors[0], errors[0]])
    expect(errors[0]?.code).toBe('NOT_FOUND')
    expect(await countWhere('SELECT count(*) FROM documents WHERE title = $1', [title])).toBe(0)
  })

  it('同一个 requestId 重放：返回同一份文档，不再新建；换一个位置是 409 REQUEST_ID_CONFLICT', async () => {
    const folder = await newFolder(aliceSession, alice.personalSpaceId, '重放')
    const another = await newFolder(aliceSession, alice.personalSpaceId, '重放二')
    const requestId = randomUUID()
    const body = { type: 'sheet', title: '重放到文件夹', requestId, folderId: folder.id }
    const first = await created(aliceSession, body)
    expect(await created(aliceSession, body)).toEqual(first)
    expect(await countWhere('SELECT count(*) FROM documents WHERE title = $1', ['重放到文件夹'])).toBe(1)

    // 位置进了负载摘要：同一个 requestId 换个文件夹、或者改成根目录，都不是同一个请求
    for (const changed of [{ ...body, folderId: another.id }, { type: 'sheet', title: '重放到文件夹', requestId }]) {
      const response = await create(aliceSession, changed)
      expect(response.status).toBe(409)
      expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
    }
  })

  it('新建先到、删除这个文件夹后到：文档建好，随后连同文件夹一起进回收站（不会在被删的文件夹里还是活的）', async () => {
    const folder = await newFolder(aliceSession, alice.personalSpaceId, '边建边删')
    const title = `边建边删 ${randomUUID()}`
    const [creating, removing] = await raceAgainstHeldLock(database, {
      // 新建（指定了文件夹）与删除文件夹都要空间树的锁：持住它，两个请求按到达的顺序排队
      hold: holdSpaceTree(alice.personalSpaceId),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const pending = step(create(aliceSession, { type: 'sheet', title, requestId: randomUUID(), folderId: folder.id }))
        await waitForWaiting(1)
        return Promise.all([pending, step(asUser(app.baseUrl, aliceSession, `/api/folders/${folder.id}`, { method: 'DELETE' }))])
      },
      change: async client => client.query('SELECT 1'),
    })
    expect([creating?.status, removing?.status]).toEqual([201, 204])
    // 删除是在新建之后才展开子树的：那份文档也在里面，与文件夹进同一个删除单元
    const states = await statesOfTitle(title)
    expect(states).toEqual([expect.objectContaining({ status: 'trashed', folder_id: folder.id })])
    expect(states[0]?.trash_entry_id).not.toBeNull()
    expect(await countWhere('SELECT count(*) FROM documents WHERE folder_id = $1 AND status = \'active\'', [folder.id])).toBe(0)
  })

  it('删除这个文件夹先到、新建后到：新建看到文件夹已经在回收站里，404，不建', async () => {
    const folder = await newFolder(aliceSession, alice.personalSpaceId, '先删再建')
    const title = `先删再建 ${randomUUID()}`
    const [removing, creating] = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(alice.personalSpaceId),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const pending = step(asUser(app.baseUrl, aliceSession, `/api/folders/${folder.id}`, { method: 'DELETE' }))
        await waitForWaiting(1)
        return Promise.all([pending, step(create(aliceSession, { type: 'sheet', title, requestId: randomUUID(), folderId: folder.id }))])
      },
      change: async client => client.query('SELECT 1'),
    })
    expect([removing?.status, creating?.status]).toEqual([204, 404])
    expect((await errorOf(responseOf(creating))).code).toBe('NOT_FOUND')
    expect(await statesOfTitle(title)).toEqual([])
  })
})

describe('新建的校验与防护', () => {
  it.each([
    ['类型不合法', { type: 'doc', requestId: randomUUID() }],
    ['没有类型', { requestId: randomUUID() }],
    ['没有 requestId', { type: 'sheet' }],
    ['requestId 不是 UUID', { type: 'sheet', requestId: 'abc' }],
    ['标题为空', { type: 'sheet', title: '   ', requestId: randomUUID() }],
    ['标题过长', { type: 'sheet', title: '长'.repeat(201), requestId: randomUUID() }],
    ['标题含控制字符', { type: 'sheet', title: '周\n报', requestId: randomUUID() }],
    ['多余的字段', { type: 'sheet', requestId: randomUUID(), parentId: randomUUID() }],
    ['空间不是 UUID', { type: 'sheet', requestId: randomUUID(), spaceId: 'personal' }],
    ['文件夹不是 UUID', { type: 'sheet', requestId: randomUUID(), folderId: 'root' }],
    ['文件夹为 null（省略才是根目录）', { type: 'sheet', requestId: randomUUID(), folderId: null }],
  ])('%s：400 REQUEST_INVALID', async (_case, body) => {
    const response = await create(aliceSession, body)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
  })

  it('没有登录：401', async () => {
    const response = await fetch(`${app.baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': TEST_PUBLIC_ORIGIN },
      body: JSON.stringify({ type: 'sheet', requestId: randomUUID() }),
    })
    expect(response.status).toBe(401)
    expect((await errorOf(response)).code).toBe('UNAUTHENTICATED')
  })

  it('Origin 不是本站：403 ORIGIN_NOT_ALLOWED；缺少 CSRF 令牌：403 CSRF_TOKEN_INVALID；都不新建', async () => {
    const title = `防护 ${randomUUID()}`
    const foreign = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title, requestId: randomUUID() }, headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    expect((await errorOf(foreign)).code).toBe('ORIGIN_NOT_ALLOWED')
    const noToken = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title, requestId: randomUUID() }, headers: { [CSRF_TOKEN_HEADER]: undefined } })
    expect(noToken.status).toBe(403)
    expect((await errorOf(noToken)).code).toBe('CSRF_TOKEN_INVALID')
    expect(await countWhere('SELECT count(*) FROM documents WHERE title = $1', [title])).toBe(0)
  })
})

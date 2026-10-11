// M4-P3 的恢复核对：真实 HTTP/数据库，明确省略租约头。取回旧回执不会变成一次新保存。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease, SaveOptions } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { CSRF_TOKEN_HEADER, EDIT_LEASE_HEADER, errorResponseSchema, saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, contentPathWithLease, saveContent } from '../support/edit-leases.ts'
import { login } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let amy: TestAccount
let ben: TestAccount
let amySession: LoggedIn
let benSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  amy = await createAccount(database, { username: 'recovery-amy' })
  ben = await createAccount(database, { username: 'recovery-ben' })
  amySession = await login(app.baseUrl, amy.username, amy.password)
  benSession = await login(app.baseUrl, ben.username, ben.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function documentIn(spaceId = amy.personalSpaceId): Promise<SeededDocument> {
  return seedDocument(database, { spaceId, createdBy: amy.id, title: '恢复核对原回执' })
}

function snapshot(document: SeededDocument, value = '原保存'): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return zlib.gzipSync(Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } })))
}

interface Attempt {
  readonly document: SeededDocument
  readonly lease: HeldLease
  readonly options: SaveOptions
  readonly body: Buffer
}

async function attempt(document: SeededDocument): Promise<Attempt> {
  const lease = await acquireLease(app.baseUrl, amySession, document.id)
  return { document, lease, options: { lease, baseRevision: 1, requestId: randomUUID(), localSeq: 73, query: { formulasPending: 'true' } }, body: snapshot(document) }
}

async function committed(value: Attempt) {
  const response = await saveContent(app.baseUrl, amySession, value.document.id, value.body, value.options)
  expect(response.status).toBe(200)
  return parseExact(saveContentResponseSchema, await response.json())
}

/** 显式构造真正发送的 Request，再核对租约头不存在；不经过会自动取得租约的保存辅助。 */
async function replay(value: Attempt, user: LoggedIn | null = amySession, body = value.body): Promise<Response> {
  const headers = new Headers({ 'origin': TEST_PUBLIC_ORIGIN, 'content-type': 'application/gzip' })
  if (user !== null) {
    headers.set('cookie', user.cookie)
    headers.set(CSRF_TOKEN_HEADER, user.session.csrfToken)
  }
  const request = new Request(`${app.baseUrl}${contentPathWithLease(value.document.id, value.lease, value.options)}`, { method: 'PUT', headers, body: new Blob([body]) })
  expect(request.headers.has(EDIT_LEASE_HEADER)).toBe(false)
  if (user === null)
    expect(request.headers.has('cookie')).toBe(false)
  return fetch(request)
}

/** 直接看持久状态，不能仅凭返回 200/409 声称没有再次写入。 */
async function stateOf(documentId: string) {
  return database.query(async (client) => {
    const state = (await client.query<{ revision: number, formulasPending: boolean, snapshot: Buffer, revisions: string, receipts: string, audits: string }>(`
      SELECT d.revision, d.formulas_pending AS "formulasPending", c.snapshot,
        (SELECT count(*) FROM document_revisions WHERE document_id = d.id) AS revisions,
        (SELECT count(*) FROM document_save_receipts WHERE document_id = d.id) AS receipts,
        (SELECT count(*) FROM audit_events WHERE target_id = d.id AND action = 'documents.content_saved') AS audits
      FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1
    `, [documentId])).rows[0]
    if (state === undefined)
      throw new Error('测试文档缺少内容')
    return { ...state, snapshot: zlib.gunzipSync(state.snapshot).toString('utf8') }
  })
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe(code)
}

describe('US-M4-05 原保存确认丢失后的无租约核对', () => {
  it('已提交的原样请求返回同一结果，修订、回执、审计、正文与公式标记均不变', async () => {
    const original = await attempt(await documentIn())
    const saved = await committed(original)
    const before = await stateOf(original.document.id)
    expect(before).toMatchObject({ revision: 2, revisions: '2', receipts: '0', audits: '1', formulasPending: true })
    const response = await replay(original)
    expect(response.status).toBe(200)
    expect(parseExact(saveContentResponseSchema, await response.json())).toEqual(saved)
    expect(await stateOf(original.document.id)).toEqual(before)
  })

  it('内容相同产生的回执也可核对，不重复插入回执或增加修订', async () => {
    const first = await attempt(await documentIn())
    await committed(first)
    const same = { ...first, options: { ...first.options, baseRevision: 2, requestId: randomUUID(), localSeq: 74 } }
    const saved = await committed(same)
    expect(saved).toMatchObject({ revision: 2, unchanged: true })
    const before = await stateOf(first.document.id)
    expect(before).toMatchObject({ revision: 2, revisions: '2', receipts: '1', audits: '1' })
    const response = await replay(same)
    expect(response.status).toBe(200)
    expect(parseExact(saveContentResponseSchema, await response.json())).toEqual(saved)
    expect(await stateOf(first.document.id)).toEqual(before)
  })

  it('服务器已经又保存了更新内容，核对旧回执不覆盖新版，也不清掉新版公式标记', async () => {
    const original = await attempt(await documentIn())
    const saved = await committed(original)
    const next = { ...original, body: snapshot(original.document, '之后保存的新内容'), options: { ...original.options, baseRevision: 2, requestId: randomUUID(), localSeq: 74 } }
    expect(await committed(next)).toMatchObject({ revision: 3 })
    const before = await stateOf(original.document.id)
    expect(before.snapshot).toContain('之后保存的新内容')
    const response = await replay(original)
    expect(response.status).toBe(200)
    expect(parseExact(saveContentResponseSchema, await response.json())).toEqual(saved)
    expect(await stateOf(original.document.id)).toEqual(before)
  })

  it.each([false, true])('未提交的请求不能借正确的页面与代次获得写入（已经新申请=%s）', async (reacquired) => {
    const original = await attempt(await documentIn())
    if (reacquired) {
      const next = await acquireLease(app.baseUrl, amySession, original.document.id, original.lease.clientInstanceId)
      expect(next.writeEpoch).toBeGreaterThan(original.lease.writeEpoch)
    }
    const before = await stateOf(original.document.id)
    expect(before).toMatchObject({ revision: 1, revisions: '1', receipts: '0', audits: '0' })
    await expectError(await replay(original), 409, 'EDIT_LEASE_LOST')
    expect(await stateOf(original.document.id)).toEqual(before)
  })

  it('同一个请求标识但正文不同，明确拒绝，原内容不变', async () => {
    const original = await attempt(await documentIn())
    await committed(original)
    const before = await stateOf(original.document.id)
    await expectError(await replay(original, amySession, snapshot(original.document, '不能套旧标识的新内容')), 409, 'REQUEST_ID_CONFLICT')
    expect(await stateOf(original.document.id)).toEqual(before)
  })

  it.each(['viewer', undefined] as const)('原保存者现在角色为 %s：只读仍可核对，读不到不返回回执', async (role) => {
    const team = await createTeamSpace(database, { name: `恢复权限：${role ?? '已移出'}`, createdBy: ben.id, members: { [ben.id]: 'admin', [amy.id]: 'editor' } })
    const original = await attempt(await documentIn(team))
    const saved = await committed(original)
    await setMember(database, team, amy.id, role)
    const before = await stateOf(original.document.id)
    const response = await replay(original)
    if (role === 'viewer') {
      expect(response.status).toBe(200)
      expect(parseExact(saveContentResponseSchema, await response.json())).toEqual(saved)
    }
    else {
      await expectError(response, 404, 'NOT_FOUND')
    }
    expect(await stateOf(original.document.id)).toEqual(before)
  })

  it('另一个仍能编辑的人不能冒认原用户的请求标识', async () => {
    const team = await createTeamSpace(database, { name: '恢复归属', createdBy: ben.id, members: { [ben.id]: 'admin', [amy.id]: 'editor' } })
    const original = await attempt(await documentIn(team))
    await committed(original)
    const before = await stateOf(original.document.id)
    await expectError(await replay(original, benSession), 409, 'REQUEST_ID_CONFLICT')
    expect(await stateOf(original.document.id)).toEqual(before)
  })

  it('未登录不返回原回执', async () => {
    const original = await attempt(await documentIn())
    await committed(original)
    const before = await stateOf(original.document.id)
    await expectError(await replay(original, null), 401, 'UNAUTHENTICATED')
    expect(await stateOf(original.document.id)).toEqual(before)
  })
})

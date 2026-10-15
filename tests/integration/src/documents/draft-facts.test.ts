import type { DocumentDraftFactsResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import type { StatementCapture } from '../support/statement-capture.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { documentDraftFactsResponseSchema, editStatusSchema, errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, handOverLease, passIdleTime, passLeaseTime, pendingRequestId, releaseLease, saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'
import { captureStatements } from '../support/statement-capture.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount
let bob: TestAccount
let root: TestAccount
let aliceSession: LoggedIn
let bobSession: LoggedIn
let rootSession: LoggedIn
let capture: StatementCapture

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'draft-alice' })
  bob = await createAccount(database, { username: 'draft-bob' })
  root = await createAccount(database, { username: 'draft-root', systemRole: 'admin' })
  aliceSession = await login(app.baseUrl, alice.username, alice.password)
  bobSession = await login(app.baseUrl, bob.username, bob.password)
  rootSession = await login(app.baseUrl, root.username, root.password)
  capture = captureStatements(database.name)
})

afterAll(async () => {
  capture?.restore()
  try {
    await app?.close()
  }
  finally {
    await database?.drop()
  }
})

async function ownDocument(owner = alice) {
  return seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '本机草稿事实' })
}

async function facts(session: LoggedIn, ids: readonly string[]): Promise<DocumentDraftFactsResponse> {
  const response = await asUser(app.baseUrl, session, `/api/documents/draft-facts?ids=${ids.join(',')}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(documentDraftFactsResponseSchema, await response.json())
}

async function share(documentId: string, role: 'editor' | 'viewer') {
  expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${documentId}/grants/${bob.id}`, { method: 'PUT', body: { role } })).status).toBe(200)
}

async function occupied(documentId: string, expected: boolean, session = aliceSession) {
  expect((await facts(session, [documentId])).items[0]).toMatchObject({ status: 'accessible', occupied: expected })
  const statusResponse = await asUser(app.baseUrl, session, `/api/documents/${documentId}/edit-lease`)
  expect(statusResponse.status).toBe(200)
  const status = parseExact(editStatusSchema, await statusResponse.json())
  expect(status.editor !== null || status.reservation !== null).toBe(expected)
}

describe('US-M4-07 草稿页的批量文档事实', () => {
  it('静态路由、顺序、UUID 去重与最小字段；不返回正文或内部身份', async () => {
    const a = await ownDocument()
    const b = await ownDocument()
    const absent = randomUUID()
    expect(await facts(aliceSession, [b.id.toUpperCase(), absent, a.id, b.id])).toEqual({ items: [
      { status: 'accessible', id: b.id, title: '本机草稿事实', type: 'sheet', canEdit: true, revision: 1, revisionSource: null, occupied: false },
      { status: 'unavailable', id: absent },
      { status: 'accessible', id: a.id, title: '本机草稿事实', type: 'sheet', canEdit: true, revision: 1, revisionSource: null, occupied: false },
    ] })
  })

  it('未登录被拒绝；畸形与重复查询参数为 REQUEST_INVALID', async () => {
    const id = randomUUID()
    const anonymous = await fetch(`${app.baseUrl}/api/documents/draft-facts?ids=${id}`)
    expect(anonymous.status).toBe(401)
    expect(errorResponseSchema.parse(await anonymous.json()).error.code).toBe('UNAUTHENTICATED')
    for (const query of ['', '?ids=', '?ids=bad', `?ids=${id},`, `?ids=${id}&ids=${id}`, `?ids=${id}&extra=1`, `?ids=${Array.from({ length: 101 }).fill(id).join(',')}`]) {
      const response = await asUser(app.baseUrl, aliceSession, `/api/documents/draft-facts${query}`)
      expect(response.status).toBe(400)
      expect(errorResponseSchema.parse(await response.json()).error.code).toBe('REQUEST_INVALID')
    }
  })

  it('100 份正常文档一次查询，不逐份查修订/租约，也不取正文', async () => {
    const ids: string[] = []
    for (let index = 0; index < 100; index++)
      ids.push((await ownDocument()).id)
    const observed = await capture.during(async () => facts(aliceSession, ids.toReversed()))
    expect(observed.result.items.map(item => item.id)).toEqual(ids.toReversed())
    expect(observed.result.items.every(item => item.status === 'accessible')).toBe(true)
    expect(observed.statements.filter(query => /^select\b/i.test(query)).length).toBeLessThanOrEqual(12)
    expect(observed.statements.some(query => query.includes('document_contents'))).toBe(false)
    expect(observed.statements.filter(query => query.includes('from "document_revisions"'))).toHaveLength(1)
    expect(observed.statements.filter(query => query.includes('from "document_edit_leases"'))).toHaveLength(1)
  })

  it('系统管理员不能读未加入空间；单独授权与归档后的编辑位依既有规则', async () => {
    const doc = await ownDocument()
    expect(await facts(rootSession, [doc.id])).toEqual({ items: [{ id: doc.id, status: 'unavailable' }] })
    await share(doc.id, 'editor')
    expect((await facts(bobSession, [doc.id])).items[0]).toMatchObject({ status: 'accessible', canEdit: true })
    const team = await createTeamSpace(database, { name: '归档草稿', createdBy: root.id, members: { [alice.id]: 'admin', [bob.id]: 'editor' } })
    const teamDoc = await seedDocument(database, { spaceId: team, createdBy: alice.id, title: '归档草稿' })
    await setSpaceState(database, team, { status: 'archived' })
    expect((await facts(bobSession, [teamDoc.id])).items[0]).toMatchObject({ status: 'accessible', canEdit: false })
    expect(await facts(rootSession, [teamDoc.id])).toEqual({ items: [{ id: teamDoc.id, status: 'unavailable' }] })
  })

  it('取消单独授权和跨空间移动后，按新的访问权限隐藏草稿标题', async () => {
    const doc = await ownDocument()
    await share(doc.id, 'viewer')
    expect((await facts(bobSession, [doc.id])).items[0]).toMatchObject({ status: 'accessible' })
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${doc.id}/grants/${bob.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await facts(bobSession, [doc.id])).toEqual({ items: [{ id: doc.id, status: 'unavailable' }] })
    const team = await createTeamSpace(database, { name: '移动草稿', createdBy: root.id, members: { [alice.id]: 'admin', [bob.id]: 'viewer' } })
    const moved = await seedDocument(database, { spaceId: team, createdBy: alice.id, title: '移动后的私有草稿' })
    expect((await facts(bobSession, [moved.id])).items[0]).toMatchObject({ status: 'accessible', canEdit: false })
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${moved.id}/move`, { method: 'POST', body: { spaceId: alice.personalSpaceId } })).status).toBe(200)
    expect(await facts(bobSession, [moved.id])).toEqual({ items: [{ id: moved.id, status: 'unavailable' }] })
    expect((await facts(aliceSession, [moved.id])).items[0]).toMatchObject({ status: 'accessible', canEdit: true })
  })

  it('全部隐藏、全部缺失、回收站以及与可读项混排：响应同形，SQL 序列相同', async () => {
    const own = await ownDocument()
    const hidden = await ownDocument(bob)
    const trashed = await ownDocument()
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${trashed.id}`, { method: 'DELETE' })).status).toBe(204)
    const absent = randomUUID()
    for (const prefix of [[], [own.id]]) {
      const missing = await capture.during(async () => facts(aliceSession, [...prefix, absent]))
      for (const id of [hidden.id, trashed.id]) {
        const unavailable = await capture.during(async () => facts(aliceSession, [...prefix, id]))
        expect(unavailable.result.items.at(-1)).toEqual({ id, status: 'unavailable' })
        expect(unavailable.result.items.slice(0, -1)).toEqual(missing.result.items.slice(0, -1))
        expect(unavailable.statements).toEqual(missing.statements)
      }
      expect(missing.result.items.at(-1)).toEqual({ id: absent, status: 'unavailable' })
      expect(missing.statements.length).toBeGreaterThan(0)
    }
  })

  it('当前修订来源只给保存者本人，隐藏他人的标签页和序号', async () => {
    const doc = await ownDocument()
    await share(doc.id, 'viewer')
    const page = randomUUID()
    const snapshot = { ...SHEET_TEMPLATE, id: doc.unitId, sheets: { 'sheet-1': { ...SHEET_TEMPLATE.sheets['sheet-1'], cellData: { 0: { 0: { v: '来源核对' } } } } } }
    const saved = await saveContent(app.baseUrl, aliceSession, doc.id, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot))), { baseRevision: 1, clientInstanceId: page, localSeq: 17 })
    expect(saved.status).toBe(200)
    await saved.arrayBuffer()
    expect((await facts(aliceSession, [doc.id])).items[0]).toMatchObject({ revision: 2, revisionSource: { clientInstanceId: page, localSeq: 17 } })
    expect((await facts(bobSession, [doc.id])).items[0]).toMatchObject({ canEdit: false, revisionSource: null })
  })
})

describe('US-M4-07 占用事实复用现有租约规则', () => {
  it('本人和他人有效持有都占用；释放后不占用', async () => {
    const doc = await ownDocument()
    await share(doc.id, 'viewer')
    const lease = await acquireLease(app.baseUrl, aliceSession, doc.id)
    await occupied(doc.id, true)
    await occupied(doc.id, true, bobSession)
    await releaseLease(app.baseUrl, aliceSession, doc.id, lease)
    await occupied(doc.id, false)
  })

  it.each(['expired', 'idle', 'session', 'permission'] as const)('%s 已不满足时，即使仍有租约行也不占用', async (cause) => {
    const doc = await ownDocument()
    await share(doc.id, 'editor')
    const holder = await login(app.baseUrl, bob.username, bob.password)
    await acquireLease(app.baseUrl, holder, doc.id)
    if (cause === 'expired')
      await passLeaseTime(database, doc.id, 3600)
    else if (cause === 'idle')
      await passIdleTime(database, doc.id, 720)
    else if (cause === 'session')
      expect((await asUser(app.baseUrl, holder, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    else
      await database.query(async client => client.query('UPDATE document_grants SET role = \'viewer\' WHERE document_id = $1 AND user_id = $2', [doc.id, bob.id]))
    const rows = await database.query(async client => client.query('SELECT ended_at FROM document_edit_leases WHERE document_id = $1', [doc.id]))
    expect(rows.rows).toEqual([{ ended_at: null }])
    await occupied(doc.id, false)
  })

  it('代次变化后本人可重新申请，其他人仍需给原持有者续上的机会（R2）', async () => {
    const doc = await ownDocument()
    await share(doc.id, 'editor')
    await acquireLease(app.baseUrl, bobSession, doc.id)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [doc.id]))
    await occupied(doc.id, true)
    await occupied(doc.id, false, bobSession)
  })

  it.each(['active', 'expired', 'permission'] as const)('交出后的预留 %s：按时间与被预留人的编辑权判断', async (condition) => {
    const doc = await ownDocument()
    await share(doc.id, 'editor')
    const lease = await acquireLease(app.baseUrl, aliceSession, doc.id)
    const requestId = await pendingRequestId(app.baseUrl, bobSession, doc.id)
    expect((await handOverLease(app.baseUrl, aliceSession, doc.id, lease, requestId)).status).toBe(200)
    if (condition === 'expired')
      await passLeaseTime(database, doc.id, 3600)
    else if (condition === 'permission')
      await database.query(async client => client.query('UPDATE document_grants SET role = \'viewer\' WHERE document_id = $1 AND user_id = $2', [doc.id, bob.id]))
    await occupied(doc.id, condition === 'active')
  })
})

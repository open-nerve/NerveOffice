// 分享的接口与"与我共享"（M2-P5 设计 §3.2、§3.4(2)(3)(4)(6)，S2；US-M2-10、14）：
// - 设置、调整、取消与幂等：同样的角色什么都不写，没有这条授权时取消照样 204；每次改动一条审计（明细只有定长标量，不记标题）；
// - 校验与错误：先判断文档（看不到 404、不能分享 403），再看被授权人（给自己 400、不存在或停用 409）；停用的人的授权能取消；
//   归档的空间里查看、设置、调整、取消都 403（冻结的说明）；回收站里的 404；
// - 经接口分享之后的有效权限（取较高者，只凭授权的人不能移动与删除；S1 的 grants.test.ts 直接写库核对了全部组合）；
// - "与我共享"的内容与分页：包括我在那个空间也有角色的；个人空间带所有者、不带存的名称；回收站里的不出现；
// - 按空间列出与回收站不受授权影响；搜索受授权影响（凭授权命中的不带文件夹，个人空间带所有者）；
// - 授权跟着文档走：跨空间移动、移出空间、停用、转移都保留授权。
// 锁的确定交错在 sharing-locks.test.ts；看不到与不存在的语句序列在 permissions/hidden-missing-parity.test.ts。
import type { DocumentGrant, SharedListResponse, SpaceRole } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import {
  createdDocumentSchema,
  createdFolderSchema,
  documentDetailSchema,
  documentGrantListResponseSchema,
  documentGrantSchema,
  documentListResponseSchema,
  errorResponseSchema,
  searchResponseSchema,
  SHARED_PAGE_SIZE,
  sharedListResponseSchema,
  SHEET_TEMPLATE,
  trashListResponseSchema,
} from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { grantsOn, setGrant } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let benSession: LoggedIn
let catSession: LoggedIn
let spaces = 0

const FROZEN = { status: 403, code: 'PERMISSION_DENIED', message: '空间已归档，恢复之后才能调整分享' }
const NOT_ADMIN = { status: 403, code: 'PERMISSION_DENIED', message: '只有空间管理员能分享这份文档' }
const GRANT_ONLY = { status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能再分享给别人' }

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  cat = await createAccount(database, { username: 'cat', displayName: '凯特' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
  catSession = await login(app.baseUrl, 'cat', cat.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一个新的团队空间：默认艾米是空间管理员；本与凯特按需给角色 */
async function teamSpace(members: Readonly<Record<string, SpaceRole>> = {}, name?: string): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: name ?? `分享 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', ...members } })
}

async function share(user: LoggedIn, documentId: string, userId: string, role: string | Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/grants/${userId}`, { method: 'PUT', body: typeof role === 'string' ? { role } : role })
}

async function shared(user: LoggedIn, documentId: string, userId: string, role: 'viewer' | 'editor'): Promise<DocumentGrant> {
  const response = await share(user, documentId, userId, role)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(documentGrantSchema, await response.json())
}

async function unshare(user: LoggedIn, documentId: string, userId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/grants/${userId}`, { method: 'DELETE' })
}

async function grantsOf(user: LoggedIn, documentId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/grants`)
}

async function grantList(user: LoggedIn, documentId: string): Promise<DocumentGrant[]> {
  const response = await grantsOf(user, documentId)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(documentGrantListResponseSchema, await response.json()).items
}

async function sharedWithMe(user: LoggedIn, cursor?: string): Promise<SharedListResponse> {
  const response = await asUser(app.baseUrl, user, `/api/shared${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(sharedListResponseSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ status: number, code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, message }
}

async function open(user: LoggedIn, documentId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}`)
}

async function save(user: LoggedIn, document: SeededDocument, baseRevision: number): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: String(baseRevision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return asUser(app.baseUrl, user, `/api/documents/${document.id}/content?${query.toString()}`, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(raw) },
  })
}

async function search(user: LoggedIn, query: string) {
  const response = await asUser(app.baseUrl, user, `/api/search?query=${encodeURIComponent(query)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(searchResponseSchema, await response.json())
}

interface StoredGrant { readonly role: string, readonly grantedBy: string, readonly updatedAt: string }

/** 库里的那一条授权（时间是数据库算出的 ISO 文本，与接口给出的比较） */
async function storedGrant(documentId: string, userId: string): Promise<StoredGrant | undefined> {
  return database.query(async client => (await client.query<StoredGrant>(
    `SELECT role, granted_by AS "grantedBy", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
     FROM document_grants WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId],
  )).rows[0])
}

interface SharingAudit { readonly action: string, readonly actorId: string, readonly details: unknown }

/** 这份文档上的分享审计，按发生的先后 */
async function sharingAudits(documentId: string): Promise<SharingAudit[]> {
  return database.query(async client => (await client.query<SharingAudit>(
    `SELECT action, actor_id AS "actorId", details FROM audit_events
     WHERE target_type = 'document' AND target_id = $1 AND action IN ('documents.shared', 'documents.share_changed', 'documents.share_revoked')
     ORDER BY occurred_at, id`,
    [documentId],
  )).rows)
}

const person = (account: { readonly id: string, readonly username: string }, displayName: string) => ({ id: account.id, username: account.username, displayName })

describe('US-M2-10 设置、调整、取消与幂等（M2-P5 设计 §3.2）', () => {
  it('新建：200，响应是这一条授权（被授权人与设置人的人名、账户状态、角色、设置的时间）；记 documents.shared；列表里有它，被授权人随即打得开', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '季度计划' })
    const grant = await shared(amySession, document.id, ben.id, 'viewer')
    const stored = await storedGrant(document.id, ben.id)
    expect(grant).toEqual({ user: person(ben, '本'), status: 'active', role: 'viewer', grantedBy: person(amy, '艾米'), grantedAt: stored?.updatedAt })
    expect(stored).toMatchObject({ role: 'viewer', grantedBy: amy.id })
    expect(await sharingAudits(document.id)).toEqual([{ action: 'documents.shared', actorId: amy.id, details: { userId: ben.id, role: 'viewer' } }])
    expect(await grantList(amySession, document.id)).toEqual([grant])
    expect(parseExact(documentDetailSchema, await (await open(benSession, document.id)).json())).toMatchObject({ accessVia: 'grant', folderId: null, permissions: { canEdit: false } })
  })

  it('同样的角色：200，什么都不写——设置人与时间不变、不记审计（另一位空间管理员再设一次也一样）', async () => {
    const spaceId = await teamSpace({ [cat.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '幂等' })
    const first = await shared(amySession, document.id, ben.id, 'editor')
    const again = await shared(catSession, document.id, ben.id, 'editor')
    expect(again).toEqual(first)
    expect(await storedGrant(document.id, ben.id)).toMatchObject({ role: 'editor', grantedBy: amy.id, updatedAt: first.grantedAt })
    expect((await sharingAudits(document.id)).map(audit => audit.action)).toEqual(['documents.shared'])
  })

  it('调整：查看者升为编辑者、编辑者降为查看者，各记一条 documents.share_changed；最后设置它的人与时间跟着更新', async () => {
    const spaceId = await teamSpace({ [cat.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '调整' })
    const first = await shared(amySession, document.id, ben.id, 'viewer')
    const upgraded = await shared(catSession, document.id, ben.id, 'editor')
    expect(upgraded).toMatchObject({ role: 'editor', grantedBy: person(cat, '凯特') })
    expect(Date.parse(upgraded.grantedAt)).toBeGreaterThan(Date.parse(first.grantedAt))
    expect(await storedGrant(document.id, ben.id)).toEqual({ role: 'editor', grantedBy: cat.id, updatedAt: upgraded.grantedAt })
    expect((await save(benSession, document, 1)).status).toBe(200)

    expect(await shared(amySession, document.id, ben.id, 'viewer')).toMatchObject({ role: 'viewer', grantedBy: person(amy, '艾米') })
    expect(await sharingAudits(document.id)).toEqual([
      { action: 'documents.shared', actorId: amy.id, details: { userId: ben.id, role: 'viewer' } },
      { action: 'documents.share_changed', actorId: cat.id, details: { userId: ben.id, from: 'viewer', to: 'editor' } },
      { action: 'documents.share_changed', actorId: amy.id, details: { userId: ben.id, from: 'editor', to: 'viewer' } },
    ])
    // 降为查看者之后下一次保存即被拒绝
    expect(await errorOf(await save(benSession, document, 2))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能保存' })
  })

  it('取消：204，删行，记 documents.share_revoked（删掉之前的角色）；之后他打开、读内容都与不存在的文档相同', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '取消' })
    await shared(amySession, document.id, ben.id, 'editor')
    expect((await open(benSession, document.id)).status).toBe(200)
    const response = await unshare(amySession, document.id, ben.id)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(await storedGrant(document.id, ben.id)).toBeUndefined()
    expect((await sharingAudits(document.id)).at(-1)).toEqual({ action: 'documents.share_revoked', actorId: amy.id, details: { userId: ben.id, role: 'editor' } })
    expect(await errorOf(await open(benSession, document.id))).toEqual(await errorOf(await open(benSession, randomUUID())))
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/content`)).status).toBe(404)
  })

  it('没有这条授权时取消：照样 204，什么都不写（不记审计）；同一份文档上别人的授权不动', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '没有的' })
    await shared(amySession, document.id, cat.id, 'viewer')
    expect((await unshare(amySession, document.id, ben.id)).status).toBe(204)
    expect((await unshare(amySession, document.id, randomUUID())).status).toBe(204)
    expect((await sharingAudits(document.id)).map(audit => audit.action)).toEqual(['documents.shared'])
    expect((await grantsOn(database, [document.id])).map(grant => grant.userId)).toEqual([cat.id])
  })

  it('空间管理员身上自己的那条授权也能取消（不特殊处理）；授权与空间角色互不覆盖，列表里如实显示', async () => {
    const spaceId = await teamSpace({ [cat.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '自己的那条' })
    await shared(catSession, document.id, amy.id, 'viewer')
    expect((await grantList(amySession, document.id)).map(grant => [grant.user.id, grant.role])).toEqual([[amy.id, 'viewer']])
    // 她仍是空间管理员（取较高者）
    expect(parseExact(documentDetailSchema, await (await open(amySession, document.id)).json()).permissions.canShare).toBe(true)
    expect((await unshare(amySession, document.id, amy.id)).status).toBe(204)
    expect((await sharingAudits(document.id)).at(-1)).toEqual({ action: 'documents.share_revoked', actorId: amy.id, details: { userId: amy.id, role: 'viewer' } })
  })

  it('授权列表：先按角色、再按显示名；停用的人照样列出（带状态）；每一项都有设置人的人名', async () => {
    const spaceId = await teamSpace({ [cat.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '列表' })
    const gone = await createPassiveAccount(database, { username: 'gone', displayName: '离职的', status: 'disabled' })
    await setGrant(database, { documentId: document.id, userId: gone.id, role: 'editor', grantedBy: amy.id })
    await shared(amySession, document.id, ben.id, 'viewer')
    await shared(catSession, document.id, root.id, 'editor')
    const items = await grantList(amySession, document.id)
    expect(items.map(item => [item.user.username, item.role, item.status, item.grantedBy.username])).toEqual([
      ['gone', 'editor', 'disabled', 'amy'],
      ['root', 'editor', 'active', 'cat'],
      ['ben', 'viewer', 'active', 'amy'],
    ])
  })
})

describe('US-M2-10 校验与错误（M2-P5 设计 §3.2、§3.6）', () => {
  it('不能给自己：400 REQUEST_INVALID（大写的路径 id 一样认得），什么也不写；看不到的文档先按不存在回答', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '给自己' })
    for (const id of [amy.id, amy.id.toUpperCase()])
      expect(await errorOf(await share(amySession, document.id, id, 'editor')), id).toEqual({ status: 400, code: 'REQUEST_INVALID', message: '不能把文档分享给自己' })
    expect(await grantsOn(database, [document.id])).toEqual([])
    // 本看不到这份文档：给自己也是 404，与不存在的文档相同
    expect(await errorOf(await share(benSession, document.id, ben.id, 'editor'))).toEqual(await errorOf(await share(benSession, randomUUID(), ben.id, 'editor')))
  })

  it('被授权人不存在或已停用：409 ACCOUNT_UNAVAILABLE，新建与调整都是；停用的人的授权能取消', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '停用的人' })
    const leaver = await createPassiveAccount(database, { username: 'leaver', status: 'disabled' })
    const unavailable = { status: 409, code: 'ACCOUNT_UNAVAILABLE', message: '这个账户不存在或已停用' }
    expect(await errorOf(await share(amySession, document.id, randomUUID(), 'viewer'))).toEqual(unavailable)
    expect(await errorOf(await share(amySession, document.id, leaver.id, 'viewer'))).toEqual(unavailable)
    await setGrant(database, { documentId: document.id, userId: leaver.id, role: 'viewer', grantedBy: amy.id })
    expect(await errorOf(await share(amySession, document.id, leaver.id, 'editor'))).toEqual(unavailable)
    expect(await storedGrant(document.id, leaver.id)).toMatchObject({ role: 'viewer' })
    expect((await unshare(amySession, document.id, leaver.id)).status).toBe(204)
    expect(await storedGrant(document.id, leaver.id)).toBeUndefined()
    expect((await sharingAudits(document.id)).map(audit => audit.action)).toEqual(['documents.share_revoked'])
  })

  it('请求不合法：400——角色不是查看者或编辑者、多出的字段、缺了角色、路径里的 id 不是 UUID', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '不合法' })
    for (const body of [{ role: 'admin' }, { role: 'owner' }, { role: 'viewer', note: '多出的' }, {}])
      expect((await share(amySession, document.id, ben.id, body)).status, JSON.stringify(body)).toBe(400)
    expect((await share(amySession, 'not-a-uuid', ben.id, 'viewer')).status).toBe(400)
    expect((await share(amySession, document.id, 'not-a-uuid', 'viewer')).status).toBe(400)
    expect((await unshare(amySession, document.id, 'not-a-uuid')).status).toBe(400)
    expect((await grantsOf(amySession, 'not-a-uuid')).status).toBe(400)
    expect(await grantsOn(database, [document.id])).toEqual([])
  })

  it('没有分享的权限：编辑者与查看者 403（只有空间管理员能分享）；只凭授权的人 403（他自己的说明，即使是编辑授权）；看不到的 404——查看、设置、取消都一样', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'editor', [cat.id]: 'viewer' })
    const document = await seedDocument(database, { spaceId, createdBy: ben.id, title: '不能分享' })
    const outsider = await createAccount(database, { username: 'share-outsider' })
    const outsiderSession = await login(app.baseUrl, outsider.username, outsider.password)
    const grantee = await createAccount(database, { username: 'share-grantee' })
    const granteeSession = await login(app.baseUrl, grantee.username, grantee.password)
    await setGrant(database, { documentId: document.id, userId: grantee.id, role: 'editor', grantedBy: amy.id })
    const operations = [
      async (user: LoggedIn) => grantsOf(user, document.id),
      async (user: LoggedIn) => share(user, document.id, outsider.id, 'viewer'),
      async (user: LoggedIn) => unshare(user, document.id, grantee.id),
    ]
    for (const [index, operation] of operations.entries()) {
      expect(await errorOf(await operation(benSession)), `编辑者 ${index}`).toEqual(NOT_ADMIN)
      expect(await errorOf(await operation(catSession)), `查看者 ${index}`).toEqual(NOT_ADMIN)
      expect(await errorOf(await operation(granteeSession)), `只凭授权 ${index}`).toEqual(GRANT_ONLY)
      expect((await operation(outsiderSession)).status, `外人 ${index}`).toBe(404)
    }
    expect((await grantsOn(database, [document.id])).map(grant => grant.userId)).toEqual([grantee.id])
    // 系统管理员没有内容权限：没有加入的团队空间里的文档对他不存在
    expect((await grantsOf(rootSession, document.id)).status).toBe(404)
  })

  it('个人空间的所有者能分享自己的文档；别人的个人空间里的文档对他不存在', async () => {
    const document = await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '个人的' })
    expect(await shared(amySession, document.id, ben.id, 'editor')).toMatchObject({ role: 'editor', grantedBy: { id: amy.id } })
    expect((await grantsOf(catSession, document.id)).status).toBe(404)
    // 被授权的本只凭授权：不能再分享
    expect(await errorOf(await share(benSession, document.id, cat.id, 'viewer'))).toEqual(GRANT_ONLY)
  })

  it('归档的空间里分享冻结：查看、设置、调整、取消都 403，空间管理员得到冻结的说明；已有的授权照常生效（编辑授权降为查看者）', async () => {
    const spaceId = await teamSpace({ [cat.id]: 'editor' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '归档的' })
    await shared(amySession, document.id, ben.id, 'editor')
    await setSpaceState(database, spaceId, { status: 'archived' })
    expect(await errorOf(await grantsOf(amySession, document.id))).toEqual(FROZEN)
    expect(await errorOf(await share(amySession, document.id, cat.id, 'viewer'))).toEqual(FROZEN)
    expect(await errorOf(await share(amySession, document.id, ben.id, 'viewer'))).toEqual(FROZEN)
    expect(await errorOf(await unshare(amySession, document.id, ben.id))).toEqual(FROZEN)
    // 空间里的编辑者恢复之后也不能分享：冻结的说明许诺了恢复之后能调整，不给他，照旧是"只有空间管理员能分享"
    // （M2-P5 审查 A 的一般 6、B 的 G1）；只凭授权的本仍是他自己的说明
    expect(await errorOf(await grantsOf(catSession, document.id))).toEqual(NOT_ADMIN)
    expect(await errorOf(await share(catSession, document.id, root.id, 'viewer'))).toEqual(NOT_ADMIN)
    expect(await errorOf(await grantsOf(benSession, document.id))).toEqual(GRANT_ONLY)
    expect(await storedGrant(document.id, ben.id)).toMatchObject({ role: 'editor' })
    expect(parseExact(documentDetailSchema, await (await open(benSession, document.id)).json())).toMatchObject({ accessVia: 'grant', permissions: { canEdit: false, canShare: false } })
    expect((await sharingAudits(document.id)).map(audit => audit.action)).toEqual(['documents.shared'])
    // 恢复之后照常
    await setSpaceState(database, spaceId, { status: 'active' })
    expect((await unshare(amySession, document.id, ben.id)).status).toBe(204)
  })

  it('回收站里的文档：查看、设置、取消都 404，与不存在的文档逐字相同；授权不动', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '删掉的' })
    await shared(amySession, document.id, ben.id, 'viewer')
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`, { method: 'DELETE' })).status).toBe(204)
    const missing = randomUUID()
    expect(await errorOf(await grantsOf(amySession, document.id))).toEqual(await errorOf(await grantsOf(amySession, missing)))
    expect(await errorOf(await share(amySession, document.id, cat.id, 'viewer'))).toEqual(await errorOf(await share(amySession, missing, cat.id, 'viewer')))
    expect(await errorOf(await unshare(amySession, document.id, ben.id))).toEqual(await errorOf(await unshare(amySession, missing, ben.id)))
    expect((await unshare(amySession, document.id, ben.id)).status).toBe(404)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: ben.id, role: 'viewer' }])
  })
})

describe('US-M2-10 经接口分享之后的有效权限（M2-P5 设计 §3.4(1)）', () => {
  it('取较高者：空间里的查看者另有编辑授权能保存，仍不能移动；只凭编辑授权的人能保存、改名，不能移动与删除，详情不带文件夹', async () => {
    const spaceId = await teamSpace({ [cat.id]: 'viewer' })
    const folder = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, name: '方案', requestId: randomUUID() } })
    const folderId = parseExact(createdFolderSchema, await folder.json()).id
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '一起改的', folderId })
    await shared(amySession, document.id, cat.id, 'editor')
    await shared(amySession, document.id, ben.id, 'editor')

    expect(parseExact(documentDetailSchema, await (await open(catSession, document.id)).json())).toMatchObject({ accessVia: 'space', folderId, permissions: { canEdit: true, canMoveWithinSpace: false, canShare: false } })
    expect((await save(catSession, document, 1)).status).toBe(200)
    expect((await asUser(app.baseUrl, catSession, `/api/documents/${document.id}`, { method: 'PATCH', body: { folderId: null } })).status).toBe(403)

    expect(parseExact(documentDetailSchema, await (await open(benSession, document.id)).json())).toMatchObject({ accessVia: 'grant', folderId: null, permissions: { canEdit: true, canRename: true, canDelete: false, canMoveWithinSpace: false } })
    expect((await save(benSession, document, 2)).status).toBe(200)
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`, { method: 'PATCH', body: { title: '改过的' } })).status).toBe(200)
    expect(await errorOf(await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`, { method: 'DELETE' }))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能删除' })
    expect(await errorOf(await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: ben.personalSpaceId } }))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能移动' })
  })
})

describe('US-M2-10 "与我共享"（M2-P5 设计 §3.4(4)）', () => {
  it('我有授权的全部文档（包括我在那个空间也有角色的）：团队空间带名称，个人空间带所有者、不带存的名称；内容权限取较高者；没有授权的与回收站里的不出现', async () => {
    const reader = await createAccount(database, { username: 'shared-reader', displayName: '读者' })
    const readerSession = await login(app.baseUrl, reader.username, reader.password)
    // 所有者的显示名后来改了：个人空间存的名称是建号时的那个，不该出现
    const owner = await createAccount(database, { username: 'shared-owner', displayName: '建号时的名字' })
    await database.query(async client => client.query('UPDATE users SET display_name = $2 WHERE id = $1', [owner.id, '现在的名字']))
    const spaceId = await teamSpace({ [reader.id]: 'viewer' }, '共享来源部')
    const inTeam = await seedDocument(database, { spaceId, createdBy: amy.id, title: '团队里的', updatedAt: 'now() - interval \'1 minute\'' })
    const inPersonal = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '个人空间里的', updatedAt: 'now() - interval \'2 minutes\'' })
    const notShared = await seedDocument(database, { spaceId, createdBy: amy.id, title: '没分享的' })
    const trashed = await seedDocument(database, { spaceId, createdBy: amy.id, title: '删掉的' })
    await shared(amySession, inTeam.id, reader.id, 'editor')
    await setGrant(database, { documentId: inPersonal.id, userId: reader.id, role: 'viewer', grantedBy: owner.id })
    await shared(amySession, trashed.id, reader.id, 'viewer')
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${trashed.id}`, { method: 'DELETE' })).status).toBe(204)

    const page = await sharedWithMe(readerSession)
    expect(page.nextCursor).toBeNull()
    expect(page.items.map(item => item.id)).toEqual([inTeam.id, inPersonal.id])
    expect(page.items.map(item => item.id)).not.toContain(notShared.id)
    expect(page.items[0]).toMatchObject({ title: '团队里的', space: { id: spaceId, type: 'team', name: '共享来源部' }, contentRole: 'editor' })
    expect(page.items[1]).toMatchObject({ title: '个人空间里的', space: { id: owner.personalSpaceId, type: 'personal', owner: { id: owner.id, username: 'shared-owner', displayName: '现在的名字' } }, contentRole: 'viewer' })
    expect(JSON.stringify(page)).not.toContain('建号时的名字')
    // 归档之后内容权限降为查看者；取消之后下一次请求即不出现
    await setSpaceState(database, spaceId, { status: 'archived' })
    expect((await sharedWithMe(readerSession)).items[0]).toMatchObject({ id: inTeam.id, contentRole: 'viewer' })
    await setSpaceState(database, spaceId, { status: 'active' })
    expect((await unshare(amySession, inTeam.id, reader.id)).status).toBe(204)
    expect((await sharedWithMe(readerSession)).items.map(item => item.id)).toEqual([inPersonal.id])
  })

  it('空间里的角色更高时内容权限是空间角色（空间管理员另有查看授权仍是 admin）；什么都没有时是空的一页', async () => {
    const holder = await createAccount(database, { username: 'shared-admin' })
    const holderSession = await login(app.baseUrl, holder.username, holder.password)
    expect(await sharedWithMe(holderSession)).toEqual({ items: [], nextCursor: null })
    const spaceId = await teamSpace({ [holder.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '我也管的' })
    await shared(amySession, document.id, holder.id, 'viewer')
    expect((await sharedWithMe(holderSession)).items).toEqual([expect.objectContaining({ id: document.id, contentRole: 'admin' })])
  })

  it('分页：每页 50 条，按更新时间从新到旧，按游标取完、不丢不重；游标不合法 400', async () => {
    const reader = await createAccount(database, { username: 'shared-pager' })
    const readerSession = await login(app.baseUrl, reader.username, reader.password)
    const spaceId = await teamSpace()
    const ids: string[] = []
    for (let index = 0; index <= SHARED_PAGE_SIZE; index += 1) {
      const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: `分页 ${index}`, updatedAt: `now() - interval '${index} seconds'` })
      await setGrant(database, { documentId: document.id, userId: reader.id, role: 'viewer', grantedBy: amy.id })
      ids.push(document.id)
    }
    const first = await sharedWithMe(readerSession)
    expect(first.items).toHaveLength(SHARED_PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()
    const second = await sharedWithMe(readerSession, first.nextCursor ?? '')
    expect(second.nextCursor).toBeNull()
    expect([...first.items, ...second.items].map(item => item.id)).toEqual(ids)
    const broken = await asUser(app.baseUrl, readerSession, '/api/shared?cursor=broken')
    expect(await errorOf(broken)).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    expect((await asUser(app.baseUrl, readerSession, '/api/shared?limit=10')).status).toBe(400)
  })
})

describe('US-M2-14 按空间列出与回收站不受授权影响，搜索受授权影响（M2-P5 设计 §3.4(2)）', () => {
  it('按空间列出与回收站：分享给我的文档不出现在我有角色的空间里；分享给我的文档进了回收站，我的回收站里没有它、它所在空间的回收站对我仍不存在', async () => {
    const reader = await createAccount(database, { username: 'list-reader' })
    const readerSession = await login(app.baseUrl, reader.username, reader.password)
    const mine = await teamSpace({ [reader.id]: 'viewer' })
    const elsewhere = await teamSpace()
    const inMine = await seedDocument(database, { spaceId: mine, createdBy: amy.id, title: '我空间里的' })
    const fromElsewhere = await seedDocument(database, { spaceId: elsewhere, createdBy: amy.id, title: '别处分享来的' })
    await shared(amySession, fromElsewhere.id, reader.id, 'editor')
    const listed = parseExact(documentListResponseSchema, await (await asUser(app.baseUrl, readerSession, `/api/documents?spaceId=${mine}&folderId=all`)).json())
    expect(listed.items.map(item => item.id)).toEqual([inMine.id])

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${fromElsewhere.id}`, { method: 'DELETE' })).status).toBe(204)
    for (const spaceId of [mine, reader.personalSpaceId]) {
      const trash = parseExact(trashListResponseSchema, await (await asUser(app.baseUrl, readerSession, `/api/trash?spaceId=${spaceId}`)).json())
      expect(trash.items).toEqual([])
    }
    expect((await asUser(app.baseUrl, readerSession, `/api/trash?spaceId=${elsewhere}`)).status).toBe(404)
    expect((await sharedWithMe(readerSession)).items).toEqual([])
  })

  it('搜索：凭授权命中的途径是 grant、不带文件夹与路径；个人空间带所有者；既有空间角色又有授权的照常带文件夹；看不到又没授权的不出现；取消之后搜不到', async () => {
    const reader = await createAccount(database, { username: 'search-reader', displayName: '搜索者' })
    const readerSession = await login(app.baseUrl, reader.username, reader.password)
    const owner = await createAccount(database, { username: 'search-owner', displayName: '所有者' })
    const visible = await teamSpace({ [reader.id]: 'viewer' }, '看得到的部门')
    const hidden = await teamSpace({}, '看不到的部门')
    const folderResponse = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId: hidden, name: '机密目录', requestId: randomUUID() } })
    const hiddenFolder = parseExact(createdFolderSchema, await folderResponse.json()).id
    const visibleFolderResponse = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId: visible, name: '公开目录', requestId: randomUUID() } })
    const visibleFolder = parseExact(createdFolderSchema, await visibleFolderResponse.json()).id
    const viaGrant = await seedDocument(database, { spaceId: hidden, createdBy: amy.id, title: '搜索授权 分享的', folderId: hiddenFolder, updatedAt: 'now() - interval \'1 minute\'' })
    const inPersonal = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '搜索授权 个人的', updatedAt: 'now() - interval \'2 minutes\'' })
    const both = await seedDocument(database, { spaceId: visible, createdBy: amy.id, title: '搜索授权 两样都有', folderId: visibleFolder, updatedAt: 'now() - interval \'3 minutes\'' })
    await seedDocument(database, { spaceId: hidden, createdBy: amy.id, title: '搜索授权 没分享的' })
    await shared(amySession, viaGrant.id, reader.id, 'viewer')
    await setGrant(database, { documentId: inPersonal.id, userId: reader.id, role: 'editor', grantedBy: owner.id })
    await shared(amySession, both.id, reader.id, 'editor')

    const page = await search(readerSession, '搜索授权')
    expect(page.items.map(item => item.id)).toEqual([viaGrant.id, inPersonal.id, both.id])
    expect(page.items[0]).toMatchObject({ accessVia: 'grant', folderId: null, folderPath: [], space: { id: hidden, type: 'team', name: '看不到的部门' } })
    expect(page.items[1]).toMatchObject({ accessVia: 'grant', folderId: null, folderPath: [], space: { id: owner.personalSpaceId, type: 'personal', owner: { id: owner.id, username: 'search-owner', displayName: '所有者' } } })
    expect(page.items[2]).toMatchObject({ accessVia: 'space', folderId: visibleFolder, folderPath: ['公开目录'], space: { id: visible, type: 'team' } })
    expect(JSON.stringify(page)).not.toContain('机密目录')

    expect((await unshare(amySession, viaGrant.id, reader.id)).status).toBe(204)
    expect((await search(readerSession, '搜索授权')).items.map(item => item.id)).toEqual([inPersonal.id, both.id])
  })
})

describe('US-M2-14 授权跟着文档走（M2-P5 设计 §3.3、§3.4(6)）', () => {
  it('跨空间移动：授权不动，被授权人照常打得开（在新的空间里）', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '要搬的' })
    await shared(amySession, document.id, ben.id, 'editor')
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: to } })).status).toBe(200)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: ben.id, role: 'editor' }])
    expect(parseExact(documentDetailSchema, await (await open(benSession, document.id)).json())).toMatchObject({ spaceId: to, accessVia: 'grant' })
  })

  it('移出空间：授权不动，他之后只凭授权看得到这份文档（途径变成 grant、不再带文件夹），看不到空间', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'viewer' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '移出之后' })
    await shared(amySession, document.id, ben.id, 'editor')
    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: ben.id, role: 'editor' }])
    expect(parseExact(documentDetailSchema, await (await open(benSession, document.id)).json())).toMatchObject({ accessVia: 'grant', permissions: { canEdit: true } })
    expect((await asUser(app.baseUrl, benSession, `/api/spaces/${spaceId}`)).status).toBe(404)
  })

  it('停用：他的授权保留（启用之后照常生效）；停用期间的授权照样能取消', async () => {
    const leaver = await createAccount(database, { username: 'grant-leaver' })
    const spaceId = await teamSpace()
    const kept = await seedDocument(database, { spaceId, createdBy: amy.id, title: '保留的' })
    const revoked = await seedDocument(database, { spaceId, createdBy: amy.id, title: '停用期间取消的' })
    await shared(amySession, kept.id, leaver.id, 'viewer')
    await shared(amySession, revoked.id, leaver.id, 'viewer')
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${leaver.id}/disable`, { method: 'POST' })).status).toBe(200)
    expect(await grantsOn(database, [kept.id, revoked.id])).toHaveLength(2)
    expect((await unshare(amySession, revoked.id, leaver.id)).status).toBe(204)
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${leaver.id}/enable`, { method: 'POST' })).status).toBe(200)
    const leaverSession = await login(app.baseUrl, leaver.username, leaver.password)
    expect((await open(leaverSession, kept.id)).status).toBe(200)
    expect((await open(leaverSession, revoked.id)).status).toBe(404)
  })

  it('停用者个人空间里分享出去的文档：停用之后被授权的人照常访问；系统管理员转移之后授权跟着文档走', async () => {
    const owner = await createAccount(database, { username: 'transfer-owner' })
    const ownerSession = await login(app.baseUrl, owner.username, owner.password)
    const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '要转移的' })
    await shared(ownerSession, document.id, ben.id, 'editor')
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${owner.id}/disable`, { method: 'POST' })).status).toBe(200)
    expect((await open(benSession, document.id)).status).toBe(200)
    const target = await teamSpace({ [root.id]: 'admin' })
    const transfer = await asUser(app.baseUrl, rootSession, `/api/admin/users/${owner.id}/documents/transfer`, { method: 'POST', body: { documentIds: [document.id], target: { type: 'team', spaceId: target } } })
    expect(transfer.status, await transfer.clone().text()).toBe(200)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: ben.id, role: 'editor' }])
    expect(parseExact(documentDetailSchema, await (await open(benSession, document.id)).json())).toMatchObject({ spaceId: target, accessVia: 'grant', permissions: { canEdit: true } })
    // 授权的设置人是已经停用的所有者：列表照样给出他的人名
    expect((await grantList(amySession, document.id)).map(grant => [grant.user.id, grant.grantedBy.username])).toEqual([[ben.id, 'transfer-owner']])
  })

  it('复制出来的副本不带原文档的授权（经接口分享之后复制）', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '复制源' })
    await shared(amySession, document.id, ben.id, 'viewer')
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId, requestId: randomUUID() } })
    expect(response.status).toBe(201)
    const copyId = parseExact(createdDocumentSchema, await response.json()).id
    expect(await grantsOn(database, [copyId])).toEqual([])
    expect((await open(benSession, copyId)).status).toBe(404)
  })
})

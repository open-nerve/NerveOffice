// 本人接管与强制接管（M3-P5 设计 §3.7、§3.8，US-M3-08、US-M3-09）：经真实的应用与数据库。申请带上接管方式（takeover）——
// 本人接管 self 只在当前有效的租约就在自己手里（同一个浏览器的别的标签页、别的设备）时起作用；强制接管 force 要能强制接管
// （空间管理员、个人空间的所有者），接管别人时在同一个事务里写审计 documents.edit_taken_over。接管时代次加一、整行改写成新的一代，
// 并记下接管标记（被接管那一代的令牌摘要与方式）：旧令牌之后的心跳、保存得到 taken_over（带 forced），页面据此不续上、给副本。
// 没人在编辑时两种方式都是普通的申请；同一个页面的重试沿用接管标记、不再写审计。
// 并发的交错（接管与保存、心跳，两个管理员同时接管，接管与降级）在 lease-takeover-locks.test.ts；权限的逐格预期在
// permissions/edit-lease-matrix.test.ts，看不到与不存在的语句序列在 permissions/hidden-missing-parity.test.ts。
import type { AcquiredEditLease, EditLeaseHeldDetails, EditLeaseLostDetails, EditStatus, UserSummary } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, createdDocumentSchema, EDIT_LEASE_HEADER, EDIT_LEASE_TTL_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema, editStatusSchema, errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, renewBody } from '../support/client-format.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { passLeaseTime, saveContent } from '../support/edit-leases.ts'
import { setGrant } from '../support/grants.ts'
import { requestIdOf } from '../support/request-id.ts'
import { asUser, login, SESSION_COOKIE } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（没有加入团队空间）；团队空间的两个空间管理员、两个编辑者、一个查看者；外人 */
let root: TestAccount
let amy: TestAccount
let ann: TestAccount
let ben: TestAccount
let cara: TestAccount
let vic: TestAccount
let outsider: TestAccount
let team: string
/** 归档的团队空间：艾米是空间管理员、本是编辑者（归档之后都至多是查看者） */
let archived: string
const sessions = new Map<string, LoggedIn>()

/** 建过的账户的"人"的结构（响应里的持有者按它核对） */
const people = new Map<string, UserSummary>()

async function account(username: string, options: { readonly displayName?: string, readonly systemRole?: 'admin' } = {}): Promise<TestAccount> {
  const created = await createAccount(database, { username, ...options })
  people.set(created.id, { id: created.id, username, displayName: options.displayName ?? username })
  return created
}

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await account('takeover-root', { systemRole: 'admin' })
  amy = await account('takeover-amy', { displayName: '艾米' })
  ann = await account('takeover-ann', { displayName: '安' })
  ben = await account('takeover-ben', { displayName: '本' })
  cara = await account('takeover-cara', { displayName: '卡拉' })
  vic = await account('takeover-vic', { displayName: '维克' })
  outsider = await account('takeover-outsider')
  team = await createTeamSpace(database, { name: '接管：团队', createdBy: root.id, members: { [amy.id]: 'admin', [ann.id]: 'admin', [ben.id]: 'editor', [cara.id]: 'editor', [vic.id]: 'viewer' } })
  archived = await createTeamSpace(database, { name: '接管：归档', createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' }, status: 'archived' })
  for (const each of [root, amy, ann, ben, cara, vic, outsider])
    sessions.set(each.id, await login(app.baseUrl, each.username, each.password))
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function sessionOf(holder: TestAccount): LoggedIn {
  const session = sessions.get(holder.id)
  if (session === undefined)
    throw new Error(`${holder.username} 没有登录`)
  return session
}

/** 同一个人在另一台设备上（另一次登录） */
async function anotherDevice(holder: TestAccount): Promise<LoggedIn> {
  return login(app.baseUrl, holder.username, holder.password)
}

function summaryOf(holder: TestAccount): UserSummary {
  const person = people.get(holder.id)
  if (person === undefined)
    throw new Error(`没有建过账户 ${holder.username}`)
  return person
}

/** 团队空间里的一份新文档（各个用例各用各的） */
async function freshDocument(spaceId: string = team): Promise<{ readonly id: string, readonly unitId: string }> {
  return seedDocument(database, { spaceId, createdBy: amy.id, title: '接管：文档' })
}

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

/** 申请的选项：标签页（默认每次一个新的）与接管方式（默认普通的申请） */
interface Claim {
  readonly tab?: string
  readonly takeover?: 'self' | 'force'
}

async function acquire(session: LoggedIn, documentId: string, claim: Claim = {}): Promise<Response> {
  const body = { ...acquireBody(claim.tab ?? randomUUID()), ...(claim.takeover === undefined ? {} : { takeover: claim.takeover }) }
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'POST', body })
}

async function acquired(session: LoggedIn, documentId: string, claim: Claim = {}): Promise<AcquiredEditLease> {
  const response = await acquire(session, documentId, claim)
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(acquiredEditLeaseSchema, await response.json())
}

async function renew(session: LoggedIn, documentId: string, token: string): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'PUT', body: renewBody(0), headers: { [EDIT_LEASE_HEADER]: token } })
}

async function release(session: LoggedIn, documentId: string, token: string): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: token } })
}

async function status(session: LoggedIn, documentId: string): Promise<EditStatus> {
  const response = await asUser(app.baseUrl, session, leasePath(documentId))
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(editStatusSchema, await response.json())
}

/** 以这份租约保存一次（基准修订号 1、模板快照）：令牌、代次与标签页都是申请时的 */
async function save(session: LoggedIn, document: { readonly id: string, readonly unitId: string }, lease: HeldLease): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, session, document.id, zlib.gzipSync(raw), { baseRevision: 1, lease })
}

async function errorOf(response: Response): Promise<{ readonly status: number, readonly code: string, readonly message: string, readonly details: Record<string, unknown> | undefined }> {
  const { error } = parseExact(errorResponseSchema, await response.json())
  return { status: response.status, code: error.code, message: error.message, details: error.details }
}

/** 编辑权已失效：409 EDIT_LEASE_LOST，返回详情（原因，被接管时另有 forced；按契约逐字核对，没有多出的字段） */
async function lostOf(response: Response): Promise<EditLeaseLostDetails> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_LOST'])
  return parseExact(editLeaseLostDetailsSchema, error.details)
}

async function heldBy(response: Response): Promise<EditLeaseHeldDetails> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_HELD'])
  return parseExact(editLeaseHeldDetailsSchema, error.details)
}

/** 租约行（持有者、绑定的登录与标签页、令牌摘要、代次、明确结束、请求编辑、接管标记） */
interface LeaseRow {
  readonly holder_id: string
  readonly session_id: string
  readonly client_instance_id: string
  readonly token_digest: Buffer
  readonly write_epoch: number
  readonly end_reason: string | null
  readonly request_id: string | null
  readonly requested_by: string | null
  readonly request_declined_at: Date | null
  readonly taken_over_token_digest: Buffer | null
  readonly takeover: string | null
}

async function leaseOf(documentId: string): Promise<LeaseRow | undefined> {
  return database.query(async client => (await client.query<LeaseRow>(
    `SELECT holder_id, session_id, client_instance_id, token_digest, write_epoch, end_reason, request_id, requested_by, request_declined_at,
       taken_over_token_digest, takeover FROM document_edit_leases WHERE document_id = $1`,
    [documentId],
  )).rows[0])
}

async function documentOf(documentId: string): Promise<{ readonly write_epoch: number, readonly revision: number }> {
  const row = await database.query(async client => (await client.query<{ write_epoch: number, revision: number }>('SELECT write_epoch, revision FROM documents WHERE id = $1', [documentId])).rows[0])
  if (row === undefined)
    throw new Error(`没有文档 ${documentId}`)
  return row
}

/** 这份文档上强制接管的审计（逐字核对的那几列），按写入的先后 */
async function takeoverAudits(documentId: string): Promise<Record<string, unknown>[]> {
  return database.query(async client => (await client.query<Record<string, unknown>>(
    `SELECT action, actor_type, actor_id, target_type, target_id, source, request_id, client_ip, details FROM audit_events
     WHERE action = 'documents.edit_taken_over' AND target_id = $1 ORDER BY occurred_at, id`,
    [documentId],
  )).rows)
}

/** 这条会话在库里的 id：库里只存令牌（Cookie 的值）的 SHA-256 摘要 */
async function sessionIdOf(session: LoggedIn): Promise<string> {
  const digest = createHash('sha256').update(session.cookie.slice(`${SESSION_COOKIE}=`.length), 'utf8').digest()
  const id = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM auth_sessions WHERE token_hash = $1', [digest])).rows[0]?.id)
  if (id === undefined)
    throw new Error('库里没有这条会话')
  return id
}

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** 申请到的一代作为页面手里的租约（保存用）：令牌、代次与申请时的标签页 */
function heldLease(lease: AcquiredEditLease, clientInstanceId: string): HeldLease {
  return { token: lease.token, writeEpoch: lease.writeEpoch, clientInstanceId }
}

/** 这份文档的租约行上记下 requester 的待回应的请求编辑（直接写库摆好，只核对这几列的沿用与清空；经接口的请求编辑见 lease-requests.test.ts） */
async function putRequest(documentId: string, requester: TestAccount): Promise<void> {
  await database.query(async client => client.query(
    `UPDATE document_edit_leases SET request_id = gen_random_uuid(), requested_by = $2, request_session_id = gen_random_uuid(),
       requested_at = now() - interval '1 minute', request_expires_at = now() + interval '9 minutes'
     WHERE document_id = $1`,
    [documentId, requester.id],
  ))
}

describe('US-M3-08 本人接管（设计 §3.7）', () => {
  it('US-M3-08 跨设备（另一次登录）的本人接管：201，代次加一、整行改写成这个页面的新一代，接管标记是旧令牌的摘要与 self；旧令牌的心跳、保存得到 taken_over（forced: false），释放什么也不做；不写审计、没有提醒；等着的请求编辑沿用（同一个持有者）', async () => {
    const document = await freshDocument()
    const deskTab = randomUUID()
    const desk = await acquired(sessionOf(amy), document.id, { tab: deskTab })
    await putRequest(document.id, ben)
    const pending = await leaseOf(document.id)
    const laptop = await anotherDevice(amy)
    const laptopTab = randomUUID()
    const taken = await acquired(laptop, document.id, { tab: laptopTab, takeover: 'self' })
    expect(taken).toMatchObject({ writeEpoch: desk.writeEpoch + 1, revision: 1, interruption: null })
    expect((await documentOf(document.id)).write_epoch).toBe(desk.writeEpoch + 1)
    const row = await leaseOf(document.id)
    expect(row).toMatchObject({ holder_id: amy.id, session_id: await sessionIdOf(laptop), client_instance_id: laptopTab, write_epoch: taken.writeEpoch, end_reason: null, takeover: 'self' })
    expect(row?.token_digest.equals(digestOf(taken.token))).toBe(true)
    expect(row?.taken_over_token_digest?.equals(digestOf(desk.token))).toBe(true)
    expect({ id: row?.request_id, by: row?.requested_by }).toEqual({ id: pending?.request_id, by: ben.id })

    // 旧页面（台式机）：心跳与保存都是 taken_over、不是本人强制的；释放不动新的一代
    expect(await lostOf(await renew(sessionOf(amy), document.id, desk.token))).toEqual({ reason: 'taken_over', forced: false })
    expect(await lostOf(await save(sessionOf(amy), document, heldLease(desk, deskTab)))).toEqual({ reason: 'taken_over', forced: false })
    expect((await documentOf(document.id)).revision).toBe(1)
    expect((await release(sessionOf(amy), document.id, desk.token)).status).toBe(204)
    expect(await leaseOf(document.id)).toEqual(row)
    // 新页面照常续租、保存
    expect((await renew(laptop, document.id, taken.token)).status).toBe(200)
    expect((await save(laptop, document, heldLease(taken, laptopTab))).status).toBe(200)
    expect(await takeoverAudits(document.id)).toEqual([])
  })

  it('US-M3-08 同一次登录、别的标签页（DEF-042 的孤儿：申请发出、页面没拿到令牌就离开了）：重开的页面申请得到被占用，sameUser、sameSession 都为真；以本人接管申请立即取得（编辑者也行，不要求能强制接管），孤儿那一代的令牌之后得到 taken_over', async () => {
    const document = await freshDocument()
    // 孤儿：这一代的令牌发给了一个已经不在的页面（测试留着它，只为最后核对）
    const orphan = await acquired(sessionOf(ben), document.id)
    const reopened = randomUUID()
    expect(await heldBy(await acquire(sessionOf(ben), document.id, { tab: reopened }))).toMatchObject({ holder: summaryOf(ben), sameUser: true, sameSession: true, canTakeOver: false })
    const taken = await acquired(sessionOf(ben), document.id, { tab: reopened, takeover: 'self' })
    expect(taken.writeEpoch).toBe(orphan.writeEpoch + 1)
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: ben.id, client_instance_id: reopened, takeover: 'self' })
    expect(await lostOf(await renew(sessionOf(ben), document.id, orphan.token))).toEqual({ reason: 'taken_over', forced: false })
    expect((await renew(sessionOf(ben), document.id, taken.token)).status).toBe(200)
  })

  it('US-M3-08 持有者是别人时本人接管不起作用：照常 EDIT_LEASE_HELD，详情与普通的申请相同；代次过时而持有者都还活着（R2）时同样；什么也不写', async () => {
    const document = await freshDocument()
    await acquired(sessionOf(ben), document.id)
    const before = { lease: await leaseOf(document.id), document: await documentOf(document.id) }
    const plain = await heldBy(await acquire(sessionOf(amy), document.id))
    expect(plain).toMatchObject({ holder: summaryOf(ben), sameUser: false, sameSession: false, canTakeOver: true })
    expect(await heldBy(await acquire(sessionOf(amy), document.id, { takeover: 'self' }))).toEqual(plain)
    expect({ lease: await leaseOf(document.id), document: await documentOf(document.id) }).toEqual(before)

    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [document.id]))
    const stale = await documentOf(document.id)
    expect(await heldBy(await acquire(sessionOf(cara), document.id, { takeover: 'self' }))).toMatchObject({ holder: summaryOf(ben), sameUser: false })
    expect({ lease: await leaseOf(document.id), document: await documentOf(document.id) }).toEqual({ lease: before.lease, document: stale })
  })

  it('US-M3-08 sameSession：同一个浏览器（同一次登录）的别的标签页为真、别的设备（另一次登录）为假——编辑状态与被占用的详情一致；两种都能本人接管', async () => {
    for (const sameBrowser of [true, false]) {
      const document = await freshDocument()
      const old = await acquired(sessionOf(ben), document.id)
      const other = sameBrowser ? sessionOf(ben) : await anotherDevice(ben)
      expect((await status(other, document.id)).editor, String(sameBrowser)).toMatchObject({ holder: summaryOf(ben), sameUser: true, sameSession: sameBrowser })
      expect(await heldBy(await acquire(other, document.id)), String(sameBrowser)).toMatchObject({ sameUser: true, sameSession: sameBrowser })
      await acquired(other, document.id, { takeover: 'self' })
      expect(await lostOf(await renew(sessionOf(ben), document.id, old.token)), String(sameBrowser)).toEqual({ reason: 'taken_over', forced: false })
    }
  })

  it('US-M3-08 同一个页面重试本人接管（回包丢了）：再发一代、代次再加一，接管标记沿用——被接管的那一代的令牌仍得到 taken_over；第一次接管拿到的令牌（回包丢了的那一份）得到 replaced', async () => {
    const document = await freshDocument()
    const old = await acquired(sessionOf(ben), document.id)
    const laptop = await anotherDevice(ben)
    const tab = randomUUID()
    const lost = await acquired(laptop, document.id, { tab, takeover: 'self' })
    const retried = await acquired(laptop, document.id, { tab, takeover: 'self' })
    expect(retried.writeEpoch).toBe(lost.writeEpoch + 1)
    const row = await leaseOf(document.id)
    expect(row).toMatchObject({ holder_id: ben.id, client_instance_id: tab, takeover: 'self' })
    expect(row?.taken_over_token_digest?.equals(digestOf(old.token))).toBe(true)
    expect(await lostOf(await renew(sessionOf(ben), document.id, old.token))).toEqual({ reason: 'taken_over', forced: false })
    expect(await lostOf(await renew(laptop, document.id, lost.token))).toEqual({ reason: 'replaced' })
    expect((await renew(laptop, document.id, retried.token)).status).toBe(200)
  })

  it('US-M3-08 自己的租约本来就无效（到期）时本人接管就是普通的申请：没有接管标记，提醒照常（关于自己，sameUser 为真）；旧令牌得到 replaced', async () => {
    const document = await freshDocument()
    const old = await acquired(sessionOf(ben), document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const endedAt = (await database.query(async client => (await client.query<{ renewed_at: Date }>('SELECT renewed_at FROM document_edit_leases WHERE document_id = $1', [document.id])).rows[0]))?.renewed_at.toISOString()
    const fresh = await acquired(await anotherDevice(ben), document.id, { takeover: 'self' })
    expect(fresh.interruption).toEqual({ holder: summaryOf(ben), endedAt, sameUser: true })
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: ben.id, takeover: null, taken_over_token_digest: null })
    expect(await lostOf(await renew(sessionOf(ben), document.id, old.token))).toEqual({ reason: 'replaced' })
  })
})

describe('US-M3-09 强制接管（设计 §3.8）', () => {
  it('US-M3-09 团队空间的空间管理员强制接管编辑者：201，代次加一、接管标记 forced；同一个事务里一条审计（操作者、文档、被接管的人、来源），逐字核对；等着的请求编辑清掉；被接管者的心跳、保存得到 taken_over（forced: true），释放什么也不做，之后另存为副本成功；编辑状态里正在编辑的是管理员', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    const bens = await acquired(sessionOf(ben), document.id, { tab })
    await putRequest(document.id, cara)
    const response = await acquire(sessionOf(amy), document.id, { takeover: 'force' })
    expect(response.status, await response.clone().text()).toBe(201)
    const taken = parseExact(acquiredEditLeaseSchema, await response.json())
    expect(taken).toMatchObject({ writeEpoch: bens.writeEpoch + 1, revision: 1, interruption: null })
    expect((await documentOf(document.id)).write_epoch).toBe(bens.writeEpoch + 1)
    const row = await leaseOf(document.id)
    expect(row).toMatchObject({ holder_id: amy.id, end_reason: null, takeover: 'forced', request_id: null, requested_by: null })
    expect(row?.taken_over_token_digest?.equals(digestOf(bens.token))).toBe(true)
    expect(await takeoverAudits(document.id)).toEqual([{
      action: 'documents.edit_taken_over',
      actor_type: 'user',
      actor_id: amy.id,
      target_type: 'document',
      target_id: document.id,
      source: 'http',
      request_id: requestIdOf(response),
      client_ip: '127.0.0.1',
      details: { holderId: ben.id },
    }])

    // 被接管者：心跳与保存都是 taken_over，是被强制接管的；释放不动管理员的一代；没保存的修改另存为副本
    expect(await lostOf(await renew(sessionOf(ben), document.id, bens.token))).toEqual({ reason: 'taken_over', forced: true })
    expect(await lostOf(await save(sessionOf(ben), document, heldLease(bens, tab)))).toEqual({ reason: 'taken_over', forced: true })
    expect((await documentOf(document.id)).revision).toBe(1)
    expect((await release(sessionOf(ben), document.id, bens.token)).status).toBe(204)
    expect(await leaseOf(document.id)).toEqual(row)
    const copied = await postConflictCopy(app.baseUrl, sessionOf(ben), document.id, document.unitId)
    expect(copied.status, await copied.clone().text()).toBe(201)
    expect(parseExact(createdDocumentSchema, await copied.json()).id).not.toBe(document.id)
    expect((await status(sessionOf(vic), document.id)).editor).toMatchObject({ holder: summaryOf(amy), sameUser: false })
    expect((await renew(sessionOf(amy), document.id, taken.token)).status).toBe(200)
  })

  it('US-M3-09 个人空间的所有者强制接管被授权的编辑者：201，审计里被接管的是他；被授权的编辑者不能反过来强制接管所有者（403，他自己的说明）', async () => {
    const document = await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '接管：个人空间' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'editor', grantedBy: amy.id })
    const bens = await acquired(sessionOf(ben), document.id)
    const response = await acquire(sessionOf(amy), document.id, { takeover: 'force' })
    expect(response.status, await response.clone().text()).toBe(201)
    expect(await takeoverAudits(document.id)).toMatchObject([{ actor_id: amy.id, request_id: requestIdOf(response), details: { holderId: ben.id } }])
    expect(await lostOf(await renew(sessionOf(ben), document.id, bens.token))).toEqual({ reason: 'taken_over', forced: true })
    expect(await errorOf(await acquire(sessionOf(ben), document.id, { takeover: 'force' }))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能强制接管编辑' })
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: amy.id, takeover: 'forced' })
    expect(await takeoverAudits(document.id)).toHaveLength(1)
  })

  it('US-M3-09 不能强制接管的人：编辑者 403（只有空间管理员能…）、查看者 403（只能查看）、归档的空间里的空间管理员 403（空间已归档），外人与没加入的系统管理员 404（与不存在的文档相同）——都在租约之前：持有者的租约不动、代次不加、不写审计', async () => {
    const document = await freshDocument()
    const bens = await acquired(sessionOf(ben), document.id)
    const before = { lease: await leaseOf(document.id), document: await documentOf(document.id) }
    expect(await errorOf(await acquire(sessionOf(cara), document.id, { takeover: 'force' }))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED', message: '只有空间管理员能强制接管这份文档的编辑' })
    expect(await errorOf(await acquire(sessionOf(vic), document.id, { takeover: 'force' }))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
    for (const someone of [outsider, root]) {
      const hidden = await errorOf(await acquire(sessionOf(someone), document.id, { takeover: 'force' }))
      expect(hidden, someone.username).toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await errorOf(await acquire(sessionOf(someone), randomUUID(), { takeover: 'force' })), someone.username).toEqual(hidden)
    }
    expect({ lease: await leaseOf(document.id), document: await documentOf(document.id) }).toEqual(before)
    expect(await takeoverAudits(document.id)).toEqual([])
    expect((await renew(sessionOf(ben), document.id, bens.token)).status).toBe(200)

    const frozen = await freshDocument(archived)
    expect(await errorOf(await acquire(sessionOf(amy), frozen.id, { takeover: 'force' }))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(await leaseOf(frozen.id)).toBeUndefined()
  })

  it('US-M3-09 没人在编辑时强制接管就是普通的申请：201，没有接管标记、不写审计；上一个租约异常结束的提醒照常，那一代的令牌得到 replaced', async () => {
    const fresh = await freshDocument()
    expect((await acquired(sessionOf(amy), fresh.id, { takeover: 'force' })).interruption).toBeNull()
    expect(await leaseOf(fresh.id)).toMatchObject({ holder_id: amy.id, takeover: null, taken_over_token_digest: null })
    expect(await takeoverAudits(fresh.id)).toEqual([])

    const expired = await freshDocument()
    const bens = await acquired(sessionOf(ben), expired.id)
    await passLeaseTime(database, expired.id, EDIT_LEASE_TTL_SECONDS)
    const endedAt = (await database.query(async client => (await client.query<{ renewed_at: Date }>('SELECT renewed_at FROM document_edit_leases WHERE document_id = $1', [expired.id])).rows[0]))?.renewed_at.toISOString()
    expect((await acquired(sessionOf(amy), expired.id, { takeover: 'force' })).interruption).toEqual({ holder: summaryOf(ben), endedAt, sameUser: false })
    expect(await leaseOf(expired.id)).toMatchObject({ holder_id: amy.id, takeover: null, taken_over_token_digest: null })
    expect(await takeoverAudits(expired.id)).toEqual([])
    expect(await lostOf(await renew(sessionOf(ben), expired.id, bens.token))).toEqual({ reason: 'replaced' })
  })

  it('US-M3-09 空间管理员强制接管自己的租约（同一个浏览器的别的标签页、别的设备）就是本人接管：接管标记 self，不写审计', async () => {
    for (const sameBrowser of [true, false]) {
      const document = await freshDocument()
      const old = await acquired(sessionOf(amy), document.id)
      await acquired(sameBrowser ? sessionOf(amy) : await anotherDevice(amy), document.id, { takeover: 'force' })
      const row = await leaseOf(document.id)
      expect(row, String(sameBrowser)).toMatchObject({ holder_id: amy.id, takeover: 'self' })
      expect(row?.taken_over_token_digest?.equals(digestOf(old.token)), String(sameBrowser)).toBe(true)
      expect(await lostOf(await renew(sessionOf(amy), document.id, old.token)), String(sameBrowser)).toEqual({ reason: 'taken_over', forced: false })
      expect(await takeoverAudits(document.id), String(sameBrowser)).toEqual([])
    }
  })

  it('US-M3-09 同一个页面重试强制接管（回包丢了）：再发一代、代次再加一，接管标记沿用（forced，还是被接管者那一代的），不再写审计；被接管者的令牌仍得到 taken_over（forced: true）', async () => {
    const document = await freshDocument()
    const bens = await acquired(sessionOf(ben), document.id)
    const tab = randomUUID()
    const first = await acquired(sessionOf(amy), document.id, { tab, takeover: 'force' })
    const retried = await acquired(sessionOf(amy), document.id, { tab, takeover: 'force' })
    expect(retried.writeEpoch).toBe(first.writeEpoch + 1)
    const row = await leaseOf(document.id)
    expect(row).toMatchObject({ holder_id: amy.id, client_instance_id: tab, takeover: 'forced' })
    expect(row?.taken_over_token_digest?.equals(digestOf(bens.token))).toBe(true)
    expect(await takeoverAudits(document.id)).toMatchObject([{ actor_id: amy.id, details: { holderId: ben.id } }])
    expect(await lostOf(await renew(sessionOf(ben), document.id, bens.token))).toEqual({ reason: 'taken_over', forced: true })
    expect(await lostOf(await renew(sessionOf(amy), document.id, first.token))).toEqual({ reason: 'replaced' })
  })

  it('US-M3-09 代次过时而持有者按时间、登录、编辑权都还活着（R2：别人申请是被占用）时，强制接管照样接管、写审计；持有者的令牌得到 taken_over（forced: true）', async () => {
    const document = await freshDocument()
    const bens = await acquired(sessionOf(ben), document.id)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [document.id]))
    expect(await heldBy(await acquire(sessionOf(amy), document.id))).toMatchObject({ holder: summaryOf(ben), canTakeOver: true })
    const taken = await acquired(sessionOf(amy), document.id, { takeover: 'force' })
    expect(taken.writeEpoch).toBe(bens.writeEpoch + 2)
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: amy.id, takeover: 'forced' })
    expect(await takeoverAudits(document.id)).toMatchObject([{ actor_id: amy.id, details: { holderId: ben.id } }])
    expect(await lostOf(await renew(sessionOf(ben), document.id, bens.token))).toEqual({ reason: 'taken_over', forced: true })
  })
})

describe('M3-P5 被占用的详情、编辑状态与接管的判断一致（设计 §3.3、§3.7、§3.8）', () => {
  it('canTakeOver 为真的人强制接管成功、为假的人 403；sameUser 为真的人本人接管成功、为假的人被占用——同一份文档上按人逐个核对', async () => {
    for (const [who, canTakeOver] of [[amy, true], [ann, true], [cara, false], [vic, false]] as const) {
      const document = await freshDocument()
      await acquired(sessionOf(ben), document.id)
      expect((await status(sessionOf(who), document.id)).canTakeOver, who.username).toBe(canTakeOver)
      const forced = await acquire(sessionOf(who), document.id, { takeover: 'force' })
      expect(forced.status, who.username).toBe(canTakeOver ? 201 : 403)
      await forced.arrayBuffer()
    }
    for (const [who, sameUser] of [[ben, true], [cara, false]] as const) {
      const document = await freshDocument()
      await acquired(sessionOf(ben), document.id)
      expect((await heldBy(await acquire(sessionOf(who), document.id))).sameUser, who.username).toBe(sameUser)
      const self = await acquire(sessionOf(who), document.id, { takeover: 'self' })
      expect(self.status, who.username).toBe(sameUser ? 201 : 409)
      await self.arrayBuffer()
    }
  })
})

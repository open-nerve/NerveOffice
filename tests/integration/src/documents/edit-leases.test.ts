// 编辑租约的接口（M3-P1 设计 §3.2、§3.4.2、§3.4.3）：申请、心跳续租、释放与编辑状态，经真实的应用与数据库。
// 与时间有关的规则（到期、空闲、30 分钟的提醒）改写租约行的时间来模拟，不等真实的时间；"恰好"的边界在单元测试里按同一个 now 核对
// （apps/api 的 edit-lease-rules.test.ts），这里的事务各有各的 now()，边界附近只能留出余量。
// 并发的申请用 support/held-lock.ts 构造确定的交错：测试持住文档行，两个申请依次停在这把锁上，放开之后先到的拿到，后到的被占用。
import type { AcquiredEditLease, EditLeaseHeldDetails, EditStatus, UserSummary } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, createdDocumentSchema, documentDetailSchema, EDIT_LEASE_HEADER, EDIT_LEASE_TTL_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema, editStatusSchema, errorResponseSchema, renewedEditLeaseSchema, sessionResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, renewBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { idleLeaseFor, passIdleTime, passLeaseTime, saveContent } from '../support/edit-leases.ts'
import { setGrant } from '../support/grants.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, cookieValue, login, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'
import { createTeamSpace, setMember, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（签发重置链接）；团队空间的空间管理员、编辑者、查看者；外人 */
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let vic: TestAccount
let outsider: TestAccount
let team: string
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
  // debug 级：申请、被占用、心跳失效的日志是 debug 的（P1 设计 §3.5）
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_LOG_LEVEL: 'debug' } })
  root = await account('lease-root', { systemRole: 'admin' })
  amy = await account('lease-amy', { displayName: '艾米' })
  ben = await account('lease-ben', { displayName: '本' })
  vic = await account('lease-vic', { displayName: '维克' })
  outsider = await account('lease-outsider')
  team = await createTeamSpace(database, { name: '租约：团队', createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor', [vic.id]: 'viewer' } })
  for (const account of [root, amy, ben, vic, outsider])
    sessions.set(account.id, await login(app.baseUrl, account.username, account.password))
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function sessionOf(account: TestAccount): LoggedIn {
  const session = sessions.get(account.id)
  if (session === undefined)
    throw new Error(`${account.username} 没有登录`)
  return session
}

/** 把一份文档单独授权给这个人当编辑者（M2-P5），分享的人是艾米 */
async function grantEditor(documentId: string, userId: string): Promise<void> {
  await setGrant(database, { documentId, userId, role: 'editor', grantedBy: amy.id })
}

/** 团队空间里的一份新文档（各个用例各用各的，租约互不影响） */
async function freshDocument(): Promise<{ readonly id: string, readonly unitId: string }> {
  return seedDocument(database, { spaceId: team, createdBy: amy.id, title: '租约：文档' })
}

/** 另一个团队编辑者：会退出、被撤销登录、改密码、被降级的用例各用各的人，不影响别的用例 */
async function freshEditor(username: string): Promise<{ readonly account: TestAccount, readonly session: LoggedIn }> {
  const editor = await account(username)
  await setMember(database, team, editor.id, 'editor')
  return { account: editor, session: await login(app.baseUrl, editor.username, editor.password) }
}

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

async function acquire(session: LoggedIn, documentId: string, clientInstanceId: string = randomUUID()): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'POST', body: acquireBody(clientInstanceId) })
}

async function acquired(session: LoggedIn, documentId: string, clientInstanceId?: string): Promise<AcquiredEditLease> {
  const response = await acquire(session, documentId, clientInstanceId)
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(acquiredEditLeaseSchema, await response.json())
}

/** 令牌放在请求头里；token 为 undefined 时不带这个请求头 */
function leaseHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { [EDIT_LEASE_HEADER]: token }
}

async function renew(session: LoggedIn, documentId: string, token: string | undefined, idleSeconds = 0): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'PUT', body: renewBody(idleSeconds), headers: leaseHeaders(token) })
}

async function release(session: LoggedIn, documentId: string, token: string | undefined): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'DELETE', headers: leaseHeaders(token) })
}

async function status(session: LoggedIn, documentId: string): Promise<EditStatus> {
  const response = await asUser(app.baseUrl, session, leasePath(documentId))
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(editStatusSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ readonly status: number, readonly code: string, readonly details: Record<string, unknown> | undefined }> {
  const { error } = parseExact(errorResponseSchema, await response.json())
  return { status: response.status, code: error.code, details: error.details }
}

/** 心跳（或别的要租约的操作）被拒：409 EDIT_LEASE_LOST，返回原因 */
async function lostReason(response: Response): Promise<string | undefined> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_LOST'])
  return parseExact(editLeaseLostDetailsSchema, error.details).reason
}

/** 申请被占用：409 EDIT_LEASE_HELD，返回详情 */
async function heldBy(response: Response): Promise<EditLeaseHeldDetails> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_HELD'])
  return parseExact(editLeaseHeldDetailsSchema, error.details)
}

/** "人"的结构（响应里的持有者） */
function summaryOf(holder: TestAccount): UserSummary {
  const person = people.get(holder.id)
  if (person === undefined)
    throw new Error(`没有建过账户 ${holder.username}`)
  return person
}

interface LeaseRow {
  readonly holder_id: string
  readonly session_id: string
  readonly client_instance_id: string
  readonly token_digest: Buffer
  readonly write_epoch: number
  readonly acquired_at: Date
  readonly renewed_at: Date
  readonly expires_at: Date
  readonly last_active_at: Date
  readonly ended_at: Date | null
  readonly end_reason: string | null
}

async function leaseOf(documentId: string): Promise<LeaseRow | undefined> {
  return database.query(async client => (await client.query<LeaseRow>('SELECT * FROM document_edit_leases WHERE document_id = $1', [documentId])).rows[0])
}

async function documentOf(documentId: string): Promise<{ readonly write_epoch: number, readonly updated_at: Date, readonly revision: number }> {
  const row = await database.query(async client => (await client.query<{ write_epoch: number, updated_at: Date, revision: number }>(
    'SELECT write_epoch, updated_at, revision FROM documents WHERE id = $1',
    [documentId],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有文档 ${documentId}`)
  return row
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

describe('申请、心跳、释放与编辑状态（P1 设计 §3.4.2、§3.4.3）', () => {
  it('US-M3-04 申请：201，令牌、新的一代、锁下的修订号、到期时间；库里只存令牌的摘要，绑定这次登录与这个标签页；文档的代次加一、更新时间不变；响应不缓存', async () => {
    const document = await freshDocument()
    // 先保存一次（在另一个标签页里申请、保存、释放），修订号是 2：申请给出的是文档当前的修订号；上一个租约是释放的，不提醒
    const saved = await saveContent(app.baseUrl, sessionOf(amy), document.id, zlib.gzipSync(Buffer.from(sheetSnapshotFor(document.unitId), 'utf8')), { baseRevision: 1 })
    expect(saved.status, await saved.clone().text()).toBe(200)
    const before = await documentOf(document.id)
    const tab = randomUUID()
    const response = await acquire(sessionOf(amy), document.id, tab.toUpperCase())
    expect(response.status, await response.clone().text()).toBe(201)
    // 令牌在响应里：不缓存（安全响应头给所有响应下发 no-store）
    expect(response.headers.get('cache-control')).toBe('no-store')
    const lease = parseExact(acquiredEditLeaseSchema, await response.json())
    expect(lease).toMatchObject({ writeEpoch: before.write_epoch + 1, revision: 2, interruption: null })

    const row = await leaseOf(document.id)
    // 标签页统一成小写；令牌只存摘要
    expect(row).toMatchObject({ holder_id: amy.id, session_id: await sessionIdOf(sessionOf(amy)), client_instance_id: tab, write_epoch: lease.writeEpoch, ended_at: null, end_reason: null })
    expect(row?.token_digest.equals(digestOf(lease.token))).toBe(true)
    // 到期是申请的时刻加 90 秒；申请、续租、最后活动是同一个 now()
    expect(row?.expires_at.toISOString()).toBe(lease.expiresAt)
    expect((row?.expires_at.getTime() ?? 0) - (row?.renewed_at.getTime() ?? 0)).toBe(EDIT_LEASE_TTL_SECONDS * 1000)
    expect([row?.acquired_at, row?.last_active_at]).toEqual([row?.renewed_at, row?.renewed_at])

    const after = await documentOf(document.id)
    expect(after.write_epoch).toBe(before.write_epoch + 1)
    // 申请编辑权不算修改文档：列表的排序不变
    expect(after.updated_at).toEqual(before.updated_at)
  })

  it('US-M3-11 申请的响应带文档当前修订的来源：新建的为 null；保存之后是那次保存的标签页与本地序号（续上时页面据此认出期间的一版是不是自己的，00 号计划书 §7.5）；复制出来的为 null', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    const first = await acquired(sessionOf(amy), document.id, tab)
    expect(first).toMatchObject({ revision: 1, source: null })
    const raw = zlib.gzipSync(Buffer.from(sheetSnapshotFor(document.unitId), 'utf8'))
    const saved = await saveContent(app.baseUrl, sessionOf(amy), document.id, raw, { baseRevision: 1, localSeq: 5, lease: { token: first.token, writeEpoch: first.writeEpoch, clientInstanceId: tab } })
    expect(saved.status, await saved.clone().text()).toBe(200)
    // 同一个页面重新申请（续上）：修订号前进了一版，来源就是本页那次保存——与修订号冲突的详情同一个取法
    expect(await acquired(sessionOf(amy), document.id, tab)).toMatchObject({ revision: 2, source: { clientInstanceId: tab, localSeq: 5 } })

    const copied = await asUser(app.baseUrl, sessionOf(amy), `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId: team, requestId: randomUUID() } })
    expect(copied.status, await copied.clone().text()).toBe(201)
    const copy = parseExact(createdDocumentSchema, await copied.json())
    expect(await acquired(sessionOf(amy), copy.id)).toMatchObject({ revision: 1, source: null })
  })

  it('US-M3-11 当前修订的来源只给保存它的人本人（M3-P1 复验 C4）：别人申请、别人基于旧修订号保存得到的冲突详情里都是 null；本人在另一个标签页照样得到（页面再按标签页比较）', async () => {
    const document = await freshDocument()
    const raw = zlib.gzipSync(Buffer.from(sheetSnapshotFor(document.unitId), 'utf8'))
    const amyTab = randomUUID()
    const amys = await acquired(sessionOf(amy), document.id, amyTab)
    const saved = await saveContent(app.baseUrl, sessionOf(amy), document.id, raw, { baseRevision: 1, localSeq: 5, lease: { token: amys.token, writeEpoch: amys.writeEpoch, clientInstanceId: amyTab } })
    expect(saved.status, await saved.clone().text()).toBe(200)
    expect((await release(sessionOf(amy), document.id, amys.token)).status).toBe(204)

    // 别人：申请的响应与冲突的详情都不给来源
    const benTab = randomUUID()
    const bens = await acquired(sessionOf(ben), document.id, benTab)
    expect(bens).toMatchObject({ revision: 2, source: null })
    const conflict = await saveContent(app.baseUrl, sessionOf(ben), document.id, raw, { baseRevision: 1, lease: { token: bens.token, writeEpoch: bens.writeEpoch, clientInstanceId: benTab } })
    expect(await errorOf(conflict)).toMatchObject({ status: 409, code: 'DOCUMENT_REVISION_CONFLICT', details: { currentRevision: 2, source: null } })
    expect((await release(sessionOf(ben), document.id, bens.token)).status).toBe(204)

    // 本人在另一个标签页：照样给出，冲突的详情也一样
    const otherTab = randomUUID()
    const again = await acquired(sessionOf(amy), document.id, otherTab)
    expect(again).toMatchObject({ revision: 2, source: { clientInstanceId: amyTab, localSeq: 5 } })
    const own = await saveContent(app.baseUrl, sessionOf(amy), document.id, raw, { baseRevision: 1, lease: { token: again.token, writeEpoch: again.writeEpoch, clientInstanceId: otherTab } })
    expect(await errorOf(own)).toMatchObject({ status: 409, code: 'DOCUMENT_REVISION_CONFLICT', details: { currentRevision: 2, source: { clientInstanceId: amyTab, localSeq: 5 } } })
  })

  it('US-M3-04 编辑状态：能读就能看；有效的租约给出持有者（"人"的结构）、最后活动时间、是不是调用者自己与是不是调用者这次登录（M3-P5）；没有时为 null', async () => {
    const document = await freshDocument()
    // M3-P5：没人在请求编辑、没有交出之后的保留、没有异常中断的提醒（请求与保留见 lease-requests.test.ts）
    const notYet = { request: null, reservation: null, interruption: null }
    expect(await status(sessionOf(vic), document.id)).toEqual({ revision: 1, editor: null, canEdit: false, canTakeOver: false, formulasPending: false, ...notYet })
    await acquired(sessionOf(amy), document.id)
    const row = await leaseOf(document.id)
    const editor = { holder: summaryOf(amy), lastActiveAt: row?.last_active_at.toISOString() }
    // 艾米是团队空间的空间管理员（能强制接管），本是编辑者，维克是查看者
    expect(await status(sessionOf(ben), document.id)).toEqual({ revision: 1, editor: { ...editor, sameUser: false, sameSession: false }, canEdit: true, canTakeOver: false, formulasPending: false, ...notYet })
    expect(await status(sessionOf(vic), document.id)).toEqual({ revision: 1, editor: { ...editor, sameUser: false, sameSession: false }, canEdit: false, canTakeOver: false, formulasPending: false, ...notYet })
    expect(await status(sessionOf(amy), document.id)).toEqual({ revision: 1, editor: { ...editor, sameUser: true, sameSession: true }, canEdit: true, canTakeOver: true, formulasPending: false, ...notYet })
    // 同一个人在另一个设备上（另一条登录）：是本人，不是这次登录
    const otherDevice = await login(app.baseUrl, amy.username, amy.password)
    expect((await status(otherDevice, document.id)).editor).toEqual({ ...editor, sameUser: true, sameSession: false })
  })

  it('US-M3-05 编辑状态带上调用者现在能不能编辑（M3-P2 设计 §3.2）：与详情的 permissions.canEdit 一致；阅读期间被降级、空间被归档、被升为编辑者，下一次读就跟着变', async () => {
    const { account: hal, session } = await freshEditor('lease-hal')
    const document = await freshDocument()
    /** 编辑状态的 canEdit 与同一个人打开详情得到的 permissions.canEdit */
    async function canEditBoth(): Promise<[boolean, boolean]> {
      const detail = await asUser(app.baseUrl, session, `/api/documents/${document.id}`)
      expect(detail.status).toBe(200)
      return [(await status(session, document.id)).canEdit, parseExact(documentDetailSchema, await detail.json()).permissions.canEdit]
    }
    expect(await canEditBoth()).toEqual([true, true])
    await setMember(database, team, hal.id, 'viewer')
    expect(await canEditBoth()).toEqual([false, false])
    await setMember(database, team, hal.id, 'editor')
    expect(await canEditBoth()).toEqual([true, true])
    await setSpaceState(database, team, { status: 'archived' })
    try {
      expect(await canEditBoth()).toEqual([false, false])
    }
    finally {
      await setSpaceState(database, team, { status: 'active' })
    }
    expect(await canEditBoth()).toEqual([true, true])
  })

  it('US-M3-07 心跳：续租的时间是数据库的 now，到期往后推 90 秒；最后活动是 now 减上报的空闲秒数，只前进不后退（M3-P5 设计 §3.5）、不晚于 now', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    // 申请在 10 分钟之前、最后一次操作在 5 分钟之前（续租与到期不动）
    await database.query(async client => client.query('UPDATE document_edit_leases SET acquired_at = acquired_at - interval \'10 minutes\', last_active_at = last_active_at - interval \'5 minutes\' WHERE document_id = $1', [document.id]))
    const response = await renew(sessionOf(amy), document.id, lease.token, 30)
    expect(response.status, await response.clone().text()).toBe(200)
    const renewed = parseExact(renewedEditLeaseSchema, await response.json())
    const row = await leaseOf(document.id)
    expect(row?.expires_at.toISOString()).toBe(renewed.expiresAt)
    expect((row?.expires_at.getTime() ?? 0) - (row?.renewed_at.getTime() ?? 0)).toBe(EDIT_LEASE_TTL_SECONDS * 1000)
    expect((row?.renewed_at.getTime() ?? 0) - (row?.last_active_at.getTime() ?? 0)).toBe(30_000)
    // 上报 5 分钟、一天：都比这一行现在的最后活动（30 秒之前）早——只前进不后退，原样不动（原来夹在申请的时间上，会退回 10 分钟之前）
    for (const idleSeconds of [300, 86_400]) {
      expect((await renew(sessionOf(amy), document.id, lease.token, idleSeconds)).status, String(idleSeconds)).toBe(200)
      expect((await leaseOf(document.id))?.last_active_at, String(idleSeconds)).toEqual(row?.last_active_at)
    }
    // 上报 0：就是续租的时刻
    expect((await renew(sessionOf(amy), document.id, lease.token, 0)).status).toBe(200)
    const active = await leaseOf(document.id)
    expect(active?.last_active_at).toEqual(active?.renewed_at)
  })

  it('释放：令牌是当前这一行的才记 released，之后心跳 409 released、没人在编辑；再释放、令牌不对、没带令牌都 204，什么也不改', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    expect((await release(sessionOf(amy), document.id, undefined)).status).toBe(204)
    expect((await release(sessionOf(amy), document.id, `${'z'.repeat(41)}-_`)).status).toBe(204)
    expect(await leaseOf(document.id)).toMatchObject({ ended_at: null, end_reason: null })
    expect((await release(sessionOf(amy), document.id, lease.token)).status).toBe(204)
    const ended = await leaseOf(document.id)
    expect(ended).toMatchObject({ end_reason: 'released' })
    expect(ended?.ended_at).not.toBeNull()
    expect(await lostReason(await renew(sessionOf(amy), document.id, lease.token))).toBe('released')
    expect((await status(sessionOf(ben), document.id)).editor).toBeNull()
    // 再释放一次：已经结束，结束的时间与原因都不变
    expect((await release(sessionOf(amy), document.id, lease.token)).status).toBe(204)
    expect(await leaseOf(document.id)).toEqual(ended)
  })

  it('US-M3-04 释放要是持有者本人（M3-P1 审查 A4）：能读这份文档的别人拿到了令牌，释放什么也不做（204），租约与心跳照常；本人换了登录（修改密码）之后照样能释放自己那一代', async () => {
    const { account: hana, session } = await freshEditor('lease-hana')
    const document = await freshDocument()
    const lease = await acquired(session, document.id)
    for (const other of [ben, vic])
      expect((await release(sessionOf(other), document.id, lease.token)).status, other.username).toBe(204)
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: hana.id, ended_at: null, end_reason: null })
    expect((await renew(session, document.id, lease.token)).status).toBe(200)

    // 换令牌之后的页面（续上之前先释放自己那一代）：登录换了，持有者还是她
    const changed = await asUser(app.baseUrl, session, '/api/auth/password', { method: 'PUT', body: { currentPassword: hana.password, newPassword: 'a brand new long password' } })
    expect(changed.status, await changed.clone().text()).toBe(200)
    const setCookie = sessionSetCookie(changed)
    if (setCookie === undefined)
      throw new Error('改密码成功却没有写回会话 Cookie')
    const renewedSession: LoggedIn = { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}`, session: parseExact(sessionResponseSchema, await changed.json()) }
    expect((await release(renewedSession, document.id, lease.token)).status).toBe(204)
    expect(await leaseOf(document.id)).toMatchObject({ end_reason: 'released' })
  })
})

describe('先判断访问与编辑权，再看租约（P1 设计 §3.2）', () => {
  it('查看者：申请与心跳 403，释放 204（能读就行，没有他的租约什么也不做），编辑状态 200', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    expect(await errorOf(await acquire(sessionOf(vic), document.id))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(await errorOf(await renew(sessionOf(vic), document.id, lease.token))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect((await release(sessionOf(vic), document.id, `${'v'.repeat(41)}-_`)).status).toBe(204)
    expect((await status(sessionOf(vic), document.id)).editor).toMatchObject({ holder: summaryOf(amy) })
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: amy.id, ended_at: null })
  })

  it('看不到（外人）：四个接口都 404，与不存在的文档相同；租约不受影响', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    for (const id of [document.id, randomUUID()]) {
      expect(await errorOf(await acquire(sessionOf(outsider), id)), id).toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await errorOf(await renew(sessionOf(outsider), id, lease.token)), id).toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await errorOf(await release(sessionOf(outsider), id, lease.token)), id).toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await errorOf(await asUser(app.baseUrl, sessionOf(outsider), leasePath(id))), id).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    }
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: amy.id, ended_at: null })
  })

  it('能编辑、没有租约：心跳 409 none；没带令牌也是 none；令牌的格式不对 400；请求体不合法 400', async () => {
    const document = await freshDocument()
    expect(await lostReason(await renew(sessionOf(ben), document.id, `${'n'.repeat(41)}-_`))).toBe('none')
    await acquired(sessionOf(ben), document.id)
    expect(await lostReason(await renew(sessionOf(ben), document.id, undefined))).toBe('none')
    expect(await errorOf(await renew(sessionOf(ben), document.id, 'short'))).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    expect(await errorOf(await asUser(app.baseUrl, sessionOf(ben), leasePath(document.id), { method: 'PUT', body: { idleSeconds: -1 } }))).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    expect(await errorOf(await asUser(app.baseUrl, sessionOf(ben), leasePath(document.id), { method: 'POST', body: { clientInstanceId: 'tab-1' } }))).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
  })
})

describe('US-M3-04 同一时刻只有一个标签页能编辑', () => {
  it('US-M3-04 被占用：别人申请 409 EDIT_LEASE_HELD，详情带持有者、最后活动时间、不是自己；本人另一个标签页 sameUser 为真；什么也不写', async () => {
    const document = await freshDocument()
    await acquired(sessionOf(amy), document.id)
    const before = { lease: await leaseOf(document.id), document: await documentOf(document.id) }
    const lastActiveAt = before.lease?.last_active_at.toISOString()
    // M3-P5：另带是不是调用者这次登录、调用者能不能强制接管（本是编辑者，不能）与待回应的请求（没人在请求，null；有请求时见 lease-requests.test.ts）
    expect(await heldBy(await acquire(sessionOf(ben), document.id))).toEqual({ holder: summaryOf(amy), lastActiveAt, sameUser: false, sameSession: false, canTakeOver: false, request: null })
    expect(await heldBy(await acquire(sessionOf(amy), document.id))).toEqual({ holder: summaryOf(amy), lastActiveAt, sameUser: true, sameSession: true, canTakeOver: true, request: null })
    // 同一个人在另一个设备上（另一条登录）也一样，只是不是这次登录
    const otherDevice = await login(app.baseUrl, amy.username, amy.password)
    expect(await heldBy(await acquire(otherDevice, document.id))).toMatchObject({ sameUser: true, sameSession: false })
    expect({ lease: await leaseOf(document.id), document: await documentOf(document.id) }).toEqual(before)
  })

  it('M3-P5 被占用的详情里能不能强制接管按申请的人：团队空间的空间管理员能（持有者是编辑者），个人空间的所有者能（持有者是被授权的编辑者），被授权的编辑者不能', async () => {
    const team = await freshDocument()
    await acquired(sessionOf(ben), team.id)
    expect(await heldBy(await acquire(sessionOf(amy), team.id))).toMatchObject({ holder: summaryOf(ben), sameUser: false, canTakeOver: true })

    const personal = await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '租约：个人空间' })
    await grantEditor(personal.id, ben.id)
    const granted = await acquired(sessionOf(ben), personal.id)
    expect(await heldBy(await acquire(sessionOf(amy), personal.id))).toMatchObject({ holder: summaryOf(ben), canTakeOver: true })
    expect((await release(sessionOf(ben), personal.id, granted.token)).status).toBe(204)
    const owned = await acquired(sessionOf(amy), personal.id)
    expect(await heldBy(await acquire(sessionOf(ben), personal.id))).toMatchObject({ holder: summaryOf(amy), canTakeOver: false })
    expect((await renew(sessionOf(amy), personal.id, owned.token)).status).toBe(200)
  })

  it('M3-P5 申请的接管方式按契约校验：self、force 照常收下（没人在编辑时就是普通的申请，接管本身见 lease-takeover.test.ts）；别的取值——库里的写法 forced、别的字符串、空串、布尔值、null——400，什么也不写', async () => {
    const other = await freshDocument()
    const before = await documentOf(other.id)
    for (const takeover of ['forced', 'steal', '', true, null]) {
      const response = await asUser(app.baseUrl, sessionOf(amy), leasePath(other.id), { method: 'POST', body: { ...acquireBody(randomUUID()), takeover } })
      expect(await errorOf(response), String(takeover)).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    }
    expect(await leaseOf(other.id)).toBeUndefined()
    expect(await documentOf(other.id)).toEqual(before)
    for (const takeover of ['self', 'force']) {
      const document = await freshDocument()
      const response = await asUser(app.baseUrl, sessionOf(amy), leasePath(document.id), { method: 'POST', body: { ...acquireBody(randomUUID()), takeover } })
      expect(response.status, takeover).toBe(201)
      expect(await leaseOf(document.id), takeover).toMatchObject({ holder_id: amy.id, ended_at: null })
    }
  })

  it('US-M3-04 两个人同时申请（确定交错）：测试持住文档行，艾米、本依次停在这把锁上；放开之后艾米取得，本在锁下看到她的租约，409', async () => {
    const document = await freshDocument()
    const before = await documentOf(document.id)
    const [first, second] = await raceTwoAcquires(document.id, async () => acquire(sessionOf(amy), document.id), async () => acquire(sessionOf(ben), document.id))
    expect(first.status, await first.clone().text()).toBe(201)
    expect((await heldBy(second)).holder).toEqual(summaryOf(amy))
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: amy.id })
    expect((await documentOf(document.id)).write_epoch).toBe(before.write_epoch + 1)
  })

  it('US-M3-04 同一个人的两个标签页同时申请（确定交错）：先到的标签页取得，后到的 409，sameUser 为真', async () => {
    const document = await freshDocument()
    const [firstTab, secondTab] = [randomUUID(), randomUUID()]
    const [first, second] = await raceTwoAcquires(document.id, async () => acquire(sessionOf(amy), document.id, firstTab), async () => acquire(sessionOf(amy), document.id, secondTab))
    expect(first.status, await first.clone().text()).toBe(201)
    expect(await heldBy(second)).toMatchObject({ holder: summaryOf(amy), sameUser: true })
    expect(await leaseOf(document.id)).toMatchObject({ holder_id: amy.id, client_instance_id: firstTab })
  })

  it('US-M3-04 同一个页面重试申请（同一个登录、同一个标签页，例如回包丢了）：新的一代、代次再加一，旧令牌随即失效（replaced）', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    const first = await acquired(sessionOf(amy), document.id, tab)
    const retried = await acquired(sessionOf(amy), document.id, tab)
    expect(retried.writeEpoch).toBe(first.writeEpoch + 1)
    expect(retried.token).not.toBe(first.token)
    expect(retried.interruption).toBeNull()
    expect(await lostReason(await renew(sessionOf(amy), document.id, first.token))).toBe('replaced')
    expect((await renew(sessionOf(amy), document.id, retried.token)).status).toBe(200)
  })
})

/** 两个申请：测试持住文档行，first 先停在锁上、second 排在它后面，再放开 */
async function raceTwoAcquires(documentId: string, first: () => Promise<Response>, second: () => Promise<Response>): Promise<[Response, Response]> {
  return raceAgainstHeldLock(database, {
    hold: async client => client.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [documentId]),
    request: async (steps) => {
      const a = steps.step(first())
      await steps.waitForWaiting(1)
      const b = steps.step(second())
      return Promise.all([a, b])
    },
    change: async () => undefined,
    waiting: 2,
  })
}

describe('US-M3-11 到期与空闲：时间以数据库为准（改写租约行的时间，不等真实的时间）', () => {
  it('US-M3-11 到期之后别人能申请，提醒里是上一位持有者与他最后一次续租的时间；持有者的旧令牌心跳得到 replaced', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const renewedAt = (await leaseOf(document.id))?.renewed_at.toISOString()
    expect((await status(sessionOf(ben), document.id)).editor).toBeNull()
    const taken = await acquired(sessionOf(ben), document.id)
    expect(taken.writeEpoch).toBe(lease.writeEpoch + 1)
    expect(taken.interruption).toEqual({ holder: summaryOf(amy), endedAt: renewedAt, sameUser: false })
    expect(await lostReason(await renew(sessionOf(amy), document.id, lease.token))).toBe('replaced')
  })

  it('US-M3-10 提醒带上是不是自己（M3-P5）：自己的租约到期之后自己再申请（另一个设备），提醒是关于自己的，sameUser 为真', async () => {
    const document = await freshDocument()
    await acquired(sessionOf(amy), document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const renewedAt = (await leaseOf(document.id))?.renewed_at.toISOString()
    const otherDevice = await login(app.baseUrl, amy.username, amy.password)
    expect((await acquired(otherDevice, document.id)).interruption).toEqual({ holder: summaryOf(amy), endedAt: renewedAt, sameUser: true })
  })

  it('US-M3-11 到期之后没人接手：持有者心跳得到 expired；离到期还有 10 秒时照常续租，别人申请被占用', async () => {
    const valid = await freshDocument()
    const lease = await acquired(sessionOf(amy), valid.id)
    await passLeaseTime(database, valid.id, EDIT_LEASE_TTL_SECONDS - 10)
    expect((await heldBy(await acquire(sessionOf(ben), valid.id))).holder).toEqual(summaryOf(amy))
    expect((await renew(sessionOf(amy), valid.id, lease.token)).status).toBe(200)

    const expired = await freshDocument()
    const old = await acquired(sessionOf(amy), expired.id)
    await passLeaseTime(database, expired.id, EDIT_LEASE_TTL_SECONDS)
    expect(await lostReason(await renew(sessionOf(amy), expired.id, old.token))).toBe('expired')
  })

  it('US-M3-11 空闲满 12 分钟由服务端回收（心跳还在）：持有者心跳得到 idle，别人能申请且有提醒；差 10 秒时照常', async () => {
    const valid = await freshDocument()
    const lease = await acquired(sessionOf(amy), valid.id)
    await idleLeaseFor(database, valid.id, 720 - 10)
    expect((await renew(sessionOf(amy), valid.id, lease.token, 720 - 10)).status).toBe(200)

    const idle = await freshDocument()
    const old = await acquired(sessionOf(amy), idle.id)
    await idleLeaseFor(database, idle.id, 720)
    expect(await lostReason(await renew(sessionOf(amy), idle.id, old.token))).toBe('idle')
    expect((await status(sessionOf(ben), idle.id)).editor).toBeNull()
    const taken = await acquired(sessionOf(ben), idle.id)
    expect(taken.interruption?.holder).toEqual(summaryOf(amy))
  })
})

describe('登录失效，租约随之失效（P1 设计 §1、§3.4.1 第 6 条）', () => {
  it('退出登录：没人在编辑、别人能申请（登录失效算异常结束，有提醒）；持有者重新登录之后用旧令牌心跳得到 session', async () => {
    const { account: cara, session } = await freshEditor('lease-cara')
    const document = await freshDocument()
    const lease = await acquired(session, document.id)
    expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    const again = await login(app.baseUrl, cara.username, cara.password)
    expect(await lostReason(await renew(again, document.id, lease.token))).toBe('session')
    expect((await status(sessionOf(ben), document.id)).editor).toBeNull()
    expect((await acquired(sessionOf(ben), document.id)).interruption?.holder.id).toBe(cara.id)
  })

  it('US-M3-09 系统管理员签发重置链接（撤销这个人的全部登录）：别人能申请，提醒里是他；他原来的登录之后的请求 401', async () => {
    const { account: dora, session } = await freshEditor('lease-dora')
    const document = await freshDocument()
    const lease = await acquired(session, document.id)
    const issued = await asUser(app.baseUrl, sessionOf(root), `/api/admin/users/${dora.id}/password-reset`, { method: 'POST' })
    expect(issued.status, await issued.clone().text()).toBe(201)
    expect((await acquired(sessionOf(ben), document.id)).interruption?.holder.id).toBe(dora.id)
    expect((await renew(session, document.id, lease.token)).status).toBe(401)
  })

  it('修改密码（换令牌）：同一个页面拿到新的登录，心跳得到 session（P2 的页面据此自动续上）；别人能申请', async () => {
    const { account: erin, session } = await freshEditor('lease-erin')
    const document = await freshDocument()
    const lease = await acquired(session, document.id)
    const changed = await asUser(app.baseUrl, session, '/api/auth/password', { method: 'PUT', body: { currentPassword: erin.password, newPassword: 'a brand new long password' } })
    expect(changed.status, await changed.clone().text()).toBe(200)
    const setCookie = sessionSetCookie(changed)
    if (setCookie === undefined)
      throw new Error('改密码成功却没有写回会话 Cookie')
    const renewedSession: LoggedIn = { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}`, session: parseExact(sessionResponseSchema, await changed.json()) }
    expect(await lostReason(await renew(renewedSession, document.id, lease.token))).toBe('session')
    expect((await acquired(sessionOf(ben), document.id)).interruption?.holder.id).toBe(erin.id)
  })
})

describe('US-M3-12 持有者没了编辑权（有效条件第 7 条：直接改库里的成员角色，不经收回写入权的入口——经接口的收回见 lease-revocation.test.ts）', () => {
  it('US-M3-12 被降为查看者：没人在编辑、别人能申请（不算异常结束，没有提醒）；他再心跳 403（失去编辑权先于租约判断）', async () => {
    const { account: gus, session } = await freshEditor('lease-gus')
    const document = await freshDocument()
    const lease = await acquired(session, document.id)
    await setMember(database, team, gus.id, 'viewer')
    expect((await status(sessionOf(ben), document.id)).editor).toBeNull()
    expect((await acquired(sessionOf(ben), document.id)).interruption).toBeNull()
    expect(await errorOf(await renew(session, document.id, lease.token))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
  })
})

describe('US-M3-10 异常结束的提醒（服务端部分，界面在 P5）', () => {
  it('到期之后 29 分 50 秒有提醒，30 分 10 秒没有（恰好 30 分钟算以内，由单元测试按同一个 now 核对）', async () => {
    const within = await freshDocument()
    await acquired(sessionOf(amy), within.id)
    await passLeaseTime(database, within.id, 30 * 60 - 10)
    expect((await acquired(sessionOf(ben), within.id)).interruption?.holder).toEqual(summaryOf(amy))

    const beyond = await freshDocument()
    await acquired(sessionOf(amy), beyond.id)
    await passLeaseTime(database, beyond.id, 30 * 60 + 10)
    expect((await acquired(sessionOf(ben), beyond.id)).interruption).toBeNull()
  })

  it('US-M3-07 空闲释放（页面先保存再释放）与退出编辑都是释放：明确结束，编辑状态与申请都没有提醒——到期之后也不算异常结束', async () => {
    const released = await freshDocument()
    const lease = await acquired(sessionOf(amy), released.id)
    expect((await release(sessionOf(amy), released.id, lease.token)).status).toBe(204)
    await passLeaseTime(database, released.id, EDIT_LEASE_TTL_SECONDS)
    expect((await status(sessionOf(ben), released.id)).interruption).toBeNull()
    expect((await acquired(sessionOf(ben), released.id)).interruption).toBeNull()
  })

  it('US-M3-10 编辑状态里的提醒（M3-P5 设计 §3.5）：没人在编辑、上一个租约异常结束在 30 分钟以内时给出，与申请得到的同一个；带上是不是调用者自己；有人在编辑时为 null', async () => {
    const document = await freshDocument()
    await acquired(sessionOf(amy), document.id)
    // 有人在编辑：没有提醒
    expect((await status(sessionOf(ben), document.id)).interruption).toBeNull()
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const notice = { holder: summaryOf(amy), endedAt: (await leaseOf(document.id))?.renewed_at.toISOString() }
    // 查看者也看得到；持有者本人看到的是关于自己的
    expect(await status(sessionOf(vic), document.id)).toMatchObject({ editor: null, interruption: { ...notice, sameUser: false } })
    expect((await status(sessionOf(amy), document.id)).interruption).toEqual({ ...notice, sameUser: true })
    expect((await acquired(sessionOf(ben), document.id)).interruption).toEqual({ ...notice, sameUser: false })
    // 本在编辑了：没有提醒
    expect(await status(sessionOf(vic), document.id)).toMatchObject({ editor: { holder: summaryOf(ben) }, interruption: null })
  })

  it('US-M3-10 编辑状态里的提醒同样只给 30 分钟以内的（29 分 50 秒有，30 分 10 秒没有）', async () => {
    const within = await freshDocument()
    await acquired(sessionOf(amy), within.id)
    await passLeaseTime(database, within.id, 30 * 60 - 10)
    expect((await status(sessionOf(ben), within.id)).interruption?.holder).toEqual(summaryOf(amy))

    const beyond = await freshDocument()
    await acquired(sessionOf(amy), beyond.id)
    await passLeaseTime(database, beyond.id, 30 * 60 + 10)
    expect((await status(sessionOf(ben), beyond.id)).interruption).toBeNull()
  })

  it('US-M3-10 先到期、后代次过时（跨空间移动、转移会这样）：代次过时不遮住异常结束（P1 审查 A6 第 1 处），编辑状态与申请都有提醒；旧令牌心跳得到 stale', async () => {
    const document = await freshDocument()
    const old = await acquired(sessionOf(amy), document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const endedAt = (await leaseOf(document.id))?.renewed_at.toISOString()
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [document.id]))
    expect(await lostReason(await renew(sessionOf(amy), document.id, old.token))).toBe('stale')
    expect((await status(sessionOf(ben), document.id)).interruption).toEqual({ holder: summaryOf(amy), endedAt, sameUser: false })
    expect((await acquired(sessionOf(ben), document.id)).interruption).toEqual({ holder: summaryOf(amy), endedAt, sameUser: false })
  })
})

describe('M3-P5 R2：代次过时、而按时间、登录、编辑权都还活着（跨空间移动、转移之后持有者的页面正在续上）——只让持有者本人续上（设计 §3.5）', () => {
  it('别人申请是被占用（详情是持有者），编辑状态里有人在编辑，什么也不写；持有者的旧令牌心跳得到 stale，同一个页面续上取得新的一代，没有提醒', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    const old = await acquired(sessionOf(amy), document.id, tab)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [document.id]))
    const before = { lease: await leaseOf(document.id), document: await documentOf(document.id) }
    expect(await heldBy(await acquire(sessionOf(ben), document.id))).toEqual({ holder: summaryOf(amy), lastActiveAt: before.lease?.last_active_at.toISOString(), sameUser: false, sameSession: false, canTakeOver: false, request: null })
    expect(await status(sessionOf(ben), document.id)).toMatchObject({ editor: { holder: summaryOf(amy), sameUser: false }, interruption: null })
    expect({ lease: await leaseOf(document.id), document: await documentOf(document.id) }).toEqual(before)
    // 持有者本人看是空着的（他的续上就是普通的申请）
    expect(await status(sessionOf(amy), document.id)).toMatchObject({ editor: null, interruption: null })
    expect(await lostReason(await renew(sessionOf(amy), document.id, old.token))).toBe('stale')
    const resumed = await acquired(sessionOf(amy), document.id, tab)
    expect(resumed).toMatchObject({ writeEpoch: before.document.write_epoch + 1, interruption: null })
    expect((await renew(sessionOf(amy), document.id, resumed.token)).status).toBe(200)
  })

  it('要"都还活着"：代次过时而且到期了、持有者的登录失效（都有提醒）、持有者没了编辑权（没有提醒）——别人照样取得新的一代', async () => {
    const expired = await freshDocument()
    await acquired(sessionOf(amy), expired.id)
    await passLeaseTime(database, expired.id, EDIT_LEASE_TTL_SECONDS)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [expired.id]))
    expect((await acquired(sessionOf(ben), expired.id)).interruption?.holder).toEqual(summaryOf(amy))

    const { account: kit, session } = await freshEditor('lease-kit')
    const loggedOut = await freshDocument()
    await acquired(session, loggedOut.id)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [loggedOut.id]))
    expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    expect((await acquired(sessionOf(ben), loggedOut.id)).interruption?.holder.id).toBe(kit.id)

    const { account: lou, session: louSession } = await freshEditor('lease-lou')
    const demoted = await freshDocument()
    await acquired(louSession, demoted.id)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [demoted.id]))
    await setMember(database, team, lou.id, 'viewer')
    expect((await acquired(sessionOf(ben), demoted.id)).interruption).toBeNull()
  })
})

describe('US-M3-07 空闲：服务端 12 分钟的兜底按页面的空闲计时（M3-P5 设计 §3.5，复验 P1-C5：续上不让它重新开始）', () => {
  /** 申请时带上续上的页面已经空闲的秒数 */
  async function acquiredIdle(session: LoggedIn, documentId: string, idleSeconds: number): Promise<AcquiredEditLease> {
    const response = await asUser(app.baseUrl, session, leasePath(documentId), { method: 'POST', body: { ...acquireBody(randomUUID()), idleSeconds } })
    expect(response.status, await response.clone().text()).toBe(201)
    return parseExact(acquiredEditLeaseSchema, await response.json())
  }

  it('US-M3-07 申请带 idleSeconds（续上时页面的空闲）：新的一代的最后活动是申请的时刻减去它（同一个 now）；不带的是申请的时刻', async () => {
    const carried = await freshDocument()
    await acquiredIdle(sessionOf(amy), carried.id, 600)
    const row = await leaseOf(carried.id)
    expect((row?.acquired_at.getTime() ?? 0) - (row?.last_active_at.getTime() ?? 0)).toBe(600_000)
    expect([row?.renewed_at, row?.expires_at.getTime()]).toEqual([row?.acquired_at, (row?.acquired_at.getTime() ?? 0) + EDIT_LEASE_TTL_SECONDS * 1000])

    const plain = await freshDocument()
    await acquired(sessionOf(amy), plain.id)
    const plainRow = await leaseOf(plain.id)
    expect(plainRow?.last_active_at).toEqual(plainRow?.acquired_at)
  })

  it('US-M3-07 心跳不把带来的空闲抹掉：带 600 秒申请之后，心跳照实上报 600 秒，最后活动仍是 600 秒之前（原来"不早于申请的时间"的夹取会把它抹成 0）', async () => {
    const document = await freshDocument()
    const lease = await acquiredIdle(sessionOf(amy), document.id, 600)
    expect((await renew(sessionOf(amy), document.id, lease.token, 600)).status).toBe(200)
    const row = await leaseOf(document.id)
    expect((row?.renewed_at.getTime() ?? 0) - (row?.last_active_at.getTime() ?? 0)).toBe(600_000)
  })

  it('US-M3-07 带来的空闲算进 12 分钟的兜底：带 600 秒申请，之后心跳照常、没有操作——再过 110 秒仍有效，再过 120 秒按空闲回收（心跳 idle，编辑状态与申请都有提醒）；不带空闲的再过 120 秒照常', async () => {
    const valid = await freshDocument()
    const lease = await acquiredIdle(sessionOf(amy), valid.id, 600)
    await passIdleTime(database, valid.id, 110)
    expect((await renew(sessionOf(amy), valid.id, lease.token, 710)).status).toBe(200)

    const idle = await freshDocument()
    const old = await acquiredIdle(sessionOf(amy), idle.id, 600)
    await passIdleTime(database, idle.id, 120)
    expect(await lostReason(await renew(sessionOf(amy), idle.id, old.token, 720))).toBe('idle')
    expect(await status(sessionOf(ben), idle.id)).toMatchObject({ editor: null, interruption: { holder: summaryOf(amy), sameUser: false } })
    expect((await acquired(sessionOf(ben), idle.id)).interruption?.holder).toEqual(summaryOf(amy))

    const fresh = await freshDocument()
    const plain = await acquired(sessionOf(amy), fresh.id)
    await passIdleTime(database, fresh.id, 120)
    expect((await renew(sessionOf(amy), fresh.id, plain.token, 120)).status).toBe(200)
  })

  it('US-M3-07 申请的空闲秒数按契约校验：负数、超过一天、不是整数都是 400，什么也不写', async () => {
    const document = await freshDocument()
    for (const idleSeconds of [-1, 86_401, 1.5, '30']) {
      const response = await asUser(app.baseUrl, sessionOf(amy), leasePath(document.id), { method: 'POST', body: { ...acquireBody(randomUUID()), idleSeconds } })
      expect(await errorOf(response), String(idleSeconds)).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    }
    expect(await leaseOf(document.id)).toBeUndefined()
  })
})

/** 租约行上 M3-P5 的三组列（请求编辑、交出之后的保留、接管标记）与明确结束的原因 */
interface HandoverColumns {
  readonly request_id: string | null
  readonly requested_by: string | null
  readonly request_session_id: string | null
  readonly requested_at: Date | null
  readonly request_expires_at: Date | null
  readonly request_declined_at: Date | null
  readonly reserved_for: string | null
  readonly reserved_until: Date | null
  readonly taken_over_token_digest: Buffer | null
  readonly takeover: string | null
  readonly end_reason: string | null
}

async function handoverOf(documentId: string): Promise<HandoverColumns | undefined> {
  return database.query(async client => (await client.query<HandoverColumns>(
    `SELECT request_id, requested_by, request_session_id, requested_at, request_expires_at, request_declined_at, reserved_for, reserved_until,
       taken_over_token_digest, takeover, end_reason FROM document_edit_leases WHERE document_id = $1`,
    [documentId],
  )).rows[0])
}

/** 都是空的：没有请求、保留与接管标记，也没有明确结束 */
const NO_HANDOVER: HandoverColumns = {
  request_id: null,
  requested_by: null,
  request_session_id: null,
  requested_at: null,
  request_expires_at: null,
  request_declined_at: null,
  reserved_for: null,
  reserved_until: null,
  taken_over_token_digest: null,
  takeover: null,
  end_reason: null,
}

describe('M3-P5 改写为新的一代时请求编辑、交出之后的保留与接管标记的沿用与清空（设计 §3.6、§3.7；这里直接写库摆好，只核对这几列；经接口的发出、交出与接管见 lease-requests.test.ts、lease-takeover.test.ts）', () => {
  /** 这份文档的租约行上记下 requester 的请求（发出于 1 分钟前，有效期还有 9 分钟），declined 时持有者已经谢绝 */
  async function putRequest(documentId: string, requester: TestAccount, declined = false): Promise<HandoverColumns | undefined> {
    await database.query(async client => client.query(
      `UPDATE document_edit_leases SET request_id = gen_random_uuid(), requested_by = $2, request_session_id = gen_random_uuid(),
         requested_at = now() - interval '1 minute', request_expires_at = now() + interval '9 minutes',
         request_declined_at = CASE WHEN $3 THEN now() END
       WHERE document_id = $1`,
      [documentId, requester.id, declined],
    ))
    return handoverOf(documentId)
  }

  /** 交出了：这一代明确结束（handed_over），留给 reservedFor 两分钟；expired 时保留已经过了期（还留在行上） */
  async function putReservation(documentId: string, reservedFor: TestAccount, expired = false): Promise<void> {
    await database.query(async client => client.query(
      `UPDATE document_edit_leases SET ended_at = now(), end_reason = 'handed_over', reserved_for = $2,
         reserved_until = CASE WHEN $3 THEN now() - interval '1 second' ELSE now() + interval '2 minutes' END
       WHERE document_id = $1`,
      [documentId, reservedFor.id, expired],
    ))
  }

  /** 这一代接管了另一代（接管标记：被接管那一代的令牌摘要与方式） */
  async function putTakeoverMarker(documentId: string, takeover: 'self' | 'forced'): Promise<HandoverColumns | undefined> {
    await database.query(async client => client.query(
      'UPDATE document_edit_leases SET taken_over_token_digest = sha256(convert_to($2, \'UTF8\')), takeover = $3 WHERE document_id = $1',
      [documentId, `taken-over-${randomUUID()}`, takeover],
    ))
    return handoverOf(documentId)
  }

  it('US-M3-06 新的持有者还是旧行的持有者——同一个页面重试、释放之后在别的标签页重新申请、到期之后在别的设备上续上：原样沿用请求，包括已谢绝的状态', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    await acquired(sessionOf(amy), document.id, tab)
    const pending = await putRequest(document.id, ben)
    // 同一个页面重试（有效的租约，同一个登录、同一个标签页）
    await acquired(sessionOf(amy), document.id, tab)
    expect(await handoverOf(document.id)).toEqual(pending)
    // 释放之后在别的标签页重新申请
    const current = await acquired(sessionOf(amy), document.id, tab)
    expect((await release(sessionOf(amy), document.id, current.token)).status).toBe(204)
    await acquired(sessionOf(amy), document.id)
    expect(await handoverOf(document.id)).toEqual(pending)

    // 已谢绝的：到期之后在别的设备上续上，谢绝的状态照样在
    const declinedDocument = await freshDocument()
    await acquired(sessionOf(amy), declinedDocument.id)
    const declined = await putRequest(declinedDocument.id, ben, true)
    expect(declined?.request_declined_at).not.toBeNull()
    await passLeaseTime(database, declinedDocument.id, EDIT_LEASE_TTL_SECONDS)
    const moved = await handoverOf(declinedDocument.id)
    await acquired(await login(app.baseUrl, amy.username, amy.password), declinedDocument.id)
    expect(await handoverOf(declinedDocument.id)).toEqual(moved)
  })

  it('US-M3-06 换了别人的一代：清掉请求；新的持有者就是请求方：请求已经实现，同一条语句里清掉（"请求方不是持有者"的约束照样成立）', async () => {
    const { account: cat, session } = await freshEditor('lease-cat')
    const other = await freshDocument()
    await acquired(sessionOf(amy), other.id)
    await putRequest(other.id, ben)
    await passLeaseTime(database, other.id, EDIT_LEASE_TTL_SECONDS)
    await acquired(session, other.id)
    expect({ holder: (await leaseOf(other.id))?.holder_id, ...await handoverOf(other.id) }).toEqual({ holder: cat.id, ...NO_HANDOVER })

    const fulfilled = await freshDocument()
    const lease = await acquired(sessionOf(amy), fulfilled.id)
    await putRequest(fulfilled.id, ben)
    expect((await release(sessionOf(amy), fulfilled.id, lease.token)).status).toBe(204)
    await acquired(sessionOf(ben), fulfilled.id)
    expect({ holder: (await leaseOf(fulfilled.id))?.holder_id, ...await handoverOf(fulfilled.id) }).toEqual({ holder: ben.id, ...NO_HANDOVER })
  })

  it('US-M3-06 交出之后的保留：新的一代（被保留的人、原来的持有者、别人）一律连同明确结束清掉（同一条语句里，"有保留时结束原因是 handed_over"的约束照样成立）——保留期内只有被保留的人申请得到（S4，别人得到 EDIT_LEASE_RESERVED，见 lease-requests.test.ts），过了期的保留照样留在行上、照样清掉', async () => {
    const { session: deb } = await freshEditor('lease-deb')
    for (const [name, session, expired] of [['被保留的人', sessionOf(ben), false], ['原来的持有者', sessionOf(amy), true], ['别人', deb, true]] as const) {
      const document = await freshDocument()
      await acquired(sessionOf(amy), document.id)
      await putReservation(document.id, ben, expired)
      expect(await handoverOf(document.id), name).toMatchObject({ end_reason: 'handed_over', reserved_for: ben.id })
      await acquired(session, document.id)
      expect(await handoverOf(document.id), name).toEqual(NO_HANDOVER)
    }
  })

  it('US-M3-08 接管标记：同一个页面的重试沿用上一代的（否则一次重试就把"被接管"变回了 replaced）；别的页面——同一个人别的标签页、别人——的新一代清掉', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    await acquired(sessionOf(amy), document.id, tab)
    const marked = await putTakeoverMarker(document.id, 'forced')
    const retried = await acquired(sessionOf(amy), document.id, tab)
    expect(await handoverOf(document.id)).toEqual(marked)
    // 释放之后同一个人在别的标签页申请：不是那个页面的重试，清掉
    expect((await release(sessionOf(amy), document.id, retried.token)).status).toBe(204)
    await acquired(sessionOf(amy), document.id)
    expect(await handoverOf(document.id)).toEqual(NO_HANDOVER)

    const others = await freshDocument()
    await acquired(sessionOf(amy), others.id)
    await putTakeoverMarker(others.id, 'self')
    await passLeaseTime(database, others.id, EDIT_LEASE_TTL_SECONDS)
    await acquired(sessionOf(ben), others.id)
    expect(await handoverOf(others.id)).toEqual(NO_HANDOVER)
  })
})

describe('日志（P1 设计 §3.5）', () => {
  it('申请成功、被占用、心跳失效各一条 debug 的结构化日志（文档 id 与原因），日志里没有令牌', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    await heldBy(await acquire(sessionOf(ben), document.id))
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    expect(await lostReason(await renew(sessionOf(amy), document.id, lease.token))).toBe('expired')
    const entries = app.logs.entries().filter(entry => entry.documentId === document.id)
    expect(entries.map(entry => [entry.level, entry.msg, entry.previous ?? entry.sameUser ?? entry.reason])).toEqual([
      ['debug', '申请编辑权：取得新的一代', 'none'],
      ['debug', '申请编辑权：有效的租约在别人手里', false],
      ['debug', '续租失败：编辑权已失效', 'expired'],
    ])
    expect(app.logs.text()).not.toContain(lease.token)
  })
})

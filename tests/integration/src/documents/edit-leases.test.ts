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
import { acquiredEditLeaseSchema, EDIT_LEASE_HEADER, EDIT_LEASE_TTL_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema, editStatusSchema, errorResponseSchema, renewedEditLeaseSchema, sessionResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { idleLeaseFor, passLeaseTime, saveContent } from '../support/edit-leases.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, cookieValue, login, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

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
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'POST', body: { clientInstanceId } })
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
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'PUT', body: { idleSeconds }, headers: leaseHeaders(token) })
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

  it('US-M3-04 编辑状态：能读就能看；有效的租约给出持有者（"人"的结构）、最后活动时间与是不是调用者自己；没有时为 null', async () => {
    const document = await freshDocument()
    expect(await status(sessionOf(vic), document.id)).toEqual({ revision: 1, editor: null })
    await acquired(sessionOf(amy), document.id)
    const row = await leaseOf(document.id)
    const editor = { holder: summaryOf(amy), lastActiveAt: row?.last_active_at.toISOString() }
    expect(await status(sessionOf(ben), document.id)).toEqual({ revision: 1, editor: { ...editor, sameUser: false } })
    expect(await status(sessionOf(vic), document.id)).toEqual({ revision: 1, editor: { ...editor, sameUser: false } })
    expect(await status(sessionOf(amy), document.id)).toEqual({ revision: 1, editor: { ...editor, sameUser: true } })
  })

  it('心跳：续租的时间是数据库的 now，到期往后推 90 秒；最后活动是 now 减上报的空闲秒数，不早于申请的时间', async () => {
    const document = await freshDocument()
    const lease = await acquired(sessionOf(amy), document.id)
    // 申请在 10 分钟之前（续租与到期不动）：上报的空闲秒数不受"不早于申请"的限制
    await database.query(async client => client.query('UPDATE document_edit_leases SET acquired_at = acquired_at - interval \'10 minutes\' WHERE document_id = $1', [document.id]))
    const response = await renew(sessionOf(amy), document.id, lease.token, 30)
    expect(response.status, await response.clone().text()).toBe(200)
    const renewed = parseExact(renewedEditLeaseSchema, await response.json())
    const row = await leaseOf(document.id)
    expect(row?.expires_at.toISOString()).toBe(renewed.expiresAt)
    expect((row?.expires_at.getTime() ?? 0) - (row?.renewed_at.getTime() ?? 0)).toBe(EDIT_LEASE_TTL_SECONDS * 1000)
    expect((row?.renewed_at.getTime() ?? 0) - (row?.last_active_at.getTime() ?? 0)).toBe(30_000)
    // 上报一天：最后活动夹在申请的时间上；上报 0：就是续租的时刻
    expect((await renew(sessionOf(amy), document.id, lease.token, 86_400)).status).toBe(200)
    const clamped = await leaseOf(document.id)
    expect(clamped?.last_active_at).toEqual(clamped?.acquired_at)
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
    expect(await heldBy(await acquire(sessionOf(ben), document.id))).toEqual({ holder: summaryOf(amy), lastActiveAt, sameUser: false })
    expect(await heldBy(await acquire(sessionOf(amy), document.id))).toEqual({ holder: summaryOf(amy), lastActiveAt, sameUser: true })
    // 同一个人在另一个设备上（另一条登录）也一样
    const otherDevice = await login(app.baseUrl, amy.username, amy.password)
    expect((await heldBy(await acquire(otherDevice, document.id))).sameUser).toBe(true)
    expect({ lease: await leaseOf(document.id), document: await documentOf(document.id) }).toEqual(before)
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
    expect(taken.interruption).toEqual({ holder: summaryOf(amy), endedAt: renewedAt })
    expect(await lostReason(await renew(sessionOf(amy), document.id, lease.token))).toBe('replaced')
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

  it('释放之后、代次过时（删除、移动、收回写入权会这样）：都不算异常结束，没有提醒；代次过时的旧令牌心跳得到 stale', async () => {
    const released = await freshDocument()
    const lease = await acquired(sessionOf(amy), released.id)
    expect((await release(sessionOf(amy), released.id, lease.token)).status).toBe(204)
    expect((await acquired(sessionOf(ben), released.id)).interruption).toBeNull()

    const stale = await freshDocument()
    const old = await acquired(sessionOf(amy), stale.id)
    await database.query(async client => client.query('UPDATE documents SET write_epoch = write_epoch + 1 WHERE id = $1', [stale.id]))
    expect(await lostReason(await renew(sessionOf(amy), stale.id, old.token))).toBe('stale')
    expect((await acquired(sessionOf(ben), stale.id)).interruption).toBeNull()
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

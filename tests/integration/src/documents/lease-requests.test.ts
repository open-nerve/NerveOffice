// 请求编辑与交出（M3-P5 设计 §3.4、§3.6，US-M3-06）：经真实的应用与数据库。请求记在租约行上（单槽、先到先得）——
// 请求方 POST 发出、等待中每 5 秒 PUT 续期（后台请求，响应就是请求的现状）、DELETE 取消；持有者经心跳得知待回应的请求，
// 谢绝（POST …/request/decline）或交出（POST …/handover）。交出把这一代记成 handed_over，编辑权留给请求方 2 分钟：期间别人申请
// （含本人接管、强制接管）得到 EDIT_LEASE_RESERVED。请求方停止续期 10 分钟、退出登录、没了编辑权，请求就作废；换了一代时
// 同一个持有者沿用请求，换了别人清掉。与时间有关的改写租约行的时间（passLeaseTime、passRequestTime），不等真实的时间；
// "恰好"的边界在单元测试里按同一个 now 核对（edit-request-rules.test.ts、edit-lease-rules.test.ts）。
// 并发的交错在 lease-request-locks.test.ts；权限的逐格预期在 permissions/edit-lease-matrix.test.ts，看不到与不存在的语句序列在
// permissions/hidden-missing-parity.test.ts，后台请求清单在 api/routes.test.ts。
import type { AcquiredEditLease, EditLeaseHeldDetails, EditLeaseLostDetails, EditRequestOutcome, EditStatus, RenewedEditLease, UserSummary } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { acquiredEditLeaseSchema, EDIT_HANDOVER_RESERVE_SECONDS, EDIT_LEASE_HEADER, EDIT_LEASE_TTL_SECONDS, EDIT_REQUEST_TTL_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema, editLeaseReservedDetailsSchema, editStatusSchema, errorResponseSchema, handedOverEditLeaseSchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, renewBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { cancelEditRequest, declineEditRequest, handOverLease, passLeaseTime, passRequestTime, pendingRequestId, renewEditRequest, requestOutcomeOf, sendEditRequest } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 团队空间的两个空间管理员（艾米、安）、三个编辑者（本、卡拉、丹）、一个查看者（维克）；外人 */
let amy: TestAccount
let ann: TestAccount
let ben: TestAccount
let cara: TestAccount
let dan: TestAccount
let vic: TestAccount
let outsider: TestAccount
let team: string
const sessions = new Map<string, LoggedIn>()

/** 建过的账户的"人"的结构（响应里的人按它核对） */
const people = new Map<string, UserSummary>()

async function account(username: string, displayName?: string): Promise<TestAccount> {
  const created = await createAccount(database, { username, ...(displayName === undefined ? {} : { displayName }) })
  people.set(created.id, { id: created.id, username, displayName: displayName ?? username })
  return created
}

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const root = await account('request-root')
  amy = await account('request-amy', '艾米')
  ann = await account('request-ann', '安')
  ben = await account('request-ben', '本')
  cara = await account('request-cara', '卡拉')
  dan = await account('request-dan', '丹')
  vic = await account('request-vic', '维克')
  outsider = await account('request-outsider')
  team = await createTeamSpace(database, { name: '请求编辑：团队', createdBy: root.id, members: { [amy.id]: 'admin', [ann.id]: 'admin', [ben.id]: 'editor', [cara.id]: 'editor', [dan.id]: 'editor', [vic.id]: 'viewer' } })
  for (const each of [amy, ann, ben, cara, dan, vic, outsider])
    sessions.set(each.id, await login(app.baseUrl, each.username, each.password))
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function sessionOf(person: TestAccount): LoggedIn {
  const session = sessions.get(person.id)
  if (session === undefined)
    throw new Error(`${person.username} 没有登录`)
  return session
}

function summaryOf(person: TestAccount): UserSummary {
  const summary = people.get(person.id)
  if (summary === undefined)
    throw new Error(`没有建过账户 ${person.username}`)
  return summary
}

/** 团队空间里的一份新文档（各个用例各用各的） */
async function freshDocument(): Promise<string> {
  return (await seedDocument(database, { spaceId: team, createdBy: amy.id, title: '请求编辑：文档' })).id
}

/** 另一个团队编辑者：会退出、被降级、被移出的用例各用各的人 */
async function freshEditor(username: string): Promise<{ readonly account: TestAccount, readonly session: LoggedIn }> {
  const editor = await account(username)
  await setMember(database, team, editor.id, 'editor')
  return { account: editor, session: await login(app.baseUrl, editor.username, editor.password) }
}

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

/** 申请：标签页默认每次一个新的，接管方式默认没有 */
async function acquire(session: LoggedIn, documentId: string, options: { readonly tab?: string, readonly takeover?: 'self' | 'force' } = {}): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'POST', body: { ...acquireBody(options.tab ?? randomUUID()), ...(options.takeover === undefined ? {} : { takeover: options.takeover }) } })
}

/** 申请成功：作为页面手里的租约（令牌、代次、标签页） */
async function holding(session: LoggedIn, documentId: string, tab: string = randomUUID(), takeover?: 'self' | 'force'): Promise<HeldLease & { readonly acquired: AcquiredEditLease }> {
  const response = await acquire(session, documentId, { tab, ...(takeover === undefined ? {} : { takeover }) })
  expect(response.status, await response.clone().text()).toBe(201)
  const acquired = parseExact(acquiredEditLeaseSchema, await response.json())
  return { token: acquired.token, writeEpoch: acquired.writeEpoch, clientInstanceId: tab, acquired }
}

/** 持有者的心跳 */
async function heartbeat(session: LoggedIn, documentId: string, lease: HeldLease): Promise<Response> {
  return asUser(app.baseUrl, session, leasePath(documentId), { method: 'PUT', body: renewBody(0), headers: { [EDIT_LEASE_HEADER]: lease.token } })
}

/** 心跳成功：新的到期时间与待回应的请求 */
async function heartbeatOk(session: LoggedIn, documentId: string, lease: HeldLease): Promise<RenewedEditLease> {
  const response = await heartbeat(session, documentId, lease)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(renewedEditLeaseSchema, await response.json())
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

async function lostOf(response: Response): Promise<EditLeaseLostDetails> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_LOST'])
  return parseExact(editLeaseLostDetailsSchema, error.details)
}

async function heldOf(response: Response): Promise<EditLeaseHeldDetails> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_HELD'])
  return parseExact(editLeaseHeldDetailsSchema, error.details)
}

/** 编辑权刚交给了别人：409 EDIT_LEASE_RESERVED，返回详情（契约逐字） */
async function reservedOf(response: Response): Promise<{ readonly reservedFor: UserSummary, readonly reservedUntil: string }> {
  const error = await errorOf(response)
  expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_RESERVED'])
  return parseExact(editLeaseReservedDetailsSchema, error.details)
}

async function send(person: TestAccount, documentId: string): Promise<EditRequestOutcome> {
  return requestOutcomeOf(await sendEditRequest(app.baseUrl, sessionOf(person), documentId))
}

async function renewRequest(person: TestAccount | LoggedIn, documentId: string): Promise<EditRequestOutcome> {
  return requestOutcomeOf(await renewEditRequest(app.baseUrl, 'cookie' in person ? person : sessionOf(person), documentId))
}

/** 交出成功：留给了谁、留到何时 */
async function handedOver(person: TestAccount, documentId: string, lease: HeldLease, requestId: string): Promise<{ readonly reservedFor: UserSummary, readonly reservedUntil: string }> {
  const response = await handOverLease(app.baseUrl, sessionOf(person), documentId, lease, requestId)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(handedOverEditLeaseSchema, await response.json())
}

/** 租约行上的请求编辑、保留与结束（直接查库），时间换成 ISO */
interface RequestRow {
  readonly holder_id: string
  readonly end_reason: string | null
  readonly ended_at: string | null
  readonly request_id: string | null
  readonly requested_by: string | null
  readonly request_session_id: string | null
  readonly requested_at: string | null
  readonly request_expires_at: string | null
  readonly request_declined_at: string | null
  readonly reserved_for: string | null
  readonly reserved_until: string | null
  readonly write_epoch: number
  readonly last_active_at: string
}

async function rowOf(documentId: string): Promise<RequestRow | undefined> {
  const row = await database.query(async client => (await client.query<Record<string, unknown>>(
    `SELECT holder_id, end_reason, ended_at, request_id, requested_by, request_session_id, requested_at, request_expires_at, request_declined_at,
       reserved_for, reserved_until, write_epoch, last_active_at FROM document_edit_leases WHERE document_id = $1`,
    [documentId],
  )).rows[0])
  if (row === undefined)
    return undefined
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value instanceof Date ? value.toISOString() : value])) as unknown as RequestRow
}

/** 这份文档上的审计（交出、请求都不写） */
async function auditsOf(documentId: string): Promise<string[]> {
  return database.query(async client => (await client.query<{ action: string }>('SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at', [documentId])).rows.map(row => row.action))
}

/** 毫秒差 */
function secondsBetween(later: string, earlier: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 1000
}

describe('US-M3-06 发出请求与持有者得知（设计 §3.6）', () => {
  it('US-M3-06 发出：别人在编辑时请求在等待（标识、发出的时刻、有效期 10 分钟、正在编辑的人）；持有者的心跳带上它（请求方的人名）；编辑状态里所有能读的人看得到，mine 只对请求方为真；被占用的详情同样带着', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const outcome = await send(ben, document)
    if (outcome.kind !== 'pending')
      throw new Error(`期望在等待，得到 ${outcome.kind}`)
    expect(outcome.holder).toEqual({ holder: summaryOf(amy), lastActiveAt: (await rowOf(document))?.last_active_at, sameUser: false, sameSession: false })
    expect(secondsBetween(outcome.expiresAt, outcome.requestedAt)).toBe(EDIT_REQUEST_TTL_SECONDS)
    expect(await rowOf(document)).toMatchObject({ request_id: outcome.id, requested_by: ben.id, requested_at: outcome.requestedAt, request_expires_at: outcome.expiresAt, request_declined_at: null })

    expect((await heartbeatOk(sessionOf(amy), document, lease)).request).toEqual({ id: outcome.id, requester: summaryOf(ben), requestedAt: outcome.requestedAt })
    for (const [who, mine] of [[vic, false], [cara, false], [amy, false], [ben, true]] as const)
      expect((await status(sessionOf(who), document)).request, who.username).toEqual({ requester: summaryOf(ben), requestedAt: outcome.requestedAt, mine })
    expect((await heldOf(await acquire(sessionOf(cara), document))).request).toEqual({ requester: summaryOf(ben), requestedAt: outcome.requestedAt, mine: false })
    expect((await heldOf(await acquire(sessionOf(ben), document))).request).toEqual({ requester: summaryOf(ben), requestedAt: outcome.requestedAt, mine: true })
  })

  it('US-M3-06 再发一次（同一个人，请求还在等）：续期，标识与发出的时刻不变；没人在请求时心跳与编辑状态里都是 null', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request).toBeNull()
    expect((await status(sessionOf(vic), document)).request).toBeNull()
    const first = await send(ben, document)
    // 一分钟过去了：再发一次把有效期从（挪过的）原值往后推至少一分钟，发出的时刻不变
    await passRequestTime(database, document, 60)
    const shifted = await rowOf(document)
    const again = await send(ben, document)
    expect(again).toMatchObject({ kind: 'pending', id: first.kind === 'pending' ? first.id : '', requestedAt: shifted?.requested_at })
    expect(again.kind === 'pending' && secondsBetween(again.expiresAt, shifted?.request_expires_at ?? '')).toBeGreaterThanOrEqual(60)
    expect((await rowOf(document))?.request_expires_at).toBe(again.kind === 'pending' ? again.expiresAt : '')
  })

  it('US-M3-06 没人在编辑时 free（不写，页面立即申请）；持有者是自己时 self（同一个浏览器的别的标签页 sameSession 为真、别的设备为假），不写', async () => {
    const document = await freshDocument()
    expect(await send(ben, document)).toEqual({ kind: 'free' })
    expect(await rowOf(document)).toBeUndefined()
    await holding(sessionOf(ben), document)
    expect(await send(ben, document)).toMatchObject({ kind: 'self', holder: { holder: summaryOf(ben), sameUser: true, sameSession: true } })
    const laptop = await login(app.baseUrl, ben.username, ben.password)
    expect(await requestOutcomeOf(await sendEditRequest(app.baseUrl, laptop, document))).toMatchObject({ kind: 'self', holder: { sameUser: true, sameSession: false } })
    expect((await rowOf(document))?.request_id).toBeNull()
    // 持有者的租约到期之后谁都能申请：free
    await passLeaseTime(database, document, EDIT_LEASE_TTL_SECONDS)
    expect(await send(cara, document)).toEqual({ kind: 'free' })
    expect((await rowOf(document))?.request_id).toBeNull()
  })

  it('US-M3-06 第二个请求方：occupied（先请求的人与时刻），不写；已谢绝、已过期的请求不占槽，被新的请求替换', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const first = await send(ben, document)
    const before = await rowOf(document)
    expect(await send(cara, document)).toEqual({ kind: 'occupied', requester: summaryOf(ben), requestedAt: first.kind === 'pending' ? first.requestedAt : '' })
    expect(await rowOf(document)).toEqual(before)

    // 已谢绝：卡拉的请求换掉它
    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, before?.request_id ?? '')).status).toBe(204)
    const second = await send(cara, document)
    expect(second.kind).toBe('pending')
    expect(await rowOf(document)).toMatchObject({ requested_by: cara.id, request_declined_at: null })
    expect(second.kind === 'pending' && second.id).not.toBe(before?.request_id)

    // 已过期（卡拉停止续期 10 分钟）：丹的请求换掉它
    await passRequestTime(database, document, EDIT_REQUEST_TTL_SECONDS)
    expect(await send(dan, document)).toMatchObject({ kind: 'pending' })
    expect((await rowOf(document))?.requested_by).toBe(dan.id)
  })

  it('US-M3-06 旧页面不能发请求（CLIENT_OUTDATED，什么也不写）；只能查看的 403、看不到的 404', async () => {
    const document = await freshDocument()
    await holding(sessionOf(amy), document)
    const outdated = await errorOf(await sendEditRequest(app.baseUrl, sessionOf(ben), document, {}))
    expect(outdated).toMatchObject({ status: 409, code: 'CLIENT_OUTDATED', details: { reason: 'format' } })
    expect((await errorOf(await sendEditRequest(app.baseUrl, sessionOf(vic), document))).status).toBe(403)
    expect((await errorOf(await sendEditRequest(app.baseUrl, sessionOf(outsider), document))).status).toBe(404)
    expect((await rowOf(document))?.request_id).toBeNull()
  })

  it('US-M3-06 请求体与令牌按契约校验：发出多出字段、谢绝与交出的 requestId 不是 UUID 或缺了、多出字段、令牌格式不对——400，什么也不写', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    const before = await rowOf(document)
    const invalid: readonly (readonly [string, Promise<Response>])[] = [
      ['发出多出字段', asUser(app.baseUrl, sessionOf(cara), `${leasePath(document)}/request`, { method: 'POST', body: { requestId } })],
      ['谢绝的 requestId 不是 UUID', asUser(app.baseUrl, sessionOf(amy), `${leasePath(document)}/request/decline`, { method: 'POST', body: { requestId: 'x' }, headers: { [EDIT_LEASE_HEADER]: lease.token } })],
      ['谢绝缺 requestId', asUser(app.baseUrl, sessionOf(amy), `${leasePath(document)}/request/decline`, { method: 'POST', body: {}, headers: { [EDIT_LEASE_HEADER]: lease.token } })],
      ['交出多出字段', asUser(app.baseUrl, sessionOf(amy), `${leasePath(document)}/handover`, { method: 'POST', body: { requestId, force: true }, headers: { [EDIT_LEASE_HEADER]: lease.token } })],
      ['交出的令牌格式不对', asUser(app.baseUrl, sessionOf(amy), `${leasePath(document)}/handover`, { method: 'POST', body: { requestId }, headers: { [EDIT_LEASE_HEADER]: 'short' } })],
    ]
    for (const [name, pending] of invalid)
      expect(await errorOf(await pending), name).toMatchObject({ status: 400, code: 'REQUEST_INVALID' })
    expect(await rowOf(document)).toEqual(before)
  })
})

describe('US-M3-06 谢绝与取消（设计 §3.6）', () => {
  it('US-M3-06 谢绝：204；请求方下一次续期得到 declined（请求的标识与谢绝的人），不续期；心跳不再带，编辑状态里没有；请求方显式再点一次换成新的请求', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, requestId)).status).toBe(204)
    const declined = await rowOf(document)
    expect(declined?.request_declined_at).not.toBeNull()
    expect(await renewRequest(ben, document)).toEqual({ kind: 'declined', id: requestId, holder: { holder: summaryOf(amy), lastActiveAt: declined?.last_active_at, sameUser: false, sameSession: false } })
    expect(await rowOf(document)).toEqual(declined)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request).toBeNull()
    expect((await status(sessionOf(ben), document)).request).toBeNull()
    const again = await send(ben, document)
    expect(again.kind === 'pending' && again.id).not.toBe(requestId)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request?.requester).toEqual(summaryOf(ben))
  })

  it('US-M3-06 谢绝的标识对不上、已经谢绝过：204，什么也不做（谢绝的时刻不变）', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, randomUUID())).status).toBe(204)
    expect((await rowOf(document))?.request_declined_at).toBeNull()
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request?.id).toBe(requestId)
    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, requestId)).status).toBe(204)
    const declined = await rowOf(document)
    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, requestId)).status).toBe(204)
    expect(await rowOf(document)).toEqual(declined)
  })

  it('US-M3-06 取消：204；心跳不再带、编辑状态里没有，请求方续期得到 gone；再取消、别人的取消都是 204、什么也不做', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    expect((await cancelEditRequest(app.baseUrl, sessionOf(cara), document)).status).toBe(204)
    expect((await rowOf(document))?.requested_by).toBe(ben.id)
    expect((await cancelEditRequest(app.baseUrl, sessionOf(ben), document)).status).toBe(204)
    expect(await rowOf(document)).toMatchObject({ request_id: null, requested_by: null, request_session_id: null, requested_at: null, request_expires_at: null, request_declined_at: null })
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request).toBeNull()
    expect((await status(sessionOf(vic), document)).request).toBeNull()
    expect(await renewRequest(ben, document)).toMatchObject({ kind: 'gone', holder: { holder: summaryOf(amy) } })
    expect((await cancelEditRequest(app.baseUrl, sessionOf(ben), document)).status).toBe(204)
    // 查看者能取消（能读就行），看不到的 404
    expect((await cancelEditRequest(app.baseUrl, sessionOf(vic), document)).status).toBe(204)
    expect((await errorOf(await cancelEditRequest(app.baseUrl, sessionOf(outsider), document))).status).toBe(404)
  })

  it('US-M3-06 取消也清掉留给自己的保留：交出之后请求方取消，交出的记录留着，别人随即能申请', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    await handedOver(amy, document, lease, await pendingRequestId(app.baseUrl, sessionOf(ben), document))
    await reservedOf(await acquire(sessionOf(cara), document))
    expect((await cancelEditRequest(app.baseUrl, sessionOf(cara), document)).status).toBe(204)
    expect((await rowOf(document))?.reserved_for).toBe(ben.id)
    expect((await cancelEditRequest(app.baseUrl, sessionOf(ben), document)).status).toBe(204)
    expect(await rowOf(document)).toMatchObject({ end_reason: 'handed_over', reserved_for: null, reserved_until: null })
    expect((await status(sessionOf(vic), document)).reservation).toBeNull()
    // 请求早已转成保留、保留又清掉了：请求方的续期得到 gone（没人在编辑）
    expect(await renewRequest(ben, document)).toEqual({ kind: 'gone', holder: null })
    expect((await holding(sessionOf(cara), document)).acquired.interruption).toBeNull()
  })
})

describe('US-M3-06 交出与保留（设计 §3.6）', () => {
  it('US-M3-06 交出：200，留给请求方 2 分钟；一条语句里记下 handed_over、保留、清掉请求；持有者的心跳得到 handed_over，请求方续期得到 reserved，编辑状态里有保留（mine 只对请求方为真）、没人在编辑、没有提醒', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    const handed = await handedOver(amy, document, lease, requestId)
    const row = await rowOf(document)
    expect(handed).toEqual({ reservedFor: summaryOf(ben), reservedUntil: row?.reserved_until })
    expect(row).toMatchObject({ holder_id: amy.id, end_reason: 'handed_over', reserved_for: ben.id, request_id: null, requested_by: null, request_session_id: null, requested_at: null, request_expires_at: null, request_declined_at: null })
    expect(secondsBetween(row?.reserved_until ?? '', row?.ended_at ?? '')).toBe(EDIT_HANDOVER_RESERVE_SECONDS)

    expect(await lostOf(await heartbeat(sessionOf(amy), document, lease))).toEqual({ reason: 'handed_over' })
    expect(await renewRequest(ben, document)).toEqual({ kind: 'reserved', reservedUntil: handed.reservedUntil })
    expect(await status(sessionOf(vic), document)).toMatchObject({ editor: null, request: null, reservation: { reservedFor: summaryOf(ben), reservedUntil: handed.reservedUntil, mine: false }, interruption: null })
    expect((await status(sessionOf(ben), document)).reservation?.mine).toBe(true)
    // 请求方再发出请求：reserved；别人发出：reservedForOther
    expect(await send(ben, document)).toEqual({ kind: 'reserved', reservedUntil: handed.reservedUntil })
    expect(await send(cara, document)).toEqual({ kind: 'reservedForOther', reservedFor: summaryOf(ben), reservedUntil: handed.reservedUntil })
    expect(await rowOf(document)).toEqual(row)
  })

  it('US-M3-06 保留期内除了请求方一律 EDIT_LEASE_RESERVED（详情是留给谁、到何时）：第三人、交出的人自己、本人接管、空间管理员的强制接管都被挡，什么也不写；请求方用另一台设备申请照样取得，没有提醒，保留清掉', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const handed = await handedOver(amy, document, lease, await pendingRequestId(app.baseUrl, sessionOf(ben), document))
    const before = await rowOf(document)
    for (const [name, response] of [
      ['第三人', await acquire(sessionOf(cara), document)],
      ['交出的人自己', await acquire(sessionOf(amy), document)],
      ['交出的人本人接管', await acquire(sessionOf(amy), document, { takeover: 'self' })],
      ['空间管理员强制接管', await acquire(sessionOf(ann), document, { takeover: 'force' })],
    ] as const)
      expect(await reservedOf(response), name).toEqual(handed)
    expect(await rowOf(document)).toEqual(before)
    expect(await auditsOf(document)).toEqual([])

    const laptop = await login(app.baseUrl, ben.username, ben.password)
    const tab = randomUUID()
    const response = await asUser(app.baseUrl, laptop, leasePath(document), { method: 'POST', body: acquireBody(tab) })
    expect(response.status, await response.clone().text()).toBe(201)
    expect(parseExact(acquiredEditLeaseSchema, await response.json())).toMatchObject({ writeEpoch: lease.writeEpoch + 1, interruption: null })
    expect(await rowOf(document)).toMatchObject({ holder_id: ben.id, end_reason: null, reserved_for: null, reserved_until: null })
    // 交出与请求都不写审计
    expect(await auditsOf(document)).toEqual([])
  })

  it('US-M3-06 保留到期之后（挪时间）第三人能申请，没有提醒（交出是明确结束）；被保留的人没了编辑权时保留同样不再挡', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    await handedOver(amy, document, lease, await pendingRequestId(app.baseUrl, sessionOf(ben), document))
    await passLeaseTime(database, document, EDIT_HANDOVER_RESERVE_SECONDS)
    expect((await status(sessionOf(vic), document)).reservation).toBeNull()
    expect((await holding(sessionOf(cara), document)).acquired.interruption).toBeNull()

    const { account: eve, session } = await freshEditor('request-eve')
    const other = await freshDocument()
    const lease2 = await holding(sessionOf(amy), other)
    await handedOver(amy, other, lease2, await pendingRequestId(app.baseUrl, session, other))
    await reservedOf(await acquire(sessionOf(cara), other))
    await setMember(database, team, eve.id, 'viewer')
    expect((await status(sessionOf(vic), other)).reservation).toBeNull()
    await holding(sessionOf(cara), other)
  })

  it('US-M3-06 交出时请求已不在——标识对不上、请求方取消了、持有者谢绝过：EDIT_REQUEST_GONE，租约不动（心跳照常续租）', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    const before = await rowOf(document)
    expect(await errorOf(await handOverLease(app.baseUrl, sessionOf(amy), document, lease, randomUUID()))).toMatchObject({ status: 409, code: 'EDIT_REQUEST_GONE' })
    expect(await rowOf(document)).toEqual(before)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request?.id).toBe(requestId)

    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, requestId)).status).toBe(204)
    expect((await errorOf(await handOverLease(app.baseUrl, sessionOf(amy), document, lease, requestId))).code).toBe('EDIT_REQUEST_GONE')
    const again = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    expect((await cancelEditRequest(app.baseUrl, sessionOf(ben), document)).status).toBe(204)
    expect((await errorOf(await handOverLease(app.baseUrl, sessionOf(amy), document, lease, again))).code).toBe('EDIT_REQUEST_GONE')
    expect(await rowOf(document)).toMatchObject({ holder_id: amy.id, end_reason: null, reserved_for: null })
    await heartbeatOk(sessionOf(amy), document, lease)
  })

  it('US-M3-06 交出的回包丢了再交出：EDIT_LEASE_LOST（handed_over），保留不变；释放也不动它', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    await handedOver(amy, document, lease, requestId)
    const after = await rowOf(document)
    expect(await lostOf(await handOverLease(app.baseUrl, sessionOf(amy), document, lease, requestId))).toEqual({ reason: 'handed_over' })
    expect(await lostOf(await declineEditRequest(app.baseUrl, sessionOf(amy), document, lease, requestId))).toEqual({ reason: 'handed_over' })
    expect((await asUser(app.baseUrl, sessionOf(amy), leasePath(document), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: lease.token } })).status).toBe(204)
    expect(await rowOf(document)).toEqual(after)
  })

  it('US-M3-06 交出与谢绝遇到被接管的那一代：taken_over（强制接管 forced: true，本人在别处接手 forced: false），什么也不写', async () => {
    const forced = await freshDocument()
    const lease = await holding(sessionOf(amy), forced)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), forced)
    // 安（空间管理员）强制接管艾米：请求换了别人，清掉
    await holding(sessionOf(ann), forced, randomUUID(), 'force')
    expect(await lostOf(await declineEditRequest(app.baseUrl, sessionOf(amy), forced, lease, requestId))).toEqual({ reason: 'taken_over', forced: true })
    expect(await lostOf(await handOverLease(app.baseUrl, sessionOf(amy), forced, lease, requestId))).toEqual({ reason: 'taken_over', forced: true })
    expect(await rowOf(forced)).toMatchObject({ holder_id: ann.id, end_reason: null, request_id: null, reserved_for: null })

    const self = await freshDocument()
    const desk = await holding(sessionOf(cara), self)
    const pending = await pendingRequestId(app.baseUrl, sessionOf(ben), self)
    const laptop = await login(app.baseUrl, cara.username, cara.password)
    const laptopTab = randomUUID()
    const taken = await asUser(app.baseUrl, laptop, leasePath(self), { method: 'POST', body: { ...acquireBody(laptopTab), takeover: 'self' } })
    expect(taken.status, await taken.clone().text()).toBe(201)
    expect(await lostOf(await declineEditRequest(app.baseUrl, sessionOf(cara), self, desk, pending))).toEqual({ reason: 'taken_over', forced: false })
    expect(await lostOf(await handOverLease(app.baseUrl, sessionOf(cara), self, desk, pending))).toEqual({ reason: 'taken_over', forced: false })
    // 本人接管是同一个持有者：请求沿用，没有交出
    expect(await rowOf(self)).toMatchObject({ holder_id: cara.id, end_reason: null, request_id: pending, reserved_for: null })
  })

  it('US-M3-06 谢绝、交出要能编辑：查看者 403、看不到的 404（在租约之前）；持有者被降为查看者之后 403，不是 EDIT_LEASE_LOST', async () => {
    const document = await freshDocument()
    const { account: gus, session } = await freshEditor('request-gus')
    const lease = await holding(session, document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    for (const [who, code] of [[vic, 403], [outsider, 404]] as const) {
      expect((await errorOf(await declineEditRequest(app.baseUrl, sessionOf(who), document, lease, requestId))).status, who.username).toBe(code)
      expect((await errorOf(await handOverLease(app.baseUrl, sessionOf(who), document, lease, requestId))).status, who.username).toBe(code)
    }
    await setMember(database, team, gus.id, 'viewer')
    expect(await errorOf(await handOverLease(app.baseUrl, session, document, lease, requestId))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(await errorOf(await declineEditRequest(app.baseUrl, session, document, lease, requestId))).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect((await rowOf(document))?.requested_by).toBe(ben.id)
  })
})

describe('US-M3-06 请求的失效与沿用（设计 §3.6）', () => {
  it('US-M3-06 请求方停止续期 10 分钟就失效（只挪请求的时间，持有者照常编辑）：心跳不再带、编辑状态里没有，交出得到 EDIT_REQUEST_GONE（租约不动），请求方续期得到 gone；续期一次就再撑 10 分钟', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    await passRequestTime(database, document, EDIT_REQUEST_TTL_SECONDS - 10)
    const renewed = await renewRequest(ben, document)
    expect(renewed).toMatchObject({ kind: 'pending', id: requestId })
    const row = await rowOf(document)
    expect(renewed.kind === 'pending' && renewed.expiresAt).toBe(row?.request_expires_at)
    // 续期把有效期推到续期那一刻之后 10 分钟：再过 20 秒（没有续期就过期了）请求照样在
    await passRequestTime(database, document, 20)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request?.id).toBe(requestId)

    await passRequestTime(database, document, EDIT_REQUEST_TTL_SECONDS)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request).toBeNull()
    expect((await status(sessionOf(vic), document)).request).toBeNull()
    const before = await rowOf(document)
    expect((await errorOf(await handOverLease(app.baseUrl, sessionOf(amy), document, lease, requestId))).code).toBe('EDIT_REQUEST_GONE')
    expect(await rowOf(document)).toEqual(before)
    expect(await renewRequest(ben, document)).toMatchObject({ kind: 'gone', holder: { holder: summaryOf(amy) } })
    expect(await rowOf(document)).toEqual(before)
  })

  it('US-M3-06 续期时槽里已经是别人的请求（自己的过期了、被别人的新请求换掉）：gone，不续别人的请求——有效期不变，持有者照样收到那个人的（M3-P5 审查 A5）', async () => {
    const document = await freshDocument()
    const lease = await holding(sessionOf(amy), document)
    await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    await passRequestTime(database, document, EDIT_REQUEST_TTL_SECONDS)
    const caras = await send(cara, document)
    if (caras.kind !== 'pending')
      throw new Error(`期望卡拉的请求在等待，得到 ${caras.kind}`)
    const before = await rowOf(document)
    expect(await renewRequest(ben, document)).toMatchObject({ kind: 'gone', holder: { holder: summaryOf(amy) } })
    expect(await rowOf(document)).toEqual(before)
    expect((await heartbeatOk(sessionOf(amy), document, lease)).request).toEqual({ id: caras.id, requester: summaryOf(cara), requestedAt: caras.requestedAt })
  })

  it('US-M3-06 请求方退出登录、被降级、被移出空间：请求作废——心跳不再带，交出得到 EDIT_REQUEST_GONE；请求方的续期 401 / 403 / 404', async () => {
    const cases = [
      ['退出登录', async (_account: TestAccount, session: LoggedIn) => expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204), 401],
      ['被降为查看者', async (requester: TestAccount) => setMember(database, team, requester.id, 'viewer'), 403],
      ['被移出空间', async (requester: TestAccount) => setMember(database, team, requester.id, undefined), 404],
    ] as const
    for (const [name, spoil, renewal] of cases) {
      const { account: requester, session } = await freshEditor(`request-spoiled-${renewal}`)
      const document = await freshDocument()
      const lease = await holding(sessionOf(amy), document)
      const requestId = await pendingRequestId(app.baseUrl, session, document)
      expect((await heartbeatOk(sessionOf(amy), document, lease)).request?.id, name).toBe(requestId)
      await spoil(requester, session)
      expect((await heartbeatOk(sessionOf(amy), document, lease)).request, name).toBeNull()
      expect((await status(sessionOf(vic), document)).request, name).toBeNull()
      expect((await errorOf(await handOverLease(app.baseUrl, sessionOf(amy), document, lease, requestId))).code, name).toBe('EDIT_REQUEST_GONE')
      expect((await renewEditRequest(app.baseUrl, session, document)).status, name).toBe(renewal)
      // 别人随即能发出新的请求（作废的不占槽）
      expect((await send(cara, document)).kind, name).toBe('pending')
    }
  })

  it('US-M3-06 持有者自己的新一代沿用请求（含已谢绝的状态）：同一个页面重试、本人接管、到期之后在别的标签页续上；请求方续期照常得到 pending', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    const first = await holding(sessionOf(amy), document, tab)
    const requestId = await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    const retried = await holding(sessionOf(amy), document, tab)
    expect((await heartbeatOk(sessionOf(amy), document, retried)).request?.id).toBe(requestId)
    expect(await lostOf(await heartbeat(sessionOf(amy), document, first))).toEqual({ reason: 'replaced' })
    const laptop = await login(app.baseUrl, amy.username, amy.password)
    const takenTab = randomUUID()
    const taken = await asUser(app.baseUrl, laptop, leasePath(document), { method: 'POST', body: { ...acquireBody(takenTab), takeover: 'self' } })
    expect(taken.status, await taken.clone().text()).toBe(201)
    const takenLease: HeldLease = { token: parseExact(acquiredEditLeaseSchema, await taken.json()).token, writeEpoch: 0, clientInstanceId: takenTab }
    expect((await heartbeatOk(laptop, document, takenLease)).request?.id).toBe(requestId)
    await passLeaseTime(database, document, EDIT_LEASE_TTL_SECONDS)
    const resumed = await holding(sessionOf(amy), document)
    expect((await heartbeatOk(sessionOf(amy), document, resumed)).request?.id).toBe(requestId)
    expect(await renewRequest(ben, document)).toMatchObject({ kind: 'pending', id: requestId })

    // 已谢绝的状态同样沿用：到期之后在别的标签页续上，请求方续期仍得到 declined
    expect((await declineEditRequest(app.baseUrl, sessionOf(amy), document, resumed, requestId)).status).toBe(204)
    await passLeaseTime(database, document, EDIT_LEASE_TTL_SECONDS)
    await holding(sessionOf(amy), document)
    expect(await renewRequest(ben, document)).toMatchObject({ kind: 'declined', id: requestId })
  })

  it('US-M3-06 换了别人的一代：请求清掉，请求方续期得到 gone（现在正在编辑的人）；请求方自己拿到编辑权：请求已经实现，清掉', async () => {
    const document = await freshDocument()
    await holding(sessionOf(amy), document)
    await pendingRequestId(app.baseUrl, sessionOf(ben), document)
    await passLeaseTime(database, document, EDIT_LEASE_TTL_SECONDS)
    // 到期之后请求方的续期：没人在编辑，free（照样续期）
    expect(await renewRequest(ben, document)).toEqual({ kind: 'free' })
    await holding(sessionOf(cara), document)
    expect((await rowOf(document))?.request_id).toBeNull()
    expect(await renewRequest(ben, document)).toMatchObject({ kind: 'gone', holder: { holder: summaryOf(cara), sameUser: false } })

    const fulfilled = await freshDocument()
    const lease = await holding(sessionOf(amy), fulfilled)
    await pendingRequestId(app.baseUrl, sessionOf(ben), fulfilled)
    expect((await asUser(app.baseUrl, sessionOf(amy), leasePath(fulfilled), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: lease.token } })).status).toBe(204)
    expect(await renewRequest(ben, fulfilled)).toEqual({ kind: 'free' })
    await holding(sessionOf(ben), fulfilled)
    expect(await rowOf(fulfilled)).toMatchObject({ holder_id: ben.id, request_id: null, requested_by: null })
    expect(await renewRequest(ben, fulfilled)).toMatchObject({ kind: 'gone', holder: { holder: summaryOf(ben), sameUser: true } })
  })

  it('US-M3-06 请求方的续期要能编辑：没了编辑权 403；没有请求时 gone（不新建）', async () => {
    const document = await freshDocument()
    expect(await renewRequest(ben, document)).toEqual({ kind: 'gone', holder: null })
    expect(await rowOf(document)).toBeUndefined()
    expect((await errorOf(await renewEditRequest(app.baseUrl, sessionOf(vic), document))).status).toBe(403)
    expect((await errorOf(await renewEditRequest(app.baseUrl, sessionOf(outsider), document))).status).toBe(404)
  })
})

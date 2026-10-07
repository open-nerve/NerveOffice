// 请求编辑与交出的确定交错（M3-P5 设计 §3.12）：两个连接构造。请求的发出、续期、取消、谢绝与交出都只锁租约行（与心跳、释放同一类），
// 锁住之后再读文档的代次；申请（含本人接管、强制接管）先锁文档行、再锁租约行，强制接管的审计排在最后（锁的顺序：文档行 → 租约行 → 审计，
// ADR-014）。所以它们都在租约行上排队，后到的在锁下看到先到的提交之后的那一行——
// 1. 交出与请求方取消：交出先，保留给了请求方，取消随后清掉保留（第三人随即能申请）；取消先，交出得到 EDIT_REQUEST_GONE，租约不动；
// 2. 交出与第三人申请：交出先，申请得到 EDIT_LEASE_RESERVED；申请先，仍被持有（EDIT_LEASE_HELD，详情带着那个请求），交出随后照常；
// 3. 两个请求方同时发出：先到的写下请求，后到的 occupied（单槽、先到先得）；
// 4. 请求方续期与持有者自己的新一代（同一个页面的重试、本人接管）：两种先后请求都沿用——沿用的读与写都在租约行的锁下；
// 5. 请求方续期与第三人在到期之后申请：续期先，得到 free（照样续期），随后申请的一方取得、请求清掉；申请先，续期得到 gone；
// 6. 谢绝与取消：两种先后都终止于"槽里没有请求"，都是 204；
// 7. 接管与交出：交出先，保留给了请求方，接管（本人、强制）得到 EDIT_LEASE_RESERVED；接管先，交出得到 taken_over（带方式），没有保留。
// 写法照搬 lease-takeover-locks.test.ts：测试持住租约行，让几个请求依次停在上面（inOrder）；或者"先取完锁的操作"停在写审计之前
// （闸门：audit_events 的 BEFORE INSERT 触发器按"动作 + 操作者"取 advisory 共享锁，测试的连接持有同一个键的排他锁，interleave）。
// 持锁构造的前提由 held-lock.ts 自己核对。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { EDIT_LEASE_TTL_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema, editLeaseReservedDetailsSchema, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, cancelEditRequest, declineEditRequest, handOverLease, passLeaseTime, pendingRequestId, renewEditRequest, requestOutcomeOf, sendEditRequest } from '../support/edit-leases.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let people = 0
let spaces = 0

/** 闸门：每写一条审计之前，按"动作 + 操作者"取一把共享的 advisory lock；测试持有同一个键的排他锁时，那个操作停在这里 */
const GATE_DDL = `
CREATE FUNCTION audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('audit-gate:' || NEW.action || ':' || coalesce(NEW.actor_id::text, 'system'), 0));
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_gate();
`

beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(GATE_DDL))
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'request-locks-root', systemRole: 'admin' })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

interface Person {
  readonly account: TestAccount
  readonly session: LoggedIn
}

/** 一个团队空间里的一份文档：空间管理员艾米（正在编辑）、空间管理员安（强制接管用）、三个编辑者本、卡拉（请求方）与丹（第三人），各个用例各用各的人 */
interface Prepared {
  readonly document: string
  readonly amy: Person
  readonly ann: Person
  readonly ben: Person
  readonly cara: Person
  readonly dan: Person
  /** 艾米申请到的租约（同一个页面：令牌、代次与标签页） */
  readonly lease: HeldLease
}

async function person(): Promise<Person> {
  people += 1
  const account = await createAccount(database, { username: `request-locks-${people}` })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

async function prepare(): Promise<Prepared> {
  const [amy, ann, ben, cara, dan] = [await person(), await person(), await person(), await person(), await person()]
  spaces += 1
  const space = await createTeamSpace(database, {
    name: `请求编辑与交错 ${spaces}`,
    createdBy: root.id,
    members: { [amy.account.id]: 'admin', [ann.account.id]: 'admin', [ben.account.id]: 'editor', [cara.account.id]: 'editor', [dan.account.id]: 'editor' },
  })
  const document = (await seedDocument(database, { spaceId: space, createdBy: amy.account.id, title: '请求编辑与交错' })).id
  return { document, amy, ann, ben, cara, dan, lease: await acquireLease(app.baseUrl, amy.session, document) }
}

/** 以这个人申请：标签页（默认每次一个新的）与接管方式 */
async function acquire(who: Person, documentId: string, options: { readonly tab?: string, readonly takeover?: 'self' | 'force' } = {}): Promise<Response> {
  return asUser(app.baseUrl, who.session, `/api/documents/${documentId}/edit-lease`, { method: 'POST', body: { ...acquireBody(options.tab ?? randomUUID()), ...(options.takeover === undefined ? {} : { takeover: options.takeover }) } })
}

/** 一次请求的错误：状态码、错误码与详情 */
async function errorOf(response: Response): Promise<{ readonly status: number, readonly code: string, readonly details: Record<string, unknown> | undefined }> {
  const { error } = parseExact(errorResponseSchema, await response.json())
  return { status: response.status, code: error.code, details: error.details }
}

/** 租约行上的持有者、明确结束、请求与保留；文档现在的代次 */
async function rowOf(documentId: string): Promise<{ readonly holderId: string, readonly endReason: string | null, readonly requestId: string | null, readonly requestedBy: string | null, readonly declined: boolean, readonly reservedFor: string | null, readonly expiresAt: Date | null } | undefined> {
  return database.query(async client => (await client.query<{ holderId: string, endReason: string | null, requestId: string | null, requestedBy: string | null, declined: boolean, reservedFor: string | null, expiresAt: Date | null }>(
    `SELECT holder_id AS "holderId", end_reason AS "endReason", request_id AS "requestId", requested_by AS "requestedBy",
       request_declined_at IS NOT NULL AS declined, reserved_for AS "reservedFor", request_expires_at AS "expiresAt"
     FROM document_edit_leases WHERE document_id = $1`,
    [documentId],
  )).rows[0])
}

/** 在持锁的事务里关上这个操作的闸门 */
function holdGate(action: string, actorId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}:${actorId}`])
}

/** 在持锁的事务里锁住这份文档的租约行（申请、接管、心跳、释放，请求编辑的发出、续期、取消、谢绝与交出都要锁它） */
function holdLeaseRow(documentId: string) {
  return async (client: pg.Client) => {
    const locked = await client.query('SELECT 1 FROM document_edit_leases WHERE document_id = $1 FOR UPDATE', [documentId])
    if (locked.rowCount !== 1)
      throw new Error(`持锁的前提不成立：${documentId} 没有租约行`)
  }
}

/** 先取完锁的那个操作：它的审计动作与操作者（闸门的键），以及怎么发出它 */
interface Gated {
  readonly action: string
  readonly actorId: string
  readonly run: () => Promise<Response>
}

/** first 取完全部的锁、停在写审计之前；这时发出 second，看它是否等待；放开 first，两边都结束 */
async function interleave(first: Gated, second: () => Promise<Response>): Promise<{ first: Response, second: Response, secondWaited: boolean }> {
  let pending: Promise<Response> | undefined
  let completed: boolean | undefined
  const firstResponse = await raceAgainstHeldLock(database, {
    hold: holdGate(first.action, first.actorId),
    request: async () => first.run(),
    change: async () => {
      pending = second()
      completed = await completesWithoutWaiting(database, pending, 2)
    },
  })
  if (pending === undefined)
    throw new Error('第二个请求没有发出')
  return { first: firstResponse, second: await pending, secondWaited: completed === false }
}

/**
 * 测试持住 held 的那把锁，first、second 依次停在锁上（second 排在 first 后面），放开之后按先后进行。
 * 等 first 停在锁上再发 second；等两个都停在锁上由 raceAgainstHeldLock 自己做（waiting: 2，与 edit-leases.test.ts 的 raceTwoAcquires
 * 同一个写法）——这里不能再等一次：两处各自轮询，外面那一处先看到就提交了，里面这一处之后只看得到已经结束的请求，误报前提不成立
 */
async function inOrder(hold: (client: pg.Client) => Promise<unknown>, first: () => Promise<Response>, second: () => Promise<Response>): Promise<[Response, Response]> {
  return raceAgainstHeldLock(database, {
    hold,
    request: async ({ step, waitForWaiting }) => {
      const a = step(first())
      await waitForWaiting(1)
      const b = step(second())
      return Promise.all([a, b])
    },
    change: async () => undefined,
    waiting: 2,
  })
}

describe('US-M3-06 交出与请求方取消在租约行上排队（设计 §3.12）', () => {
  it('US-M3-06 交出先拿到租约行：编辑权留给了请求方；取消排在后面，清掉留给他的保留（交出的记录留着）——第三人随即能申请', async () => {
    const { document, amy, ben, dan, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [handed, cancelled] = await inOrder(holdLeaseRow(document), async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId), async () => cancelEditRequest(app.baseUrl, ben.session, document))
    expect([handed.status, cancelled.status]).toEqual([200, 204])
    expect(await rowOf(document)).toMatchObject({ holderId: amy.account.id, endReason: 'handed_over', requestId: null, reservedFor: null })
    expect((await acquire(dan, document)).status).toBe(201)
  })

  it('US-M3-06 取消先拿到租约行：请求清掉；交出排在后面，锁下看到请求已不在——EDIT_REQUEST_GONE，租约不动（持有者留在编辑）', async () => {
    const { document, amy, ben, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [cancelled, handed] = await inOrder(holdLeaseRow(document), async () => cancelEditRequest(app.baseUrl, ben.session, document), async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId))
    expect(cancelled.status).toBe(204)
    expect(await errorOf(handed)).toMatchObject({ status: 409, code: 'EDIT_REQUEST_GONE' })
    expect(await rowOf(document)).toMatchObject({ holderId: amy.account.id, endReason: null, requestId: null, reservedFor: null })
  })
})

describe('US-M3-06 交出与第三人申请（设计 §3.12）', () => {
  it('US-M3-06 交出先拿到租约行；第三人的申请（已经锁住了文档行）排在后面——锁下看到交出与保留：EDIT_LEASE_RESERVED（留给请求方），什么也没写', async () => {
    const { document, amy, ben, dan, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [handed, acquired] = await inOrder(holdLeaseRow(document), async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId), async () => acquire(dan, document))
    expect(handed.status).toBe(200)
    const error = await errorOf(acquired)
    expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_RESERVED'])
    expect(parseExact(editLeaseReservedDetailsSchema, error.details).reservedFor.id).toBe(ben.account.id)
    expect(await rowOf(document)).toMatchObject({ holderId: amy.account.id, endReason: 'handed_over', reservedFor: ben.account.id })
  })

  it('US-M3-06 第三人的申请先拿到租约行：仍被持有（EDIT_LEASE_HELD，详情带着那个请求）；交出排在后面，照常交出', async () => {
    const { document, amy, ben, dan, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [acquired, handed] = await inOrder(holdLeaseRow(document), async () => acquire(dan, document), async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId))
    const error = await errorOf(acquired)
    expect([error.status, error.code]).toEqual([409, 'EDIT_LEASE_HELD'])
    expect(parseExact(editLeaseHeldDetailsSchema, error.details)).toMatchObject({ holder: { id: amy.account.id }, request: { requester: { id: ben.account.id }, mine: false } })
    expect(handed.status).toBe(200)
    expect(await rowOf(document)).toMatchObject({ endReason: 'handed_over', reservedFor: ben.account.id })
  })
})

describe('US-M3-06 两个请求方同时发出（设计 §3.12）', () => {
  it('US-M3-06 测试持住租约行，本、卡拉依次停在锁上：先到的写下请求（在等待），后到的锁下看到它——occupied（先请求的人），没有覆盖', async () => {
    const { document, ben, cara } = await prepare()
    const [first, second] = await inOrder(holdLeaseRow(document), async () => sendEditRequest(app.baseUrl, ben.session, document), async () => sendEditRequest(app.baseUrl, cara.session, document))
    const pending = await requestOutcomeOf(first)
    expect(pending.kind).toBe('pending')
    expect(await requestOutcomeOf(second)).toMatchObject({ kind: 'occupied', requester: { id: ben.account.id }, requestedAt: pending.kind === 'pending' ? pending.requestedAt : '' })
    expect(await rowOf(document)).toMatchObject({ requestId: pending.kind === 'pending' ? pending.id : '', requestedBy: ben.account.id })
  })
})

/** 持有者自己的一代新的：同一个页面重试（同一个登录、同一个标签页），或者本人接管（另一台设备） */
interface OwnGeneration {
  readonly name: string
  readonly run: (prepared: Prepared, laptop: LoggedIn) => Promise<Response>
}

const OWN_GENERATIONS: readonly OwnGeneration[] = [
  { name: '同一个页面重试', run: async ({ document, amy, lease }) => acquire(amy, document, { tab: lease.clientInstanceId }) },
  { name: '本人接管（另一台设备）', run: async ({ document, amy }, laptop) => acquire({ account: amy.account, session: laptop }, document, { takeover: 'self' }) },
]

describe('US-M3-06 请求方续期与持有者自己的新一代（设计 §3.12）：两种先后请求都沿用', () => {
  it.each(OWN_GENERATIONS)('US-M3-06 续期先拿到租约行，持有者的新一代（$name，已经锁住了文档行）排在后面：续期照常（有效期往后推），新的一代沿用请求', async (generation) => {
    const prepared = await prepare()
    const { document, amy, ben } = prepared
    const laptop = await login(app.baseUrl, amy.account.username, amy.account.password)
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    await passLeaseTime(database, document, 60)
    const before = await rowOf(document)
    const [renewed, generated] = await inOrder(holdLeaseRow(document), async () => renewEditRequest(app.baseUrl, ben.session, document), async () => generation.run(prepared, laptop))
    expect(await requestOutcomeOf(renewed)).toMatchObject({ kind: 'pending', id: requestId, holder: { holder: { id: amy.account.id } } })
    expect(generated.status, await generated.clone().text()).toBe(201)
    const after = await rowOf(document)
    expect(after).toMatchObject({ holderId: amy.account.id, requestId, requestedBy: ben.account.id, declined: false })
    expect((after?.expiresAt?.getTime() ?? 0) - (before?.expiresAt?.getTime() ?? 0)).toBeGreaterThanOrEqual(60_000)
  })

  it.each(OWN_GENERATIONS)('US-M3-06 持有者的新一代（$name）先拿到租约行，续期排在后面：锁下看到新的一代（还是同一个持有者）——请求沿用，续期照常', async (generation) => {
    const prepared = await prepare()
    const { document, amy, ben } = prepared
    const laptop = await login(app.baseUrl, amy.account.username, amy.account.password)
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [generated, renewed] = await inOrder(holdLeaseRow(document), async () => generation.run(prepared, laptop), async () => renewEditRequest(app.baseUrl, ben.session, document))
    expect(generated.status, await generated.clone().text()).toBe(201)
    expect(await requestOutcomeOf(renewed)).toMatchObject({ kind: 'pending', id: requestId, holder: { holder: { id: amy.account.id } } })
    expect(await rowOf(document)).toMatchObject({ holderId: amy.account.id, requestId, requestedBy: ben.account.id })
  })
})

describe('US-M3-06 请求方续期与第三人在到期之后申请（设计 §3.12）', () => {
  it('US-M3-06 续期先拿到租约行：没人在编辑，free（照样续期）；第三人的申请排在后面，照常取得，请求清掉（换了别人）', async () => {
    const { document, ben, dan } = await prepare()
    await pendingRequestId(app.baseUrl, ben.session, document)
    await passLeaseTime(database, document, EDIT_LEASE_TTL_SECONDS)
    const [renewed, acquired] = await inOrder(holdLeaseRow(document), async () => renewEditRequest(app.baseUrl, ben.session, document), async () => acquire(dan, document))
    expect(await requestOutcomeOf(renewed)).toEqual({ kind: 'free' })
    expect(acquired.status, await acquired.clone().text()).toBe(201)
    expect(await rowOf(document)).toMatchObject({ holderId: dan.account.id, requestId: null, requestedBy: null })
  })

  it('US-M3-06 第三人的申请先拿到租约行：取得新的一代、请求清掉；续期排在后面，锁下看到别人的一代——gone（现在正在编辑的人），不续期', async () => {
    const { document, ben, dan } = await prepare()
    await pendingRequestId(app.baseUrl, ben.session, document)
    await passLeaseTime(database, document, EDIT_LEASE_TTL_SECONDS)
    const [acquired, renewed] = await inOrder(holdLeaseRow(document), async () => acquire(dan, document), async () => renewEditRequest(app.baseUrl, ben.session, document))
    expect(acquired.status, await acquired.clone().text()).toBe(201)
    expect(await requestOutcomeOf(renewed)).toMatchObject({ kind: 'gone', holder: { holder: { id: dan.account.id }, sameUser: false } })
    expect(await rowOf(document)).toMatchObject({ holderId: dan.account.id, requestId: null })
  })
})

describe('US-M3-06 谢绝与取消（设计 §3.12）：两种先后都终止于"槽里没有请求"，都是 204', () => {
  it('US-M3-06 谢绝先拿到租约行：记下谢绝；取消排在后面，清掉它（已谢绝的也算调用者的请求）', async () => {
    const { document, amy, ben, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [declined, cancelled] = await inOrder(holdLeaseRow(document), async () => declineEditRequest(app.baseUrl, amy.session, document, lease, requestId), async () => cancelEditRequest(app.baseUrl, ben.session, document))
    expect([declined.status, cancelled.status]).toEqual([204, 204])
    expect(await rowOf(document)).toMatchObject({ requestId: null, declined: false, endReason: null })
  })

  it('US-M3-06 取消先拿到租约行：清掉请求；谢绝排在后面，锁下看到槽空着、标识对不上——什么也不做', async () => {
    const { document, amy, ben, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [cancelled, declined] = await inOrder(holdLeaseRow(document), async () => cancelEditRequest(app.baseUrl, ben.session, document), async () => declineEditRequest(app.baseUrl, amy.session, document, lease, requestId))
    expect([cancelled.status, declined.status]).toEqual([204, 204])
    expect(await rowOf(document)).toMatchObject({ requestId: null, declined: false, endReason: null })
  })
})

describe('US-M3-08 / US-M3-09 接管与交出（设计 §3.12）', () => {
  it('US-M3-09 强制接管先取完锁（停在写审计之前），交出等租约行：接管提交之后，交出锁下看到新的一代——taken_over（forced: true），没有保留；请求随强制接管清掉', async () => {
    const { document, amy, ann, ben, lease } = await prepare()
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const result = await interleave(
      { action: 'documents.edit_taken_over', actorId: ann.account.id, run: async () => acquire(ann, document, { takeover: 'force' }) },
      async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([201, 409, true])
    const error = await errorOf(result.second)
    expect([error.code, parseExact(editLeaseLostDetailsSchema, error.details)]).toEqual(['EDIT_LEASE_LOST', { reason: 'taken_over', forced: true }])
    expect(await rowOf(document)).toMatchObject({ holderId: ann.account.id, endReason: null, requestId: null, reservedFor: null })
  })

  it('US-M3-08 本人接管（另一台设备）先拿到租约行，交出排在后面：taken_over（forced: false），没有保留；请求沿用（同一个持有者）', async () => {
    const { document, amy, ben, lease } = await prepare()
    const laptop: LoggedIn = await login(app.baseUrl, amy.account.username, amy.account.password)
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const [taken, handed] = await inOrder(holdLeaseRow(document), async () => acquire({ account: amy.account, session: laptop }, document, { takeover: 'self' }), async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId))
    expect(taken.status, await taken.clone().text()).toBe(201)
    const error = await errorOf(handed)
    expect([error.code, parseExact(editLeaseLostDetailsSchema, error.details)]).toEqual(['EDIT_LEASE_LOST', { reason: 'taken_over', forced: false }])
    expect(await rowOf(document)).toMatchObject({ holderId: amy.account.id, endReason: null, requestId, reservedFor: null })
  })

  it.each(['self', 'force'] as const)('US-M3-06 交出先拿到租约行，接管（%s，已经锁住了文档行）排在后面：锁下看到交出与保留——EDIT_LEASE_RESERVED，什么也没写，不写审计', async (takeover) => {
    const { document, amy, ann, ben, lease } = await prepare()
    const laptop: LoggedIn = await login(app.baseUrl, amy.account.username, amy.account.password)
    const requestId = await pendingRequestId(app.baseUrl, ben.session, document)
    const taker: Person = takeover === 'self' ? { account: amy.account, session: laptop } : ann
    const [handed, taken] = await inOrder(holdLeaseRow(document), async () => handOverLease(app.baseUrl, amy.session, document, lease, requestId), async () => acquire(taker, document, { takeover }))
    expect(handed.status).toBe(200)
    const error = await errorOf(taken)
    expect([error.status, error.code, parseExact(editLeaseReservedDetailsSchema, error.details).reservedFor.id]).toEqual([409, 'EDIT_LEASE_RESERVED', ben.account.id])
    expect(await rowOf(document)).toMatchObject({ holderId: amy.account.id, endReason: 'handed_over', reservedFor: ben.account.id })
    const audits = await database.query(async client => (await client.query('SELECT 1 FROM audit_events WHERE target_id = $1 AND action = \'documents.edit_taken_over\'', [document])).rowCount)
    expect(audits).toBe(0)
  })
})

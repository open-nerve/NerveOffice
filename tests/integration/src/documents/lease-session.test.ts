// 登录被撤销之后，已经过了会话守卫的在途请求不再生效（M3-P1 审查 A1；US-M3-09 的"强制结束编辑"由撤销登录承担）。
// 会话守卫在处理器之前判断登录；之后到写入之前还隔着上传正文（拦截器在守卫之后才读正文，时长由客户端决定）与等锁，
// 这期间退出、签发重置（撤销这个人的全部登录）、停用都不经文档行与租约行，挡不住在途的请求。所以持有者自己的请求——保存、心跳、申请——
// 在事务里、锁下再核对一次这次登录仍然有效（edit-lease.service.ts 的 requireActiveLogin），失效时 401，什么也不写。
// 保存先查重放、再核对登录：一次已经提交的保存原样重发，拿到原来的结果（重放只要求能访问：ADR-011，上线门槛 A07），撤销登录之后也一样。
// M3-P5 的请求编辑（发出、续期）与持有者的谢绝、交出同样在锁住租约行之后核对登录（edit-request.service.ts 的 lockForEditor 与
// lockForHandOver——交出自 Codex 评审 CX1 起先锁文档行、再锁租约行，M3-P5 审查 A5）：等在租约行上时登录被撤销，放行之后 401，什么也不写。
// 由审查者 A 的探针改成的回归用例：持锁的交错用 support/held-lock.ts；慢上传那一条用"守卫顺延了这次登录"确认请求已经过了守卫，不靠固定的等待。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, CSRF_TOKEN_HEADER, EDIT_LEASE_HEADER, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { acquireBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, contentPathWithLease, declineEditRequest, handOverLease, leaseStateOf, outcomeOf, pendingRequestId, releaseLease, renewEditRequest, renewLease, saveContent, sendEditRequest } from '../support/edit-leases.ts'
import { completesWithoutWaiting, raceAgainstHeldLock, whileHolding } from '../support/held-lock.ts'
import { asUser, login, SESSION_COOKIE } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（签发重置、停用）；团队空间里的另一位编辑者 */
let root: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
let catSession: LoggedIn
let team: string
let people = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'lease-session-root', systemRole: 'admin' })
  cat = await createAccount(database, { username: 'lease-session-cat' })
  rootSession = await login(app.baseUrl, root.username, root.password)
  catSession = await login(app.baseUrl, cat.username, cat.password)
  team = await createTeamSpace(database, { name: '登录与编辑权', createdBy: root.id, members: { [cat.id]: 'editor' } })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一位新的编辑者：他的登录会被撤销、账户会被停用，各个用例各用各的人 */
async function editor(): Promise<{ readonly account: TestAccount, readonly session: LoggedIn }> {
  people += 1
  const account = await createAccount(database, { username: `lease-session-${people}` })
  await setMember(database, team, account.id, 'editor')
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

async function freshDocument(): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: team, createdBy: root.id, title: '登录与编辑权' })
}

/** 模板换上 unitId、A1 写入 value 的快照原文（解压之后的字节） */
function rawSnapshotOf(document: SeededDocument, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8')
}

function snapshotOf(document: SeededDocument, value: string): Uint8Array {
  return zlib.gzipSync(rawSnapshotOf(document, value))
}

/** 这份文档的修订号、修订记录的条数与保存的审计条数：被拒的保存一样也不多 */
async function writesOf(documentId: string): Promise<{ readonly revision: number | undefined, readonly revisions: number, readonly saves: number }> {
  return database.query(async client => ({
    revision: (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision,
    revisions: Number((await client.query<{ count: string }>('SELECT count(*) FROM document_revisions WHERE document_id = $1', [documentId])).rows[0]?.count),
    saves: Number((await client.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = \'documents.content_saved\'', [documentId])).rows[0]?.count),
  }))
}

const UNTOUCHED = { revision: 1, revisions: 1, saves: 0 }

/** 这个人现在还有几条有效的登录 */
async function activeSessionsOf(userId: string): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0]?.count))
}

/** 系统管理员签发重置链接：撤销这个人的全部登录（账户仍然有效） */
async function issueReset(account: TestAccount): Promise<void> {
  const issued = await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/password-reset`, { method: 'POST' })
  expect(issued.status, await issued.clone().text()).toBe(201)
  expect(await activeSessionsOf(account.id)).toBe(0)
}

/** 在持锁的事务里锁住这份文档的行 */
function holdDocument(documentId: string) {
  return async (client: pg.Client) => client.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [documentId])
}

/** 在持锁的事务里锁住这份文档的租约行 */
function holdLeaseRow(documentId: string) {
  return async (client: pg.Client) => client.query('SELECT 1 FROM document_edit_leases WHERE document_id = $1 FOR UPDATE', [documentId])
}

/** 这次登录在库里的令牌摘要：库里只存 Cookie 的值的 SHA-256 */
function tokenHashOf(session: LoggedIn): Buffer {
  return createHash('sha256').update(session.cookie.slice(`${SESSION_COOKIE}=`.length), 'utf8').digest()
}

/**
 * 慢上传的保存：请求头先到、正文先只发一个字节，守卫在读正文之前放行（拦截器在守卫之后才读正文）。
 * 怎么知道已经过了守卫：先把这次登录的最后活动时间往前挪两分钟，守卫认证之后会顺延它（间隔超过 1 分钟才写）；
 * 看到它被顺延，请求就已经过了守卫。这时 between() 里撤销登录、提交，再把正文传完
 */
async function slowSave(user: LoggedIn, document: SeededDocument, lease: HeldLease, between: () => Promise<void>): Promise<number> {
  const digest = tokenHashOf(user)
  const before = await database.query(async client => (await client.query<{ last_seen_at: Date }>(
    'UPDATE auth_sessions SET last_seen_at = now() - interval \'2 minutes\' WHERE token_hash = $1 RETURNING last_seen_at',
    [digest],
  )).rows[0]?.last_seen_at)
  if (before === undefined)
    throw new Error('库里没有这条登录')
  const body = snapshotOf(document, '撤销登录之后才传完的')
  const url = new URL(`${app.baseUrl}${contentPathWithLease(document.id, lease, { baseRevision: 1 })}`)
  return new Promise<number>((resolve, reject) => {
    const request = http.request(url, {
      method: 'PUT',
      headers: {
        'cookie': user.cookie,
        'origin': TEST_PUBLIC_ORIGIN,
        [CSRF_TOKEN_HEADER]: user.session.csrfToken,
        'content-type': 'application/gzip',
        'content-length': String(body.length),
        [EDIT_LEASE_HEADER]: lease.token,
      },
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    request.on('error', reject)
    request.write(body.subarray(0, 1))
    void (async () => {
      const deadline = performance.now() + 10_000
      for (;;) {
        const touched = await database.query(async client => (await client.query<{ touched: boolean }>('SELECT last_seen_at > $2 AS touched FROM auth_sessions WHERE token_hash = $1', [digest, before])).rows[0]?.touched)
        if (touched === true)
          break
        if (performance.now() > deadline)
          throw new Error('10 秒内请求没有过会话守卫')
        await delay(20)
      }
      await between()
      request.end(body.subarray(1))
    })().catch(reject)
  })
}

describe('US-M3-09 登录被撤销之后，已经过了会话守卫的在途请求不再生效（M3-P1 审查 A1）', () => {
  it('US-M3-09 保存等在文档行上时本人退出登录（先提交）：放行之后锁下再核对登录，401，修订号、修订记录与审计都不变', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const saved = await raceAgainstHeldLock(database, {
      hold: holdDocument(document.id),
      request: async () => saveContent(app.baseUrl, session, document.id, snapshotOf(document, '退出之后才写进来的'), { baseRevision: 1, lease }),
      change: async () => {
        expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
        expect(await activeSessionsOf(account.id)).toBe(0)
      },
    })
    expect(await outcomeOf(saved)).toBe('401 SESSION_EXPIRED')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
  })

  it('US-M3-09 保存等在文档行上时系统管理员签发重置（撤销这个人的全部登录，强制结束编辑）：401，什么也没写', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const saved = await raceAgainstHeldLock(database, {
      hold: holdDocument(document.id),
      request: async () => saveContent(app.baseUrl, session, document.id, snapshotOf(document, '强制结束编辑之后才写进来的'), { baseRevision: 1, lease }),
      change: async () => issueReset(account),
    })
    expect(await outcomeOf(saved)).toBe('401 SESSION_EXPIRED')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
  })

  it('US-M3-13 重放先于登录的再核对（M3-P1 复验 C2）：同一次保存的两份请求并发——重发在事务之外的重放预检时前一份还没提交（看不到），停在文档行上；前一份随后提交、其间本人退出了登录——拿到锁之后锁下再查是重放，拿到原来的结果（200），不重复写入，不是 401', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const requestId = randomUUID()
    const raw = rawSnapshotOf(document, '提交过一次的')
    // 持锁的事务就是前一份请求：锁着文档行，写下它的修订记录与修订号（还没提交），重发的预检看不到它
    const replayed = await raceAgainstHeldLock(database, {
      hold: async (client) => {
        await holdDocument(document.id)(client)
        await client.query(
          `INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, client_instance_id, local_seq, saved_by)
           VALUES ($1, 2, 'saved', $2, $3, $4, 1, $5)`,
          [document.id, requestId, createHash('sha256').update('saved\n1\n', 'utf8').update(raw).digest(), lease.clientInstanceId, account.id],
        )
        await client.query('UPDATE documents SET revision = 2, updated_at = now() WHERE id = $1', [document.id])
      },
      request: async () => saveContent(app.baseUrl, session, document.id, zlib.gzipSync(raw), { baseRevision: 1, lease, requestId }),
      change: async () => {
        expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
        expect(await activeSessionsOf(account.id)).toBe(0)
      },
    })
    const createdAt = await database.query(async client => (await client.query<{ created_at: Date }>('SELECT created_at FROM document_revisions WHERE request_id = $1', [requestId])).rows[0]?.created_at)
    expect({ status: replayed.status, body: await replayed.json() }).toEqual({ status: 200, body: { revision: 2, savedAt: createdAt?.toISOString(), unchanged: false } })
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 0 })
  })

  it('US-M3-13 已经提交的保存原样重发（M3-P3 设计 §3.1 第 2 步）：事务之外的重放预检就给出原来的结果（200）——文档行被别的事务锁着也不等，不重复写入', async () => {
    const { session } = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const requestId = randomUUID()
    const body = snapshotOf(document, '提交过一次的')
    const first = await saveContent(app.baseUrl, session, document.id, body, { baseRevision: 1, lease, requestId })
    expect(first.status, await first.clone().text()).toBe(200)
    const original: unknown = await first.json()
    // 持着文档行的锁直到重发结束：重发要是走到事务里等这把锁，就会等满应用的等锁时限、得到 503
    const replayed = await whileHolding(database, holdDocument(document.id), async () => saveContent(app.baseUrl, session, document.id, body, { baseRevision: 1, lease, requestId }))
    expect({ status: replayed.status, body: await replayed.json() }).toEqual({ status: 200, body: original })
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
  })

  it('US-M3-09 不用任何锁：保存的请求头先到、过了会话守卫，正文晚些传完，其间签发重置并提交——401，什么也没写', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    expect(await slowSave(session, document, lease, async () => issueReset(account))).toBe(401)
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
  })

  it('US-M3-09 心跳等在租约行上时登录被撤销：放行之后核对登录，401，不续租', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const before = await database.query(async client => (await client.query<{ renewed_at: Date }>('SELECT renewed_at FROM document_edit_leases WHERE document_id = $1', [document.id])).rows[0]?.renewed_at)
    const renewed = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => renewLease(app.baseUrl, session, document.id, lease),
      change: async () => issueReset(account),
    })
    expect(await outcomeOf(renewed)).toBe('401 SESSION_EXPIRED')
    const after = await database.query(async client => (await client.query<{ renewed_at: Date }>('SELECT renewed_at FROM document_edit_leases WHERE document_id = $1', [document.id])).rows[0]?.renewed_at)
    expect(after).toEqual(before)
  })

  it('US-M3-09 申请等在文档行上时登录被撤销：放行之后核对登录，401，不写下租约（不留一份绑定失效登录的租约，别人随后申请也没有关于它的提醒）', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    const acquired = await raceAgainstHeldLock(database, {
      hold: holdDocument(document.id),
      request: async () => asUser(app.baseUrl, session, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID()) }),
      change: async () => issueReset(account),
    })
    expect(await outcomeOf(acquired)).toBe('401 SESSION_EXPIRED')
    expect(await leaseStateOf(database, document.id)).toBeUndefined()
    const taken = parseExact(acquiredEditLeaseSchema, await (await asUser(app.baseUrl, catSession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID()) })).json())
    expect([taken.writeEpoch, taken.interruption]).toEqual([1, null])
  })

  it('US-M3-09 申请与停用交错：申请在锁下判断完权限、停在租约行上时停用提交（撤销了全部登录）——申请随后核对登录，401，不写下新的一代', async () => {
    const { account, session } = await editor()
    const document = await freshDocument()
    // 同一个页面先前编辑过一次（申请、释放）：留下的租约行由测试持住，申请锁住文档行、判断完权限之后停在这一行上
    const earlier = await acquireLease(app.baseUrl, session, document.id)
    await releaseLease(app.baseUrl, session, document.id, earlier)
    let disabling: Promise<Response> | undefined
    let disabledWithoutWaiting: boolean | undefined
    const acquired = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => asUser(app.baseUrl, session, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: acquireBody(earlier.clientInstanceId) }),
      change: async () => {
        // 他没有没结束的租约（先前那一代已经释放）：停用不碰这份文档的行，不等申请
        disabling = asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/disable`, { method: 'POST' })
        disabledWithoutWaiting = await completesWithoutWaiting(database, disabling, 2)
      },
    })
    if (disabling === undefined)
      throw new Error('停用没有发出')
    expect([await outcomeOf(acquired), (await disabling).status, disabledWithoutWaiting]).toEqual(['401 SESSION_EXPIRED', 200, true])
    // 租约行还是先前释放的那一代，文档的代次没再加
    expect(await leaseStateOf(database, document.id)).toEqual({ holderId: account.id, endReason: 'released', leaseEpoch: earlier.writeEpoch, documentEpoch: earlier.writeEpoch })
  })
})

/** 租约行上的请求与结束（直接查库，时间换成毫秒）：请求编辑的写路径被拒之后核对什么也没写 */
async function slotOf(documentId: string): Promise<Record<string, unknown> | undefined> {
  const row = await database.query(async client => (await client.query<Record<string, unknown>>(
    `SELECT holder_id, end_reason, ended_at, request_id, requested_by, request_session_id, requested_at, request_expires_at, request_declined_at, reserved_for, reserved_until
     FROM document_edit_leases WHERE document_id = $1`,
    [documentId],
  )).rows[0])
  return row === undefined ? undefined : Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value instanceof Date ? value.getTime() : value]))
}

describe('US-M3-06 请求编辑的写路径在锁住租约行之后核对这次登录（M3-P5 审查 A5，与上面持有者自己的请求同一个约定）', () => {
  it('US-M3-06 发出请求等在租约行上时请求方被签发重置（撤销全部登录）：放行之后锁下核对登录，401，槽里没有请求', async () => {
    const requester = await editor()
    const document = await freshDocument()
    await acquireLease(app.baseUrl, catSession, document.id)
    const before = await slotOf(document.id)
    const sent = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => sendEditRequest(app.baseUrl, requester.session, document.id),
      change: async () => issueReset(requester.account),
    })
    expect(await outcomeOf(sent)).toBe('401 SESSION_EXPIRED')
    expect(await slotOf(document.id)).toEqual(before)
  })

  it('US-M3-06 请求方续期等在租约行上时他被签发重置：放行之后锁下核对登录，401（不是"请求已不在"），有效期不往后推', async () => {
    const requester = await editor()
    const document = await freshDocument()
    await acquireLease(app.baseUrl, catSession, document.id)
    await pendingRequestId(app.baseUrl, requester.session, document.id)
    const before = await slotOf(document.id)
    const renewed = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => renewEditRequest(app.baseUrl, requester.session, document.id),
      change: async () => issueReset(requester.account),
    })
    expect(await outcomeOf(renewed)).toBe('401 SESSION_EXPIRED')
    expect(await slotOf(document.id)).toEqual(before)
  })

  it('US-M3-06 持有者谢绝等在租约行上时他被签发重置：放行之后锁下核对登录，401，请求没被谢绝', async () => {
    const holder = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const requestId = await pendingRequestId(app.baseUrl, catSession, document.id)
    const before = await slotOf(document.id)
    const declined = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => declineEditRequest(app.baseUrl, holder.session, document.id, lease, requestId),
      change: async () => issueReset(holder.account),
    })
    expect(await outcomeOf(declined)).toBe('401 SESSION_EXPIRED')
    expect(await slotOf(document.id)).toEqual(before)
  })

  it('US-M3-06 持有者交出等在租约行上时他被签发重置：放行之后锁下核对登录，401，没有交出（不记 handed_over、不留给请求方，请求还在）', async () => {
    const holder = await editor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const requestId = await pendingRequestId(app.baseUrl, catSession, document.id)
    const before = await slotOf(document.id)
    const handedOver = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => handOverLease(app.baseUrl, holder.session, document.id, lease, requestId),
      change: async () => issueReset(holder.account),
    })
    expect(await outcomeOf(handedOver)).toBe('401 SESSION_EXPIRED')
    expect(await slotOf(document.id)).toEqual(before)
    expect(before).toMatchObject({ end_reason: null, request_id: requestId, reserved_for: null })
  })
})

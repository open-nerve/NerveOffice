// 保存要求编辑租约（M3-P1 设计 §3.4.4），经真实的应用与数据库。保存的顺序是 ADR-011 的顺序加上租约这一步：
// 能访问 → 能编辑时锁文档行、锁下再判断 → 重放 → 不是重放才要求能编辑 → 租约 → unitId → 基准修订号 → 写入。
// 租约对不上时 409 EDIT_LEASE_LOST（details 只有原因），什么也不写；重放先于租约（A07）；过期的会话不能覆盖别人的保存（A05）。
// 与时间有关的（到期、空闲回收）改写租约行的时间来模拟（support/edit-leases.ts），"恰好"的边界由 apps/api 的单元测试按同一个 now 核对。
// 收回写入权（降级、移出、取消分享、归档、停用、删除）接上租约的用例在 lease-revocation.test.ts 与 lease-revocation-locks.test.ts；
// 这里的跨空间移动是移到他仍能编辑的空间，只看代次。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { SaveOptions } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { EDIT_LEASE_HEADER, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS, editLeaseLostDetailsSchema, errorResponseSchema, saveContentResponseSchema, sessionResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, idleLeaseFor, passLeaseTime, saveContent, strayLease } from '../support/edit-leases.ts'
import { completesWithoutWaiting, whileHolding } from '../support/held-lock.ts'
import { asUser, cookieValue, login, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 两个团队空间的空间管理员（会移动文档、接手编辑）与编辑者 */
let amy: TestAccount
let ben: TestAccount
let amySession: LoggedIn
let benSession: LoggedIn
let team: string
/** 另一个团队空间：本在这里也是编辑者，文档移过来之后他仍能编辑 */
let elsewhere: string
let editors = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  amy = await createAccount(database, { username: 'save-lease-amy' })
  ben = await createAccount(database, { username: 'save-lease-ben' })
  team = await createTeamSpace(database, { name: '保存与租约', createdBy: amy.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' } })
  elsewhere = await createTeamSpace(database, { name: '保存与租约：别处', createdBy: amy.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' } })
  amySession = await login(app.baseUrl, amy.username, amy.password)
  benSession = await login(app.baseUrl, ben.username, ben.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 团队空间里的一份新文档（修订号 1）：各个用例各用各的，租约互不影响 */
async function freshDocument(): Promise<SeededDocument> {
  return seedDocument(database, { spaceId: team, createdBy: amy.id, title: '保存与租约' })
}

/** 另一个团队编辑者：改密码的用例用自己的人，不影响别的用例的登录 */
async function freshEditor(): Promise<{ readonly account: TestAccount, readonly session: LoggedIn }> {
  editors += 1
  const account = await createAccount(database, { username: `save-lease-editor-${editors}` })
  await setMember(database, team, account.id, 'editor')
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

/** 模板换上 unitId、A1 写入 value 的快照（gzip） */
function snapshotOf(unitId: string, value: string): Uint8Array {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return zlib.gzipSync(Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8'))
}

async function save(user: LoggedIn, document: SeededDocument, value: string, options: SaveOptions): Promise<Response> {
  return saveContent(app.baseUrl, user, document.id, snapshotOf(document.unitId, value), options)
}

/** 保存被拒：409 EDIT_LEASE_LOST，details 只有原因；返回原因 */
async function lostReason(response: Response): Promise<string | undefined> {
  expect(response.status, await response.clone().text()).toBe(409)
  const { error } = parseExact(errorResponseSchema, await response.json())
  expect(error.code).toBe('EDIT_LEASE_LOST')
  return parseExact(editLeaseLostDetailsSchema, error.details).reason
}

interface Writes {
  readonly revision: number | undefined
  readonly revisions: number
  readonly audits: number
}

/** 新建之后什么也没写过 */
const UNTOUCHED: Writes = { revision: 1, revisions: 1, audits: 0 }

/** 文档的修订号、修订记录的条数与保存的审计条数：被拒的保存一样也不多 */
async function writesOf(documentId: string): Promise<Writes> {
  return database.query(async client => ({
    revision: (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision,
    revisions: Number((await client.query<{ count: string }>('SELECT count(*) FROM document_revisions WHERE document_id = $1', [documentId])).rows[0]?.count),
    audits: Number((await client.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = \'documents.content_saved\'', [documentId])).rows[0]?.count),
  }))
}

/** 服务器上当前的内容（解压之后的文本） */
async function contentOf(documentId: string): Promise<string> {
  const row = await database.query(async client => (await client.query<{ snapshot: Buffer }>('SELECT snapshot FROM document_contents WHERE document_id = $1', [documentId])).rows[0])
  if (row === undefined)
    throw new Error(`文档 ${documentId} 没有内容`)
  return zlib.gunzipSync(row.snapshot).toString('utf8')
}

interface LeaseTimes {
  readonly write_epoch: number
  readonly renewed_at: Date
  readonly expires_at: Date
  readonly last_active_at: Date
  readonly end_reason: string | null
}

/** 租约行上续租、结束会改动的几列 */
async function leaseTimesOf(documentId: string): Promise<LeaseTimes | undefined> {
  return database.query(async client => (await client.query<LeaseTimes>(
    'SELECT write_epoch, renewed_at, expires_at, last_active_at, end_reason FROM document_edit_leases WHERE document_id = $1',
    [documentId],
  )).rows[0])
}

/** 改密码成功的响应里的新登录：新的 Cookie 与新的 CSRF 令牌（同一个浏览器里的页面随后带的就是它） */
async function renewedSessionOf(response: Response): Promise<LoggedIn> {
  const setCookie = sessionSetCookie(response)
  if (setCookie === undefined)
    throw new Error('改密码成功却没有写回会话 Cookie')
  return { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}`, session: parseExact(sessionResponseSchema, await response.json()) }
}

describe('US-M3-04 只有持有编辑租约的那个页面写得进来（P1 设计 §3.4.4）', () => {
  it('US-M3-04 持有租约的页面带着令牌、代次与标签页保存：200；保存不续租（续租靠心跳），租约行不变', async () => {
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    const before = await leaseTimesOf(document.id)
    const response = await save(benSession, document, '本写的', { baseRevision: 1, lease })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(parseExact(saveContentResponseSchema, await response.json()).revision).toBe(2)
    expect(await leaseTimesOf(document.id)).toEqual(before)
  })

  it('US-M3-04 保存不锁租约行：心跳正锁着租约行时，保存照常完成、不等它（能改写租约行的申请与收回写入权都先锁文档行，P1 设计 §3.4.4）', async () => {
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    const response = await whileHolding(database, async client => client.query('SELECT 1 FROM document_edit_leases WHERE document_id = $1 FOR UPDATE', [document.id]), async () => {
      const saving = save(benSession, document, '心跳的同时', { baseRevision: 1, lease })
      expect(await completesWithoutWaiting(database, saving, 1)).toBe(true)
      return saving
    })
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it('US-M3-04 没带令牌：none（没人申请过、自己正持有都一样）；令牌格式不对：400；格式对、却不是当前这一代的：replaced；都什么也没写', async () => {
    const document = await freshDocument()
    const withoutToken = { [EDIT_LEASE_HEADER]: undefined }
    // 没人申请过：没有租约行
    expect(await lostReason(await save(benSession, document, '没有租约', { baseRevision: 1, lease: strayLease(), headers: withoutToken }))).toBe('none')
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    expect(await lostReason(await save(benSession, document, '不带令牌', { baseRevision: 1, lease, headers: withoutToken }))).toBe('none')
    const malformed = await save(benSession, document, '格式不对', { baseRevision: 1, lease, headers: { [EDIT_LEASE_HEADER]: 'not-a-lease-token' } })
    expect(malformed.status).toBe(400)
    expect(parseExact(errorResponseSchema, await malformed.json()).error.code).toBe('REQUEST_INVALID')
    // 艾米也能编辑，但当前这一代是本的
    expect(await lostReason(await save(amySession, document, '别人的令牌', { baseRevision: 1, lease: strayLease() }))).toBe('replaced')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
    // 本的租约不受影响
    expect((await save(benSession, document, '带上令牌', { baseRevision: 1, lease })).status).toBe(200)
  })

  it('US-M3-04 同一个人的另一个标签页：令牌与代次都对，标签页不是租约绑定的那一个，session；什么也没写', async () => {
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    expect(await lostReason(await save(benSession, document, '另一个标签页', { baseRevision: 1, lease, query: { clientInstanceId: randomUUID() } }))).toBe('session')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
  })
})

describe('代次：保存带的 writeEpoch 要是租约的那一代，租约的那一代要是文档当前的（P1 设计 §3.4.1 第 3 条）', () => {
  it('US-M3-11 同一个页面重新申请过（新的一代）：旧令牌是 replaced，新令牌配旧代次是 stale，什么也没写；新令牌配新代次才写得进来', async () => {
    const document = await freshDocument()
    const tab = randomUUID()
    const first = await acquireLease(app.baseUrl, benSession, document.id, tab)
    // 同一个登录、同一个标签页再申请（例如上次申请的回包丢了）：发新的一代
    const second = await acquireLease(app.baseUrl, benSession, document.id, tab)
    expect(second.writeEpoch).toBe(first.writeEpoch + 1)
    expect(await lostReason(await save(benSession, document, '旧令牌', { baseRevision: 1, lease: first }))).toBe('replaced')
    expect(await lostReason(await save(benSession, document, '新令牌、旧代次', { baseRevision: 1, lease: { ...second, writeEpoch: first.writeEpoch } }))).toBe('stale')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
    expect((await save(benSession, document, '新令牌、新代次', { baseRevision: 1, lease: second })).status).toBe(200)
  })

  it('US-M3-12 文档被跨空间移到他仍能编辑的空间：移动给代次加了一，原来的租约是 stale，什么也没写；同一个页面重新申请之后接着保存（续上）', async () => {
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: elsewhere } })).status).toBe(200)
    expect(await lostReason(await save(benSession, document, '移动之后', { baseRevision: 1, lease }))).toBe('stale')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
    const again = await acquireLease(app.baseUrl, benSession, document.id, lease.clientInstanceId)
    // 移动加一，重新申请再加一
    expect(again.writeEpoch).toBe(lease.writeEpoch + 2)
    expect((await save(benSession, document, '续上之后', { baseRevision: 1, lease: again })).status).toBe(200)
  })
})

describe('US-M3-11 失去编辑权的页面写不进来：到期、空闲回收、换了登录（P1 设计 §3.4.1 第 4–6 条）', () => {
  it('US-M3-11 心跳停了 90 秒（租约到期）：expired；空闲满 12 分钟由服务端回收：idle；都什么也没写', async () => {
    const expired = await freshDocument()
    const expiring = await acquireLease(app.baseUrl, benSession, expired.id)
    await passLeaseTime(database, expired.id, EDIT_LEASE_TTL_SECONDS)
    expect(await lostReason(await save(benSession, expired, '到期之后', { baseRevision: 1, lease: expiring }))).toBe('expired')
    expect(await writesOf(expired.id)).toEqual(UNTOUCHED)

    const idle = await freshDocument()
    const idling = await acquireLease(app.baseUrl, benSession, idle.id)
    await idleLeaseFor(database, idle.id, EDIT_LEASE_IDLE_RECLAIM_SECONDS)
    expect(await lostReason(await save(benSession, idle, '空闲之后', { baseRevision: 1, lease: idling }))).toBe('idle')
    expect(await writesOf(idle.id)).toEqual(UNTOUCHED)
  })

  it('US-M3-11 修改密码换了登录：同一个页面带着新的登录与旧的令牌保存，session，什么也没写；重新申请之后接着保存（续上）', async () => {
    const { account: erin, session } = await freshEditor()
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const changed = await asUser(app.baseUrl, session, '/api/auth/password', { method: 'PUT', body: { currentPassword: erin.password, newPassword: 'a brand new long password' } })
    expect(changed.status, await changed.clone().text()).toBe(200)
    const renewed = await renewedSessionOf(changed)
    expect(await lostReason(await save(renewed, document, '换了登录', { baseRevision: 1, lease }))).toBe('session')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
    const again = await acquireLease(app.baseUrl, renewed, document.id, lease.clientInstanceId)
    expect((await save(renewed, document, '续上之后', { baseRevision: 1, lease: again })).status).toBe(200)
  })

  it('US-M3-11 租约在 unitId 之前判断：失去编辑权的页面提交的内容不属于这份文档，也先得到编辑权已失效（页面据此停止编辑）', async () => {
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const foreign = await saveContent(app.baseUrl, benSession, document.id, snapshotOf(randomUUID(), '别的文档的内容'), { baseRevision: 1, lease })
    expect(await lostReason(foreign)).toBe('expired')
    expect(await writesOf(document.id)).toEqual(UNTOUCHED)
  })
})

describe('US-M3-11 过期的会话不能覆盖别人的保存（A05 的在线部分）', () => {
  it('US-M3-11 本的租约到期，艾米申请并保存之后，本用旧令牌提交旧内容被拒（replaced，不是修订号冲突）：服务器上是艾米的版本，修订号没有多加；本这时也申请不到', async () => {
    const document = await freshDocument()
    const stale = await acquireLease(app.baseUrl, benSession, document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const taken = await acquireLease(app.baseUrl, amySession, document.id)
    expect((await save(amySession, document, '艾米接手之后写的', { baseRevision: 1, lease: taken })).status).toBe(200)

    // 本恢复之后提交他基于修订号 1 的内容：租约在基准修订号之前判断，原因是他的那一代已经被取代
    expect(await lostReason(await save(benSession, document, '本的旧内容', { baseRevision: 1, lease: stale }))).toBe('replaced')
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, audits: 1 })
    const content = await contentOf(document.id)
    expect([content.includes('艾米接手之后写的'), content.includes('本的旧内容')]).toEqual([true, false])
    // 他的页面续不上：艾米正在编辑
    const retry = await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/edit-lease`, { method: 'POST', body: { clientInstanceId: stale.clientInstanceId } })
    expect(retry.status).toBe(409)
    expect(parseExact(errorResponseSchema, await retry.json()).error.code).toBe('EDIT_LEASE_HELD')
  })

  it('US-M3-11 期间没人申请、没人保存：本的旧租约到期，保存是 expired；同一个页面重新申请到新的一代，接着保存（续上）', async () => {
    const document = await freshDocument()
    const stale = await acquireLease(app.baseUrl, benSession, document.id)
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    expect(await lostReason(await save(benSession, document, '到期之后', { baseRevision: 1, lease: stale }))).toBe('expired')
    const again = await acquireLease(app.baseUrl, benSession, document.id, stale.clientInstanceId)
    expect((await save(benSession, document, '续上之后', { baseRevision: 1, lease: again })).status).toBe(200)
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, audits: 1 })
  })
})

describe('US-M3-13 没收到保存的确认时可以安全地重试（A07 的在线部分）', () => {
  it('US-M3-13 保存已经提交、回包丢了；这期间本的租约到期、被艾米接手并保存：本原样重发拿到原来的结果（重放先于租约），不重复写入；不是重放的保存被拒', async () => {
    const document = await freshDocument()
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    const request: SaveOptions = { baseRevision: 1, lease, requestId: randomUUID(), localSeq: 7 }
    const first = await save(benSession, document, '本提交了的', request)
    expect(first.status, await first.clone().text()).toBe(200)
    const original: unknown = await first.json()

    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
    const taken = await acquireLease(app.baseUrl, amySession, document.id)
    expect((await save(amySession, document, '艾米接手之后写的', { baseRevision: 2, lease: taken })).status).toBe(200)
    const before = await writesOf(document.id)
    expect(before).toEqual({ revision: 3, revisions: 3, audits: 2 })

    // 原样重发（同一个请求标识、令牌、代次与内容）：原来的结果，不是编辑权已失效，也不是修订号冲突；修订号与记录都不变
    const replayed = await save(benSession, document, '本提交了的', request)
    expect({ status: replayed.status, body: await replayed.json() }).toEqual({ status: 200, body: original })
    expect(await writesOf(document.id)).toEqual(before)
    // 不是重放的保存照样要求租约：本的那一代已经被取代
    expect(await lostReason(await save(benSession, document, '本的新内容', { baseRevision: 3, lease }))).toBe('replaced')
    expect(await writesOf(document.id)).toEqual(before)
  })
})

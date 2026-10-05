// 后台请求不顺延登录（M3-P2 设计 §3.2，DEF-043）：页面在后台定时发的请求——阅读页每 30 秒读一次编辑状态、编辑时每 10 秒的心跳——
// 标了 @BackgroundRequest()，会话守卫照常认证，但不顺延空闲过期：页面开着、人却不在时，登录照样按空闲到期。
// 用户自己的操作（打开、保存、申请编辑权）照常顺延。会话距上次记录活动超过 1 分钟才会顺延（P3 的写法），
// 所以每次先把会话的最后活动挪到 2 分钟之前、空闲过期挪近，再看请求之后这两列有没有变。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { CSRF_TOKEN_HEADER, EDIT_LEASE_HEADER, errorResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, renewBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, renewLease, saveContent } from '../support/edit-leases.ts'
import { postOpenCheckReport } from '../support/open-check.ts'
import { asUser, login, SESSION_COOKIE } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let amy: TestAccount

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  amy = await createAccount(database, { username: 'background-amy' })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function digestOf(user: LoggedIn): Buffer {
  return createHash('sha256').update(user.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
}

interface SessionTimes {
  readonly last_seen_at: Date
  readonly idle_expires_at: Date
}

async function timesOf(user: LoggedIn): Promise<SessionTimes> {
  const row = await database.query(async client => (await client.query<SessionTimes>(
    'SELECT last_seen_at, idle_expires_at FROM auth_sessions WHERE token_hash = $1',
    [digestOf(user)],
  )).rows[0])
  if (row === undefined)
    throw new Error('库里没有这条会话')
  return row
}

/** 会话的最后活动在 2 分钟之前（超过 1 分钟的顺延间隔），空闲过期还剩 10 分钟：下一个顺延的请求一定会改这两列 */
async function staleSession(user: LoggedIn): Promise<SessionTimes> {
  await database.query(async client => client.query(
    'UPDATE auth_sessions SET last_seen_at = now() - interval \'2 minutes\', idle_expires_at = now() + interval \'10 minutes\' WHERE token_hash = $1',
    [digestOf(user)],
  ))
  return timesOf(user)
}

/** 新登录一次、建一份自己的文档：每个用例各用各的会话，时间互不影响 */
async function fresh(): Promise<{ readonly session: LoggedIn, readonly document: { readonly id: string, readonly unitId: string } }> {
  const session = await login(app.baseUrl, amy.username, amy.password)
  const document = await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '后台请求' })
  return { session, document }
}

/**
 * 发这个请求之前把会话挪成"该顺延了"，之后看会话的最后活动与空闲过期变了没有：顺延了是 true。
 * 两列一起变或一起不变（守卫顺延时一条语句写两列）
 */
async function keptAlive(user: LoggedIn, send: () => Promise<Response>, status: number): Promise<boolean> {
  const before = await staleSession(user)
  const response = await send()
  expect(response.status, await response.clone().text()).toBe(status)
  await response.arrayBuffer()
  const after = await timesOf(user)
  const extended = after.last_seen_at.getTime() > before.last_seen_at.getTime()
  expect(after.idle_expires_at.getTime() > before.idle_expires_at.getTime(), '最后活动与空闲过期一起变').toBe(extended)
  return extended
}

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

describe('US-M3-05 后台请求不顺延登录（DEF-043）', () => {
  it('US-M3-05 编辑状态（阅读页每 30 秒一次）：200，会话的最后活动与空闲过期都不变；打开文档、读内容（用户的操作）照常顺延', async () => {
    const { session, document } = await fresh()
    expect(await keptAlive(session, async () => asUser(app.baseUrl, session, leasePath(document.id)), 200)).toBe(false)
    expect(await keptAlive(session, async () => asUser(app.baseUrl, session, `/api/documents/${document.id}`), 200)).toBe(true)
    expect(await keptAlive(session, async () => asUser(app.baseUrl, session, `/api/documents/${document.id}/content`), 200)).toBe(true)
  })

  it('US-M3-05 心跳（编辑时每 10 秒一次）：200，不顺延；保存、申请编辑权、释放（用户的操作）照常顺延', async () => {
    const { session, document } = await fresh()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    expect(await keptAlive(session, async () => renewLease(app.baseUrl, session, document.id, lease), 200)).toBe(false)
    const raw = zlib.gzipSync(Buffer.from(sheetSnapshotFor(document.unitId), 'utf8'))
    expect(await keptAlive(session, async () => saveContent(app.baseUrl, session, document.id, raw, { baseRevision: 1, lease }), 200)).toBe(true)
    expect(await keptAlive(session, async () => asUser(app.baseUrl, session, leasePath(document.id), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: lease.token } }), 204)).toBe(true)
    expect(await keptAlive(session, async () => asUser(app.baseUrl, session, leasePath(document.id), { method: 'POST', body: acquireBody(randomUUID()) }), 201)).toBe(true)
  })

  it('US-M3-15 打开自检失败的上报（页面自己发的，M3-P4 设计 §3.13）：204，不顺延', async () => {
    const { session, document } = await fresh()
    expect(await keptAlive(session, async () => postOpenCheckReport(app.baseUrl, session, document.id), 204)).toBe(false)
  })

  it('标记只影响顺延，不放宽认证与 CSRF：心跳缺 CSRF 令牌 403；空闲过期的登录发编辑状态 401', async () => {
    const { session, document } = await fresh()
    const lease = await acquireLease(app.baseUrl, session, document.id)
    const noToken = await asUser(app.baseUrl, session, leasePath(document.id), { method: 'PUT', body: renewBody(0), headers: { [EDIT_LEASE_HEADER]: lease.token, [CSRF_TOKEN_HEADER]: undefined } })
    expect([noToken.status, parseExact(errorResponseSchema, await noToken.json()).error.code]).toEqual([403, 'CSRF_TOKEN_INVALID'])
    await database.query(async client => client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [digestOf(session)]))
    const expired = await asUser(app.baseUrl, session, leasePath(document.id))
    expect([expired.status, parseExact(errorResponseSchema, await expired.json()).error.code]).toEqual([401, 'SESSION_EXPIRED'])
  })
})

// 数据库繁忙时的回答（M2-P6 复核 A 的 G-2）：等锁超时、语句超时、取不到连接都回 503 SERVICE_UNAVAILABLE 带 Retry-After，
// 客户端据此知道"没有生效，稍后重试"；响应不带数据库的细节，事务整体回滚，日志记 warn（带原因），不记成错误。
// 构造是确定的：测试在一个事务里持着锁，直到被测的请求结束（不论成败）才回滚，请求一定是等满时限失败，而不是抢在锁之前。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { REQUEST_ID_HEADER } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { completesWithoutWaiting, whileHolding } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

/** 数据库繁忙时的 Retry-After（apps/api 的 DATABASE_BUSY_RETRY_AFTER_SECONDS） */
const RETRY_AFTER = '5'
const BUSY_BODY = { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' }
/** 响应里不能出现的数据库细节 */
const INTERNALS = /lock|timeout|55P03|57014|advisory|SQL|connect|pool|cancel/i

let database: TestDatabase
/** 等锁 300 毫秒就放弃 */
let app: TestApp
let root: TestAccount
let amy: TestAccount
let amySession: LoggedIn
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_LOCK_TIMEOUT_MS: '300' } })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  amySession = await login(app.baseUrl, 'amy', amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function teamSpace(): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `繁忙 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin' } })
}

async function newFolder(spaceId: string, name: string, parentId?: string): Promise<string> {
  const response = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, name, parentId, requestId: randomUUID() } })
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}

async function count(query: string, values: unknown[]): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

function holdSpaceTree(spaceId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
}

/** 503 带 Retry-After，响应只有通用说明 */
async function expectBusy(response: Response): Promise<void> {
  expect(response.status).toBe(503)
  expect(response.headers.get('retry-after')).toBe(RETRY_AFTER)
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({ error: { ...BUSY_BODY, requestId: response.headers.get(REQUEST_ID_HEADER) } })
  expect(text).not.toMatch(INTERNALS)
}

/** 这个请求的日志：异常过滤器记一条 warn（带原因与数据库报的错），请求结束的那一条也是 warn；没有一条 error */
function expectBusyLogs(logs: TestApp['logs'], response: Response, reason: string): Record<string, unknown> {
  const requestId = response.headers.get(REQUEST_ID_HEADER)
  const lines = logs.entries().filter(line => line.requestId === requestId)
  expect(lines.filter(line => line.level === 'error' || line.level === 'fatal')).toEqual([])
  const busy = lines.find(line => line.reason === reason)
  expect(busy, JSON.stringify(lines)).toMatchObject({ level: 'warn', msg: '数据库繁忙，回 503 让客户端稍后重试' })
  expect(lines.find(line => line.statusCode === 503)).toMatchObject({ level: 'warn' })
  return busy ?? {}
}

describe('数据库繁忙：回 503 让客户端稍后重试（M2-P6 复核 A 的 G-2）', () => {
  it('等锁超时（树锁被别的事务占着）：503 带 Retry-After，什么也没改，日志记 warn 与 SQLSTATE 55P03；放开之后重试成功', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(spaceId, '资料')
    const response = await whileHolding(database, holdSpaceTree(spaceId), async () => asUser(app.baseUrl, amySession, `/api/folders/${folder}`, { method: 'DELETE' }))
    await expectBusy(response)
    expect(await count('SELECT count(*) FROM trash_entries WHERE space_id = $1', [spaceId])).toBe(0)
    expect(await count('SELECT count(*) FROM folders WHERE id = $1 AND status = \'active\'', [folder])).toBe(1)
    // 日志里有数据库报的原因（带占位符的语句与 SQLSTATE，没有参数）
    expect(JSON.stringify(expectBusyLogs(app.logs, response, 'lock_timeout'))).toContain('"sqlState":"55P03"')
    expect((await asUser(app.baseUrl, amySession, `/api/folders/${folder}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('写过之后才等锁超时（跨空间移动：子树已经换了空间，锁文档行时超时）：503，整个事务回滚，文件夹还在原空间、代次没变、没有审计', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '资料')
    const child = await newFolder(from, '子', folder)
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '里面的', folderId: child })
    const response = await whileHolding(
      database,
      async client => client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [document.id]),
      async () => asUser(app.baseUrl, amySession, `/api/folders/${folder}/move`, { method: 'POST', body: { spaceId: to } }),
    )
    await expectBusy(response)
    expectBusyLogs(app.logs, response, 'lock_timeout')
    expect(await count('SELECT count(*) FROM folders WHERE id = ANY($1) AND space_id = $2', [[folder, child], from])).toBe(2)
    expect(await count('SELECT count(*) FROM documents WHERE id = $1 AND space_id = $2 AND write_epoch = 0', [document.id, from])).toBe(1)
    expect(await count('SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = \'folders.moved\'', [folder])).toBe(0)
  })

  it('语句超时（等锁比语句超时更久）：503 带 Retry-After，日志记 warn 与 SQLSTATE 57014；放开之后重试成功', async () => {
    const slow = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '500', NERVE_DATABASE_LOCK_TIMEOUT_MS: '10000' } })
    try {
      const session = await login(slow.baseUrl, 'amy', amy.password)
      const spaceId = await teamSpace()
      const folder = await newFolder(spaceId, '资料')
      const response = await whileHolding(database, holdSpaceTree(spaceId), async () => asUser(slow.baseUrl, session, `/api/folders/${folder}`, { method: 'PATCH', body: { name: '改过' } }))
      await expectBusy(response)
      expect(JSON.stringify(expectBusyLogs(slow.logs, response, 'statement_timeout'))).toContain('"sqlState":"57014"')
      expect(await count('SELECT count(*) FROM folders WHERE id = $1 AND name = \'资料\'', [folder])).toBe(1)
      expect((await asUser(slow.baseUrl, session, `/api/folders/${folder}`, { method: 'PATCH', body: { name: '改过' } })).status).toBe(200)
    }
    finally {
      await slow.close()
    }
  })

  it('取不到连接（唯一的连接被一个等锁的请求占着）：另一个请求 503 带 Retry-After，不留下改动；放开之后两个都照常', async () => {
    const single = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_POOL_MAX: '1', NERVE_DATABASE_CONNECT_TIMEOUT_MS: '300', NERVE_DATABASE_LOCK_TIMEOUT_MS: '10000' } })
    try {
      const session = await login(single.baseUrl, 'amy', amy.password)
      const spaceId = await teamSpace()
      const [first, second] = [await newFolder(spaceId, '一'), await newFolder(spaceId, '二')]
      const [waiting, starved] = await whileHolding(database, holdSpaceTree(spaceId), async () => {
        const pending = asUser(single.baseUrl, session, `/api/folders/${first}`, { method: 'DELETE' })
        // 第一个请求走到树锁上等着，占着唯一的连接
        expect(await completesWithoutWaiting(database, pending, 1)).toBe(false)
        // 另一个请求连会话都查不了：守卫在事务之外读库，取连接等满时限
        return [pending, await asUser(single.baseUrl, session, `/api/folders/${second}`, { method: 'PATCH', body: { name: '改过' } })] as const
      })
      await expectBusy(starved)
      expectBusyLogs(single.logs, starved, 'pool_timeout')
      expect((await waiting).status).toBe(204)
      expect(await count('SELECT count(*) FROM folders WHERE id = $1 AND name = \'二\'', [second])).toBe(1)
      expect((await asUser(single.baseUrl, session, `/api/folders/${second}`, { method: 'PATCH', body: { name: '改过' } })).status).toBe(200)
    }
    finally {
      await single.close()
    }
  })
})

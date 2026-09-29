// 团队空间里的文档（M2-P2 设计 §3.4–§3.6）：按空间列出、新建到指定空间（M1 兼容、重放、审计）、详情带所在的空间；
// 全员可见与归档；新建与归档、移出成员的并发（两个连接构造的交错）。逐格的权限见 permissions/content-matrix.test.ts。
import type { DocumentDetail, DocumentListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { documentDetailSchema, documentListResponseSchema, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument } from '../support/documents.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let cat: TestAccount
let amySession: LoggedIn
let benSession: LoggedIn
let catSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  cat = await createAccount(database, { username: 'cat', displayName: '凯特' })
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
  catSession = await login(app.baseUrl, 'cat', cat.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一个新的团队空间：艾米是编辑者，本是查看者 */
async function teamSpace(name: string, options: { visibleToAll?: boolean } = {}): Promise<string> {
  return createTeamSpace(database, { name, createdBy: root.id, members: { [amy.id]: 'editor', [ben.id]: 'viewer' }, ...options })
}

async function create(user: LoggedIn, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: randomUUID(), ...body } })
}

async function created(response: Response): Promise<DocumentDetail> {
  expect(response.status).toBe(201)
  return parseExact(documentDetailSchema, await response.json())
}

async function list(user: LoggedIn, spaceId?: string): Promise<DocumentListResponse> {
  const response = await asUser(app.baseUrl, user, spaceId === undefined ? '/api/documents' : `/api/documents?spaceId=${spaceId}`)
  expect(response.status).toBe(200)
  return parseExact(documentListResponseSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function count(query: string, values: unknown[]): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

describe('US-M2-05 团队空间里的文档', () => {
  it('编辑者在团队空间里新建：详情带所在的空间，只出现在这个空间的列表里，记审计', async () => {
    const spaceId = await teamSpace('市场部')
    const document = await created(await create(amySession, { title: '周报', spaceId }))
    expect(document).toMatchObject({ title: '周报', spaceId, space: { id: spaceId, type: 'team', name: '市场部' }, revision: 1, permissions: { canEdit: true } })
    expect((await list(amySession, spaceId)).items.map(item => item.id)).toEqual([document.id])
    expect((await list(benSession, spaceId)).items.map(item => item.id)).toEqual([document.id])
    // 没有指定空间：仍是个人空间（M1 兼容）
    expect((await list(amySession)).items.map(item => item.id)).not.toContain(document.id)
    expect(await count('SELECT count(*) FROM audit_events WHERE action = \'documents.created\' AND target_id = $1 AND actor_id = $2', [document.id, amy.id])).toBe(1)
  })

  it('详情：个人空间的文档带着个人空间（名称是所有者的显示名）', async () => {
    const id = await createDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '私人笔记' })
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${id}`)
    expect(parseExact(documentDetailSchema, await response.json()).space).toEqual({ id: amy.personalSpaceId, type: 'personal', name: '艾米' })
  })

  it('同一个请求重放：同样带着空间时返回同一份文档；同一个 requestId 换了空间（或不带空间）是另一个请求', async () => {
    const spaceId = await teamSpace('产品部')
    const requestId = randomUUID()
    const first = await created(await create(amySession, { requestId, spaceId }))
    expect(await created(await create(amySession, { requestId, spaceId }))).toEqual(first)
    for (const body of [{ requestId }, { requestId, spaceId: amy.personalSpaceId }]) {
      const response = await create(amySession, body)
      expect(response.status).toBe(409)
      expect((await errorOf(response)).code).toBe('REQUEST_ID_CONFLICT')
    }
    expect(await count('SELECT count(*) FROM documents WHERE space_id = $1', [spaceId])).toBe(1)
  })

  it('查看者能列出与阅读，不能新建：403，说明没有新建的权限', async () => {
    const spaceId = await teamSpace('研发部')
    const response = await create(benSession, { spaceId })
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '没有在这个空间里新建的权限' })
  })

  it('全员可见：不是成员的有效账户以查看者看到它的文档，不能新建；取消全员可见之后看不到', async () => {
    const spaceId = await teamSpace('公告', { visibleToAll: true })
    const document = await created(await create(amySession, { title: '放假通知', spaceId }))
    expect((await list(catSession, spaceId)).items.map(item => item.title)).toEqual(['放假通知'])
    const detail = parseExact(documentDetailSchema, await (await asUser(app.baseUrl, catSession, `/api/documents/${document.id}`)).json())
    expect(detail.permissions).toEqual({ canEdit: false })
    expect((await create(catSession, { spaceId })).status).toBe(403)

    await setSpaceState(database, spaceId, { visibleToAll: false })
    expect((await asUser(app.baseUrl, catSession, `/api/documents?spaceId=${spaceId}`)).status).toBe(404)
    expect((await asUser(app.baseUrl, catSession, `/api/documents/${document.id}`)).status).toBe(404)
  })

  it('归档：成员照样能列出与阅读，不能新建，说明空间已归档；恢复之后又能新建', async () => {
    const spaceId = await teamSpace('旧项目')
    const document = await created(await create(amySession, { spaceId }))
    await setSpaceState(database, spaceId, { status: 'archived' })
    expect((await list(amySession, spaceId)).items.map(item => item.id)).toEqual([document.id])
    const detail = parseExact(documentDetailSchema, await (await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`)).json())
    expect(detail.permissions).toEqual({ canEdit: false })
    const response = await create(amySession, { spaceId })
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })

    await setSpaceState(database, spaceId, { status: 'active' })
    expect((await create(amySession, { spaceId })).status).toBe(201)
  })

  it('移出空间之后，下一次请求就看不到：列表与文档都是 404', async () => {
    const spaceId = await teamSpace('临时小组')
    const document = await created(await create(amySession, { spaceId }))
    await setMember(database, spaceId, amy.id, undefined)
    expect((await asUser(app.baseUrl, amySession, `/api/documents?spaceId=${spaceId}`)).status).toBe(404)
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`)).status).toBe(404)
  })
})

describe('US-M2-14 新建与改动空间的并发', () => {
  /** 在持锁的事务里锁住空间行，与归档、移出成员相同（FOR NO KEY UPDATE） */
  function lockSpaceRow(spaceId: string) {
    return async (client: { query: (text: string, values: unknown[]) => Promise<unknown> }) => client.query('SELECT id FROM spaces WHERE id = $1 FOR NO KEY UPDATE', [spaceId])
  }

  it('判断过能新建之后、取空间的锁之前，空间被归档：锁下再判断，403，不新建', async () => {
    const spaceId = await teamSpace('归档竞争')
    const response = await raceAgainstHeldLock(database, {
      hold: lockSpaceRow(spaceId),
      request: async () => create(amySession, { spaceId }),
      change: async client => client.query('UPDATE spaces SET status = \'archived\' WHERE id = $1', [spaceId]),
    })
    expect(response.status).toBe(403)
    expect(await count('SELECT count(*) FROM documents WHERE space_id = $1', [spaceId])).toBe(0)
  })

  it('判断过能新建之后、取空间的锁之前，被移出空间：锁下再判断，404，不新建', async () => {
    const spaceId = await teamSpace('移出竞争')
    const response = await raceAgainstHeldLock(database, {
      hold: lockSpaceRow(spaceId),
      request: async () => create(amySession, { spaceId }),
      change: async client => client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, amy.id]),
    })
    expect(response.status).toBe(404)
    expect(await count('SELECT count(*) FROM documents WHERE space_id = $1', [spaceId])).toBe(0)
  })
})

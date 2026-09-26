// 文档的列表与元数据（P3 设计 §3.6，US-M1-03、US-M1-08）：只列本人个人空间的文档、分页、访问策略、默认拒绝。
import type { DocumentListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { documentDetailSchema, documentListResponseSchema, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount
let bob: TestAccount
let carol: TestAccount
let aliceSession: LoggedIn
let carolSession: LoggedIn
const aliceDocuments: string[] = []
let bobDocument: string

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'alice' })
  bob = await createAccount(database, { username: 'bob' })
  carol = await createAccount(database, { username: 'carol' })
  // 爱丽丝的 5 份文档：更新时间各不相同，另有两份同一时刻（分页不能因为时间相同而跳过或重复）
  for (const [title, age] of [['最新', '1 minute'], ['第二', '2 minutes'], ['同时甲', '3 minutes'], ['同时乙', '3 minutes'], ['最早', '4 minutes']] as const)
    aliceDocuments.push(await createDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title, updatedAt: `date_trunc('second', now()) - interval '${age}'` }))
  bobDocument = await createDocument(database, { spaceId: bob.personalSpaceId, createdBy: bob.id, title: '鲍勃的文档' })
  aliceSession = await login(app.baseUrl, 'alice', alice.password)
  carolSession = await login(app.baseUrl, 'carol', carol.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function list(user: LoggedIn, query = ''): Promise<DocumentListResponse> {
  const response = await asUser(app.baseUrl, user, `/api/documents${query}`)
  expect(response.status).toBe(200)
  return documentListResponseSchema.parse(await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = errorResponseSchema.parse(await response.json()).error
  return { code, message }
}

describe('US-M1-03 个人空间的文档列表', () => {
  it('只列本人个人空间里的文档，按更新时间从新到旧；时间相同的按 id', async () => {
    const page = await list(aliceSession)
    expect(page.items.map(item => item.title).slice(0, 2)).toEqual(['最新', '第二'])
    expect(page.items.map(item => item.title).slice(2, 4).sort()).toEqual(['同时乙', '同时甲'])
    expect(page.items.at(-1)?.title).toBe('最早')
    expect(page.items.map(item => item.id)).not.toContain(bobDocument)
    expect(page.nextCursor).toBeNull()
    expect(page.items[0]).toMatchObject({ type: 'sheet', createdAt: expect.stringMatching(/Z$/) as unknown, updatedAt: expect.stringMatching(/Z$/) as unknown })
  })

  it('空的个人空间：空列表', async () => {
    expect(await list(carolSession)).toEqual({ items: [], nextCursor: null })
  })

  it('分页：按游标逐页取完，不丢、不重（包括更新时间相同的两份）', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: DocumentListResponse = await list(aliceSession, `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`)
      seen.push(...page.items.map(item => item.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(5)
    expect(new Set(seen)).toEqual(new Set(aliceDocuments))
  })

  it('更新时间只差 1 微秒的两份文档，一页一条也不丢（游标保留微秒）', async () => {
    const dave = await createAccount(database, { username: 'dave' })
    const earlier = await createDocument(database, { spaceId: dave.personalSpaceId, createdBy: dave.id, title: '早 1 微秒', updatedAt: `'2026-09-26 08:00:00.000001+00'` })
    const later = await createDocument(database, { spaceId: dave.personalSpaceId, createdBy: dave.id, title: '晚 1 微秒', updatedAt: `'2026-09-26 08:00:00.000002+00'` })
    const daveSession = await login(app.baseUrl, 'dave', dave.password)
    const first = await list(daveSession, '?limit=1')
    const second = await list(daveSession, `?limit=1&cursor=${first.nextCursor ?? ''}`)
    expect([...first.items, ...second.items].map(item => item.id)).toEqual([later, earlier])
    expect(second.nextCursor).toBeNull()
  })

  it('每页条数不合法、游标不合法：400 REQUEST_INVALID', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?cursor=not-a-cursor', '?sort=title']) {
      const response = await asUser(app.baseUrl, aliceSession, `/api/documents${query}`)
      expect(response.status, query).toBe(400)
      expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
    }
  })

  it('没有登录：401 UNAUTHENTICATED', async () => {
    const response = await fetch(`${app.baseUrl}/api/documents`)
    expect(response.status).toBe(401)
    expect((await errorOf(response)).code).toBe('UNAUTHENTICATED')
  })
})

describe('US-M1-08 文档的元数据：别人的与不存在的结果相同', () => {
  it('自己的文档：元数据与权限', async () => {
    const response = await asUser(app.baseUrl, aliceSession, `/api/documents/${aliceDocuments[0] ?? ''}`)
    expect(response.status).toBe(200)
    expect(documentDetailSchema.parse(await response.json())).toMatchObject({
      id: aliceDocuments[0],
      title: '最新',
      type: 'sheet',
      spaceId: alice.personalSpaceId,
      permissions: { canEdit: true },
    })
  })

  it('别人的文档与不存在的文档：同样的 404 与说明', async () => {
    const others = await asUser(app.baseUrl, aliceSession, `/api/documents/${bobDocument}`)
    const missing = await asUser(app.baseUrl, aliceSession, `/api/documents/${randomUUID()}`)
    expect(others.status).toBe(404)
    expect(missing.status).toBe(404)
    const [first, second] = [await errorOf(others), await errorOf(missing)]
    expect(first).toEqual({ code: 'NOT_FOUND', message: '请求的资源不存在或无权访问' })
    expect(second).toEqual(first)
  })

  it('id 不是 UUID：400 REQUEST_INVALID', async () => {
    const response = await asUser(app.baseUrl, aliceSession, '/api/documents/not-a-uuid')
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
  })

  it('没有登录：401，不论文档是否存在', async () => {
    for (const id of [aliceDocuments[0] ?? '', randomUUID()]) {
      const response = await fetch(`${app.baseUrl}/api/documents/${id}`)
      expect(response.status).toBe(401)
      expect((await errorOf(response)).code).toBe('UNAUTHENTICATED')
    }
  })
})

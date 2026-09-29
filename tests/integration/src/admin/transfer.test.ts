// 停用者文档的转移（M2-P2 设计 §3.8，US-M2-04）：只对停用的账户；系统管理员只看得到标题，打不开内容；
// 整批转移到有效账户的个人空间或没有归档的团队空间，写入代次加一、更新时间不变，每份文档一条审计；
// 整批拒绝与各种不可用；并发（两个连接构造的交错）：启用与转移、同一份文档的两次转移、目标被归档。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { adminUserDocumentListResponseSchema, adminUserSchema, errorResponseSchema, transferDocumentsResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument } from '../support/documents.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let people = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一个停用的账户，个人空间里有给定标题的文档 */
async function leaver(titles: readonly string[]): Promise<{ id: string, spaceId: string, documents: string[] }> {
  people += 1
  const account = await createPassiveAccount(database, { username: `leaver-${people}`, status: 'disabled' })
  const documents: string[] = []
  for (const [index, title] of titles.entries())
    documents.push(await createDocument(database, { spaceId: account.personalSpaceId, createdBy: account.id, title, updatedAt: `now() - interval '${index} minutes'` }))
  return { id: account.id, spaceId: account.personalSpaceId, documents }
}

/** 一个团队空间：艾米是编辑者 */
async function teamSpace(options: { status?: 'active' | 'archived' } = {}): Promise<string> {
  people += 1
  return createTeamSpace(database, { name: `接收 ${people}`, createdBy: root.id, members: { [amy.id]: 'editor' }, ...options })
}

async function transfer(userId: string, body: unknown, session: LoggedIn = rootSession): Promise<Response> {
  return asUser(app.baseUrl, session, `/api/admin/users/${userId}/documents/transfer`, { method: 'POST', body })
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function rowsOf(ids: readonly string[]) {
  return database.query(async client => (await client.query<{ id: string, space_id: string, write_epoch: number, updated_at: Date }>(
    'SELECT id, space_id, write_epoch, updated_at FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  )).rows)
}

describe('US-M2-04 停用者的文档：只看得到标题', () => {
  it('标题列表：只有标题、类型与更新时间，按更新时间从新到旧；分页', async () => {
    const titles = Array.from({ length: 51 }, (_, index) => `文档 ${String(index).padStart(2, '0')}`)
    const gone = await leaver(titles)
    const first = await asUser(app.baseUrl, rootSession, `/api/admin/users/${gone.id}/documents`)
    expect(first.status).toBe(200)
    const page = parseExact(adminUserDocumentListResponseSchema, await first.json())
    expect(page.items).toHaveLength(50)
    expect(page.items[0]).toEqual({ id: gone.documents[0], title: '文档 00', type: 'sheet', updatedAt: expect.stringMatching(/Z$/) as unknown })
    const next = parseExact(adminUserDocumentListResponseSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/users/${gone.id}/documents?cursor=${page.nextCursor ?? ''}`)).json())
    expect(next).toEqual({ items: [expect.objectContaining({ title: '文档 50' })], nextCursor: null })
  })

  it('系统管理员打不开停用者的文档：内容与元数据都是 404', async () => {
    const gone = await leaver(['机密'])
    for (const path of [`/api/documents/${gone.documents[0]}`, `/api/documents/${gone.documents[0]}/content`])
      expect((await asUser(app.baseUrl, rootSession, path)).status, path).toBe(404)
  })

  it('转移页的页头：按 id 取一个账户（含停用的）；不存在 404；成员 403', async () => {
    const gone = await leaver([])
    const response = await asUser(app.baseUrl, rootSession, `/api/admin/users/${gone.id}`)
    expect(response.status).toBe(200)
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ id: gone.id, status: 'disabled', systemRole: 'member' })
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${randomUUID()}`)).status).toBe(404)
    expect((await asUser(app.baseUrl, amySession, `/api/admin/users/${gone.id}`)).status).toBe(403)
  })

  it('账户仍然有效：409 ACCOUNT_NOT_DISABLED（个人空间对系统管理员不可见）；账户不存在：404', async () => {
    const active = await asUser(app.baseUrl, rootSession, `/api/admin/users/${amy.id}/documents`)
    expect(active.status).toBe(409)
    expect((await errorOf(active)).code).toBe('ACCOUNT_NOT_DISABLED')
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${randomUUID()}/documents`)).status).toBe(404)
  })

  it('成员访问：403；没有登录：401', async () => {
    const gone = await leaver([])
    for (const response of [
      await asUser(app.baseUrl, amySession, `/api/admin/users/${gone.id}/documents`),
      await transfer(gone.id, { documentIds: [randomUUID()], target: { type: 'personal', userId: amy.id } }, amySession),
    ]) {
      expect(response.status).toBe(403)
      expect((await errorOf(response)).code).toBe('PERMISSION_DENIED')
    }
    expect((await fetch(`${app.baseUrl}/api/admin/users/${gone.id}/documents`)).status).toBe(401)
  })
})

describe('US-M2-04 转移停用者的文档', () => {
  it('转移到团队空间：空间的成员随即能打开；写入代次加一、更新时间不变；每份一条审计（不记标题）', async () => {
    const gone = await leaver(['周报', '月报', '留下的'])
    const spaceId = await teamSpace()
    const moving = gone.documents.slice(0, 2)
    const before = await rowsOf(moving)
    const response = await transfer(gone.id, { documentIds: moving, target: { type: 'team', spaceId } })
    expect(response.status).toBe(200)
    expect(parseExact(transferDocumentsResponseSchema, await response.json())).toEqual({ transferred: 2 })

    const after = await rowsOf(moving)
    expect(after.map(row => [row.space_id, row.write_epoch])).toEqual(before.map(() => [spaceId, 1]))
    expect(after.map(row => row.updated_at.toISOString())).toEqual(before.map(row => row.updated_at.toISOString()))
    for (const id of moving)
      expect((await asUser(app.baseUrl, amySession, `/api/documents/${id}`)).status).toBe(200)
    const remaining = parseExact(adminUserDocumentListResponseSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/users/${gone.id}/documents`)).json())
    expect(remaining.items.map(item => item.title)).toEqual(['留下的'])

    const audits = await database.query(async client => (await client.query<{ target_id: string, actor_id: string, details: unknown }>(
      'SELECT target_id, actor_id, details FROM audit_events WHERE action = \'documents.transferred\' AND target_id = ANY($1::uuid[]) ORDER BY target_id',
      [moving],
    )).rows)
    expect(audits).toEqual([...moving].sort().map(id => ({ target_id: id, actor_id: root.id, details: { fromSpaceId: gone.spaceId, toSpaceId: spaceId } })))
  })

  it('转移到另一个有效账户的个人空间：他在自己的列表里看到', async () => {
    const gone = await leaver(['交接清单'])
    const response = await transfer(gone.id, { documentIds: gone.documents, target: { type: 'personal', userId: amy.id } })
    expect(response.status).toBe(200)
    const mine = await (await asUser(app.baseUrl, amySession, '/api/documents')).json() as { items: { id: string }[] }
    expect(mine.items.map(item => item.id)).toContain(gone.documents[0])
  })

  it('有一份不在他的个人空间里（别人的、不存在的、已经转走的）：整批拒绝，409 TRANSFER_CONFLICT，一份也不动', async () => {
    const gone = await leaver(['甲', '乙'])
    const spaceId = await teamSpace()
    const others = await createDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '艾米的' })
    for (const stranger of [others, randomUUID()]) {
      const response = await transfer(gone.id, { documentIds: [...gone.documents, stranger], target: { type: 'team', spaceId } })
      expect(response.status).toBe(409)
      expect((await errorOf(response)).code).toBe('TRANSFER_CONFLICT')
    }
    expect((await rowsOf(gone.documents)).map(row => row.space_id)).toEqual([gone.spaceId, gone.spaceId])
    // 转走一份之后，再转同一批：整批拒绝
    expect((await transfer(gone.id, { documentIds: [gone.documents[0]], target: { type: 'team', spaceId } })).status).toBe(200)
    expect((await transfer(gone.id, { documentIds: gone.documents, target: { type: 'team', spaceId } })).status).toBe(409)
  })

  it('目标不可用：已归档 409 SPACE_ARCHIVED；团队空间不存在或其实是个人空间 404；目标账户停用或不存在 409 ACCOUNT_UNAVAILABLE；来源有效 409 ACCOUNT_NOT_DISABLED', async () => {
    const gone = await leaver(['文档'])
    const other = await leaver([])
    const cases: [string, unknown, number, string][] = [
      [gone.id, { type: 'team', spaceId: await teamSpace({ status: 'archived' }) }, 409, 'SPACE_ARCHIVED'],
      [gone.id, { type: 'team', spaceId: randomUUID() }, 404, 'NOT_FOUND'],
      [gone.id, { type: 'team', spaceId: amy.personalSpaceId }, 404, 'NOT_FOUND'],
      [gone.id, { type: 'personal', userId: other.id }, 409, 'ACCOUNT_UNAVAILABLE'],
      [gone.id, { type: 'personal', userId: randomUUID() }, 409, 'ACCOUNT_UNAVAILABLE'],
      [amy.id, { type: 'personal', userId: root.id }, 409, 'ACCOUNT_NOT_DISABLED'],
    ]
    for (const [userId, target, status, code] of cases) {
      const response = await transfer(userId, { documentIds: gone.documents, target })
      expect(response.status, JSON.stringify(target)).toBe(status)
      expect((await errorOf(response)).code).toBe(code)
    }
    expect((await rowsOf(gone.documents))[0]?.space_id).toBe(gone.spaceId)
  })
})

describe('US-M2-04 转移的并发', () => {
  it('转移时账户正被启用：等启用提交，按启用之后的状态拒绝（409 ACCOUNT_NOT_DISABLED），不转移', async () => {
    const gone = await leaver(['文档'])
    const spaceId = await teamSpace()
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [gone.id]),
      request: async () => transfer(gone.id, { documentIds: gone.documents, target: { type: 'team', spaceId } }),
      change: async client => client.query('UPDATE users SET status = \'active\' WHERE id = $1', [gone.id]),
    })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('ACCOUNT_NOT_DISABLED')
    expect((await rowsOf(gone.documents))[0]?.space_id).toBe(gone.spaceId)
  })

  it('同一份文档正被另一次转移转走：等它提交，整批拒绝（409 TRANSFER_CONFLICT）', async () => {
    const gone = await leaver(['文档'])
    const [first, second] = [await teamSpace(), await teamSpace()]
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [gone.documents[0]]),
      request: async () => transfer(gone.id, { documentIds: gone.documents, target: { type: 'team', spaceId: second } }),
      change: async client => client.query('UPDATE documents SET space_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [gone.documents[0], first]),
    })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('TRANSFER_CONFLICT')
    expect((await rowsOf(gone.documents)).map(row => [row.space_id, row.write_epoch])).toEqual([[first, 1]])
  })

  it('转移时目标空间正被归档：等归档提交，409 SPACE_ARCHIVED，不转移', async () => {
    const gone = await leaver(['文档'])
    const spaceId = await teamSpace()
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR NO KEY UPDATE', [spaceId]),
      request: async () => transfer(gone.id, { documentIds: gone.documents, target: { type: 'team', spaceId } }),
      change: async client => client.query('UPDATE spaces SET status = \'archived\' WHERE id = $1', [spaceId]),
    })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('SPACE_ARCHIVED')
  })
})

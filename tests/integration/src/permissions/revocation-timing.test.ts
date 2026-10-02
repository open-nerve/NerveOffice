// 生效时机（M2-P5 设计 §3.4(5)，US-M2-14、上线门槛 A03）：取消分享、移出空间、停用之后，下一次请求即生效——
// 读、保存、复制、"与我共享"、搜索。授权与空间事实都是每个请求重新读的，没有缓存。都经接口触发（真实的写入与提交）。
//
// 已有的用例不重复，逐条在这里对照（S4 核对 S1、S2 与之前各 Phase 的测试）：
// - 取消分享：打开与读内容 404、与不存在逐字相同（documents/sharing.test.ts「取消」）；保存 404（documents/grants.test.ts，删行之后）；
//   "与我共享"里没有了、搜索搜不到（sharing.test.ts 的"与我共享"与搜索两条）；降为查看者之后保存 403（sharing.test.ts「调整」）；
//   取消与进行中的保存、复制互斥（documents/sharing-locks.test.ts 的确定交错）。
// - 移出空间：空间、按空间列出、打开、读内容 404（spaces/members.test.ts「移出」）；保存 404（documents/team-spaces.test.ts
//   「已经打开的编辑器」）；授权不动、改由授权打开且不带文件夹（sharing.test.ts「授权跟着文档走」）；复制与移出的交错（copy-locks.test.ts）。
// - 停用：会话全部撤销、登录不了（admin/users.test.ts「停用」，只核对了会话接口）；授权保留、启用之后照常（sharing.test.ts）。
// 这里补上没有覆盖的：取消之后的保存（经接口取消）与复制，降为查看者之后仍能读、能复制；移出之后的复制、搜索与"与我共享"的变化；
// 停用之后文档的读、写、复制、"与我共享"、搜索。
import type { SearchResponse, SharedListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createdDocumentSchema, createdFolderSchema, errorResponseSchema, searchResponseSchema, sharedListResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { comparableOf } from '../support/comparable-response.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { grantsOn } from '../support/grants.ts'
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
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一个新的同事（每条用例各用各的） */
async function colleague(): Promise<{ readonly account: TestAccount, readonly session: LoggedIn }> {
  people += 1
  const account = await createAccount(database, { username: `timing-${people}` })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

async function save(user: LoggedIn, documentId: string, unitId: string): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId }), 'utf8')
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/content?${query.toString()}`, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(raw) },
  })
}

async function copy(user: LoggedIn, documentId: string, spaceId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/copy`, { method: 'POST', body: { spaceId, requestId: randomUUID() } })
}

async function shared(user: LoggedIn): Promise<SharedListResponse> {
  const response = await asUser(app.baseUrl, user, '/api/shared')
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(sharedListResponseSchema, await response.json())
}

async function search(user: LoggedIn, query: string): Promise<SearchResponse> {
  const response = await asUser(app.baseUrl, user, `/api/search?query=${encodeURIComponent(query)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(searchResponseSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ status: number, code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, message }
}

async function share(documentId: string, userId: string, role: 'viewer' | 'editor'): Promise<void> {
  const response = await asUser(app.baseUrl, amySession, `/api/documents/${documentId}/grants/${userId}`, { method: 'PUT', body: { role } })
  expect(response.status, await response.clone().text()).toBe(200)
}

/** 这个人在这份文档上的授权角色（直接查库）；没有时为 undefined */
async function grantRole(documentId: string, userId: string): Promise<string | undefined> {
  return (await grantsOn(database, [documentId])).find(grant => grant.userId === userId)?.role
}

describe('US-M2-14 生效时机：取消分享、移出空间、停用之后，下一次请求即生效（M2-P5 设计 §3.4(5)）', () => {
  it('分享（经接口）降为查看者之后：下一次保存 403，仍能读、能复制；取消之后：保存与复制都与不存在的文档逐字相同（404），"与我共享"里没有了', async () => {
    const { account: ben, session: benSession } = await colleague()
    const spaceId = await createTeamSpace(database, { name: '取消的时机', createdBy: root.id, members: { [amy.id]: 'admin' } })
    const document: SeededDocument = await seedDocument(database, { spaceId, createdBy: amy.id, title: '取消的时机' })
    await share(document.id, ben.id, 'editor')
    // 前提：编辑授权确实生效（本不是这个空间的成员，只凭授权）
    expect((await save(benSession, document.id, document.unitId)).status).toBe(200)

    await share(document.id, ben.id, 'viewer')
    expect(await grantRole(document.id, ben.id)).toBe('viewer')
    expect(await errorOf(await save(benSession, document.id, document.unitId))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能保存' })
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/content`)).status).toBe(200)
    const copied = await copy(benSession, document.id, ben.personalSpaceId)
    expect(copied.status, await copied.clone().text()).toBe(201)
    expect(parseExact(createdDocumentSchema, await copied.json()).spaceId).toBe(ben.personalSpaceId)

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${ben.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await grantRole(document.id, ben.id)).toBeUndefined()
    const missing = randomUUID()
    const savedAfter = await save(benSession, document.id, document.unitId)
    expect(savedAfter.status).toBe(404)
    expect(await comparableOf(savedAfter)).toEqual(await comparableOf(await save(benSession, missing, randomUUID())))
    const copiedAfter = await copy(benSession, document.id, ben.personalSpaceId)
    expect(copiedAfter.status).toBe(404)
    expect(await comparableOf(copiedAfter)).toEqual(await comparableOf(await copy(benSession, missing, ben.personalSpaceId)))
    expect((await shared(benSession)).items).toEqual([])
    // 只复制出了降级之后那一份：取消之后的复制什么也没建
    expect(await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM documents WHERE space_id = $1', [ben.personalSpaceId])).rows[0]?.count)).toBe(1)
  })

  it('移出空间（经接口）之后：复制 404；搜索里没有授权的那份不见了，有授权的那份改为凭授权命中、不带文件夹与路径；"与我共享"里的内容权限降为授权的角色', async () => {
    const { account: ben, session: benSession } = await colleague()
    const spaceId = await createTeamSpace(database, { name: '移出的时机', createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' } })
    const folderResponse = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, name: '移出前的目录', requestId: randomUUID() } })
    const folderId = parseExact(createdFolderSchema, await folderResponse.json()).id
    const notShared = await seedDocument(database, { spaceId, createdBy: amy.id, title: '移出时机 没分享的', updatedAt: 'now() - interval \'1 minute\'' })
    const alsoShared = await seedDocument(database, { spaceId, createdBy: amy.id, title: '移出时机 也分享了的', folderId })
    await share(alsoShared.id, ben.id, 'viewer')
    // 前提：移出之前凭空间角色看到两份，有授权的那份带着文件夹；"与我共享"里内容权限是较高的空间角色（编辑者）；复制得出来
    // （副本在他自己的个人空间里，标题相同，所以下面的搜索只看这个团队空间里的）
    const inTeam = (page: SearchResponse) => page.items.filter(item => item.space.id === spaceId)
    const before = inTeam(await search(benSession, '移出时机'))
    expect(before.map(item => [item.id, item.accessVia, item.folderPath])).toEqual([[alsoShared.id, 'space', ['移出前的目录']], [notShared.id, 'space', []]])
    expect((await shared(benSession)).items.map(item => [item.id, item.contentRole])).toEqual([[alsoShared.id, 'editor']])
    expect((await copy(benSession, notShared.id, ben.personalSpaceId)).status).toBe(201)

    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'DELETE' })).status).toBe(204)
    const copiedAfter = await copy(benSession, notShared.id, ben.personalSpaceId)
    expect(copiedAfter.status).toBe(404)
    expect(await comparableOf(copiedAfter)).toEqual(await comparableOf(await copy(benSession, randomUUID(), ben.personalSpaceId)))
    const after = await search(benSession, '移出时机')
    expect(inTeam(after).map(item => item.id)).toEqual([alsoShared.id])
    expect(inTeam(after)[0]).toMatchObject({ accessVia: 'grant', folderId: null, folderPath: [] })
    expect(JSON.stringify(after)).not.toContain('移出前的目录')
    expect((await shared(benSession)).items.map(item => [item.id, item.contentRole])).toEqual([[alsoShared.id, 'viewer']])
    // 有授权的那份仍能复制（复制是内容的操作），保存只剩授权的查看者：403
    expect((await copy(benSession, alsoShared.id, ben.personalSpaceId)).status).toBe(201)
    expect(await errorOf(await save(benSession, alsoShared.id, alsoShared.unitId))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能保存' })
  })

  it('停用（经接口）之后：他已登录的会话里读、读内容、保存、复制、"与我共享"、搜索一律 401（会话已撤销），什么也没改；他的授权还在', async () => {
    const { account: ben, session: benSession } = await colleague()
    const document = await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '停用的时机' })
    await share(document.id, ben.id, 'editor')
    // 前提：停用之前样样都行
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`)).status).toBe(200)
    expect((await shared(benSession)).items.map(item => item.id)).toEqual([document.id])
    expect((await search(benSession, '停用的时机')).items.map(item => item.id)).toEqual([document.id])

    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${ben.id}/disable`, { method: 'POST' })).status).toBe(200)
    const requests: readonly (readonly [string, () => Promise<Response>])[] = [
      ['读', async () => asUser(app.baseUrl, benSession, `/api/documents/${document.id}`)],
      ['读内容', async () => asUser(app.baseUrl, benSession, `/api/documents/${document.id}/content`)],
      ['保存', async () => save(benSession, document.id, document.unitId)],
      ['复制', async () => copy(benSession, document.id, ben.personalSpaceId)],
      ['与我共享', async () => asUser(app.baseUrl, benSession, '/api/shared')],
      ['搜索', async () => asUser(app.baseUrl, benSession, `/api/search?query=${encodeURIComponent('停用的时机')}`)],
    ]
    for (const [name, request] of requests)
      expect(await errorOf(await request()), name).toMatchObject({ status: 401, code: 'SESSION_EXPIRED' })
    const state = await database.query(async client => ({
      revision: (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [document.id])).rows[0]?.revision,
      copies: (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM documents WHERE space_id = $1', [ben.personalSpaceId])).rows[0]?.count,
    }))
    expect(state).toEqual({ revision: 1, copies: 0 })
    expect(await grantRole(document.id, ben.id)).toBe('editor')
  })
})

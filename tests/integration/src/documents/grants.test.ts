// 单独授权的数据模型与有效权限（M2-P5 设计 §3.3、§3.4(1)(2)，S1；US-M2-10、14）。授权直接写库（分享的接口在 S2）：
// - 有效权限并上授权：内容权限取较高者（保存、改名、复制看它），结构性的操作只看空间角色——只凭授权的人移动、删除一律 403，
//   详情不带所在的文件夹（不给目录结构）；归档的空间里授权一律降为查看者；空间管理员另有授权仍是空间管理员；
// - 授权不给空间里的任何东西开口子：空间页、按空间列出、文件夹、回收站、成员都与不存在的空间一样 404；
// - "可访问文档"的两半（仓储直接核对）；复制不带授权；取消（删行）之后与不存在一样；
// - 永久删除连带删授权（外键级联，ADR-016），进回收站与恢复都不动授权；
// - spaces 按一批 id 取空间事实（"与我共享"与搜索要用）：一条语句，id 是一个数组参数。
import type { DocumentDetail, SpaceRole } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { SpacesService } from '@nerve-office/api'
import { DocumentsRepository } from '@nerve-office/api/testing'
import { createdDocumentSchema, createdFolderSchema, documentDetailSchema, documentListResponseSchema, errorResponseSchema, SHEET_TEMPLATE, spaceListResponseSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { grantsOn, removeGrant, setGrant } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let cat: TestAccount
let amySession: LoggedIn
let benSession: LoggedIn
let catSession: LoggedIn
let spaces = 0

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

/** 一个新的团队空间：艾米是空间管理员；凯特默认是查看者；本不是成员（他只凭授权） */
async function teamSpace(options: { readonly cat?: SpaceRole | undefined, readonly visibleToAll?: boolean } = {}): Promise<string> {
  spaces += 1
  const members: Record<string, SpaceRole> = { [amy.id]: 'admin' }
  const catRole = 'cat' in options ? options.cat : 'viewer'
  if (catRole !== undefined)
    members[cat.id] = catRole
  return createTeamSpace(database, { name: `授权 ${spaces}`, createdBy: root.id, members, visibleToAll: options.visibleToAll ?? false })
}

async function newFolder(user: LoggedIn, spaceId: string, name: string, parentId?: string): Promise<string> {
  const response = await asUser(app.baseUrl, user, '/api/folders', { method: 'POST', body: { spaceId, name, requestId: randomUUID(), ...(parentId === undefined ? {} : { parentId }) } })
  expect(response.status).toBe(201)
  return parseExact(createdFolderSchema, await response.json()).id
}

async function open(user: LoggedIn, id: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}`)
}

async function detailOf(user: LoggedIn, id: string): Promise<DocumentDetail> {
  const response = await open(user, id)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(documentDetailSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ status: number, code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { status: response.status, code, message }
}

/** 保存（M3-P1 起要求编辑租约）：先以这个人申请、保存之后释放（support/edit-leases.ts）；申请不了的人照样发出，结果由先于租约的判断给出 */
async function save(user: LoggedIn, document: SeededDocument, baseRevision: number): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, user, document.id, zlib.gzipSync(raw), { baseRevision })
}

async function patch(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}`, { method: 'PATCH', body })
}

async function move(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}/move`, { method: 'POST', body })
}

/** 文档现在在哪里、是什么状态（直接查库） */
async function stored(id: string): Promise<{ readonly spaceId: string, readonly folderId: string | null, readonly status: string, readonly title: string } | undefined> {
  return database.query(async client => (await client.query<{ spaceId: string, folderId: string | null, status: string, title: string }>(
    'SELECT space_id AS "spaceId", folder_id AS "folderId", status, title FROM documents WHERE id = $1',
    [id],
  )).rows[0])
}

/** 回收站里这份文档所在的删除单元 */
async function entryOf(documentId: string): Promise<string> {
  const entry = await database.query(async client => (await client.query<{ trash_entry_id: string | null }>('SELECT trash_entry_id FROM documents WHERE id = $1', [documentId])).rows[0]?.trash_entry_id)
  if (entry === undefined || entry === null)
    throw new Error(`文档不在回收站里：${documentId}`)
  return entry
}

const SHARED_ONLY_MOVE = { status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能移动' }
const SHARED_ONLY_DELETE = { status: 403, code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能删除' }

describe('US-M2-10 有效权限并上单独授权：内容取较高者，结构只看空间角色（M2-P5 设计 §3.4(1)）', () => {
  it('只凭授权的查看者：能打开与读取内容，详情不带所在的文件夹、途径是 grant；不能保存、不能改名', async () => {
    const spaceId = await teamSpace()
    const folderId = await newFolder(amySession, spaceId, '资料')
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '只读的周报', folderId })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'viewer', grantedBy: amy.id })

    expect(await detailOf(benSession, document.id)).toMatchObject({
      spaceId,
      folderId: null,
      accessVia: 'grant',
      permissions: { canEdit: false, canRename: false, canCopy: true, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false, canShare: false },
    })
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/content`)).status).toBe(200)
    expect(await errorOf(await save(benSession, document, 1))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
    expect(await errorOf(await patch(benSession, document.id, { title: '改了' }))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '没有给这份文档改名的权限' })
    // 空间里的人照常看到文件夹
    expect(await detailOf(amySession, document.id)).toMatchObject({ folderId, accessVia: 'space', permissions: { canShare: true } })
  })

  it('只凭授权的编辑者：能保存、改名（响应不带文件夹）；空间内移动、PATCH {folderId}、跨空间移动、删除都 403——他是创建人也不能删，文档原地不动', async () => {
    const spaceId = await teamSpace()
    const folderId = await newFolder(amySession, spaceId, '方案')
    // 本创建的、后来他不在这个空间里了：只凭授权
    const document = await seedDocument(database, { spaceId, createdBy: ben.id, title: '他写的方案', folderId })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'editor', grantedBy: amy.id })

    expect((await save(benSession, document, 1)).status).toBe(200)
    const renamed = await patch(benSession, document.id, { title: '方案（定稿）' })
    expect(renamed.status).toBe(200)
    expect(parseExact(documentDetailSchema, await renamed.json())).toMatchObject({ title: '方案（定稿）', folderId: null, accessVia: 'grant', revision: 2 })

    // PATCH {folderId}：根目录、它自己所在的文件夹、不存在的 id 都是同一个 403——不能借 200 与 404 分辨某个 id 是不是这个空间的文件夹
    for (const target of [null, folderId, randomUUID()])
      expect(await errorOf(await patch(benSession, document.id, { folderId: target })), String(target)).toEqual(SHARED_ONLY_MOVE)
    expect(await errorOf(await patch(benSession, document.id, { title: '又改了', folderId: null }))).toEqual(SHARED_ONLY_MOVE)
    expect(await errorOf(await move(benSession, document.id, { spaceId }))).toEqual(SHARED_ONLY_MOVE)
    expect(await errorOf(await move(benSession, document.id, { spaceId, folderId }))).toEqual(SHARED_ONLY_MOVE)
    expect(await errorOf(await move(benSession, document.id, { spaceId: ben.personalSpaceId }))).toEqual(SHARED_ONLY_MOVE)
    expect(await errorOf(await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`, { method: 'DELETE' }))).toEqual(SHARED_ONLY_DELETE)

    expect(await stored(document.id)).toEqual({ spaceId, folderId, status: 'active', title: '方案（定稿）' })
  })

  it('取较高者：空间里的查看者另有编辑授权，能保存；结构性的操作仍按空间角色（不能移动），详情照常带文件夹、途径是 space', async () => {
    const spaceId = await teamSpace({ cat: 'viewer' })
    const folderId = await newFolder(amySession, spaceId, '共享')
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '一起改的表', folderId })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })

    expect(await detailOf(catSession, document.id)).toMatchObject({
      folderId,
      accessVia: 'space',
      permissions: { canEdit: true, canRename: true, canMoveWithinSpace: false, canDelete: false, canShare: false },
    })
    expect((await save(catSession, document, 1)).status).toBe(200)
    expect(await errorOf(await patch(catSession, document.id, { folderId: null }))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '没有移动这份文档的权限' })
  })

  it('授权不覆盖空间角色：空间管理员另有查看授权，仍是空间管理员；全员可见的查看者另有编辑授权，能保存', async () => {
    const spaceId = await teamSpace({ cat: undefined, visibleToAll: true })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '公告' })
    await setGrant(database, { documentId: document.id, userId: amy.id, role: 'viewer', grantedBy: root.id })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })

    expect((await detailOf(amySession, document.id)).permissions).toEqual({ canEdit: true, canRename: true, canCopy: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true, canShare: true })
    expect(await detailOf(catSession, document.id)).toMatchObject({ accessVia: 'space', permissions: { canEdit: true, canMoveWithinSpace: false } })
    expect((await save(catSession, document, 1)).status).toBe(200)
  })

  it('归档的空间里授权一律降为查看者：编辑授权能读、不能保存（说明空间已归档）；删除仍说明是单独分享的', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '旧项目的表' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'editor', grantedBy: amy.id })
    await setSpaceState(database, spaceId, { status: 'archived' })

    expect(await detailOf(benSession, document.id)).toMatchObject({ accessVia: 'grant', folderId: null, permissions: { canEdit: false, canRename: false, canCopy: true, canShare: false } })
    expect(await errorOf(await save(benSession, document, 1))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(await errorOf(await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`, { method: 'DELETE' }))).toEqual(SHARED_ONLY_DELETE)
    // 空间管理员归档之后同样不能分享
    expect((await detailOf(amySession, document.id)).permissions.canShare).toBe(false)
  })

  it('复制：只凭授权的人能复制到自己有新建权限的空间，副本照常带文件夹；副本不带原文档的授权（§3.4(6)）；复制回看不到的空间与不存在一样', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '可以复制的' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'viewer', grantedBy: amy.id })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })
    const folderId = await newFolder(benSession, ben.personalSpaceId, '收集')

    const response = await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId: ben.personalSpaceId, folderId, requestId: randomUUID() } })
    expect(response.status).toBe(201)
    const copy = parseExact(createdDocumentSchema, await response.json())
    expect(copy).toMatchObject({ spaceId: ben.personalSpaceId, folderId, accessVia: 'space', permissions: { canEdit: true, canShare: true } })
    expect(await grantsOn(database, [copy.id])).toEqual([])
    expect((await grantsOn(database, [document.id])).map(grant => grant.userId).toSorted()).toEqual([ben.id, cat.id].toSorted())

    const back = await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId, requestId: randomUUID() } })
    const missing = await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId: randomUUID(), requestId: randomUUID() } })
    expect(await errorOf(back)).toEqual(await errorOf(missing))
    expect(back.status).toBe(404)
  })

  it('别人的个人空间里分享给我的文档：只凭授权能打开；那个空间与它的文档列表对我仍是不存在', async () => {
    const owner = await createPassiveAccount(database, { username: 'grant-owner', displayName: '所有者' })
    const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '私人笔记' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'viewer', grantedBy: owner.id })
    expect(await detailOf(benSession, document.id)).toMatchObject({ spaceId: owner.personalSpaceId, accessVia: 'grant', folderId: null })
    expect((await asUser(app.baseUrl, benSession, `/api/documents?spaceId=${owner.personalSpaceId}`)).status).toBe(404)
  })
})

describe('US-M2-14 取消授权之后下一次请求即与不存在一样（M2-P5 设计 §3.4(5)）', () => {
  it('删掉授权的行之后：打开、读内容、保存都是 404，与不存在的文档逐字相同；同一份文档上别人的授权不算他的', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '收回的' })
    const keeper = await createPassiveAccount(database, { username: 'grant-keeper' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'editor', grantedBy: amy.id })
    await setGrant(database, { documentId: document.id, userId: keeper.id, role: 'editor', grantedBy: amy.id })
    expect((await open(benSession, document.id)).status).toBe(200)

    await removeGrant(database, document.id, ben.id)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: keeper.id, role: 'editor' }])
    const missingId = randomUUID()
    expect(await errorOf(await open(benSession, document.id))).toEqual(await errorOf(await open(benSession, missingId)))
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/content`)).status).toBe(404)
    expect(await errorOf(await save(benSession, document, 1))).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })
})

describe('US-M2-14 单独授权不给空间里的任何东西开口子（spaceAccessOf 不看授权，M2-P5 设计 §3.4(1)）', () => {
  it('只凭授权的人：空间页头、按空间列出、文件夹、回收站、成员都 404，与不存在的空间逐字相同；导航里没有这个空间', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '分享出去的' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'editor', grantedBy: amy.id })
    // 前提：本确实凭授权看得到这份文档——授权没建上时他就是外人，下面的 404 照样成立，什么也证明不了（M2-P5 审查 A 的一般 4）
    expect((await detailOf(benSession, document.id)).accessVia).toBe('grant')
    const missingSpace = randomUUID()
    const paths = (id: string): string[] => [`/api/spaces/${id}`, `/api/documents?spaceId=${id}`, `/api/folders?spaceId=${id}`, `/api/trash?spaceId=${id}`, `/api/spaces/${id}/members`]
    for (const [index, path] of paths(spaceId).entries()) {
      const hidden = await asUser(app.baseUrl, benSession, path)
      const absent = await asUser(app.baseUrl, benSession, paths(missingSpace)[index] ?? '')
      expect(hidden.status, path).toBe(404)
      expect(await errorOf(hidden), path).toEqual(await errorOf(absent))
    }
    const nav = parseExact(spaceListResponseSchema, await (await asUser(app.baseUrl, benSession, '/api/spaces')).json())
    expect(nav.items.map(item => item.id)).not.toContain(spaceId)
  })

  it('按空间列出不并上授权：分享给我的文档不出现在我自己的空间里', async () => {
    const reader = await createAccount(database, { username: 'grant-reader', displayName: '读者' })
    const readerSession = await login(app.baseUrl, reader.username, reader.password)
    const own = await seedDocument(database, { spaceId: reader.personalSpaceId, createdBy: reader.id, title: '自己的' })
    const spaceId = await teamSpace()
    const shared = await seedDocument(database, { spaceId, createdBy: amy.id, title: '分享来的' })
    await setGrant(database, { documentId: shared.id, userId: reader.id, role: 'editor', grantedBy: amy.id })
    // 前提：授权确实生效（他打得开），不然下面的断言什么也证明不了
    expect((await detailOf(readerSession, shared.id)).accessVia).toBe('grant')
    const listed = parseExact(documentListResponseSchema, await (await asUser(app.baseUrl, readerSession, `/api/documents?spaceId=${reader.personalSpaceId}&folderId=all`)).json())
    expect(listed.items.map(item => item.id)).toEqual([own.id])
  })
})

describe('"可访问文档"的两半，仓储直接核对（M2-P5 设计 §3.4(2)）', () => {
  it('只要空间那一半：没有授权的文档；只要授权那一半：恰好是授权给这个人、正常状态的；两半都要：并集；两半都不要：什么也没有', async () => {
    const repository = app.runtime.get(DocumentsRepository)
    const holder = await createPassiveAccount(database, { username: 'grant-holder' })
    const other = await createPassiveAccount(database, { username: 'grant-other' })
    const spaceId = await teamSpace()
    const own = await seedDocument(database, { spaceId: holder.personalSpaceId, createdBy: holder.id, title: '两半 自己的' })
    const shared = await seedDocument(database, { spaceId, createdBy: amy.id, title: '两半 分享的' })
    const sharedThenTrashed = await seedDocument(database, { spaceId, createdBy: amy.id, title: '两半 删掉的' })
    const sharedWithOther = await seedDocument(database, { spaceId, createdBy: amy.id, title: '两半 给别人的' })
    await seedDocument(database, { spaceId, createdBy: amy.id, title: '两半 没分享的' })
    await setGrant(database, { documentId: shared.id, userId: holder.id, role: 'viewer', grantedBy: amy.id })
    await setGrant(database, { documentId: sharedThenTrashed.id, userId: holder.id, role: 'editor', grantedBy: amy.id })
    await setGrant(database, { documentId: sharedWithOther.id, userId: other.id, role: 'editor', grantedBy: amy.id })
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${sharedThenTrashed.id}`, { method: 'DELETE' })).status).toBe(204)

    const ids = async (spaceIds: string[], grantsOf: string | undefined): Promise<string[]> =>
      (await repository.listAccessible({ spaceIds, grantsOf }, { limit: 100 })).map(row => row.id).toSorted()
    expect(await ids([holder.personalSpaceId], undefined)).toEqual([own.id])
    expect(await ids([], holder.id)).toEqual([shared.id])
    expect(await ids([holder.personalSpaceId], holder.id)).toEqual([own.id, shared.id].toSorted())
    expect(await ids([], undefined)).toEqual([])
    // 有空间角色时两半重叠：每份只出现一次
    expect(await ids([spaceId], holder.id)).toEqual((await ids([spaceId], undefined)))
    // 搜索用同一个条件
    const found = await repository.searchByTitle({ spaceIds: [holder.personalSpaceId], grantsOf: holder.id }, { limit: 100, titlePattern: '%两半%' })
    expect(found.map(row => row.id).toSorted()).toEqual([own.id, shared.id].toSorted())
  })
})

describe('永久删除连带删授权（ADR-016，M2-P5 设计 §3.3）', () => {
  it('一份文档：进回收站与恢复都不动授权（恢复之后照常生效）；永久删除时它的授权随外键一起没了', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '要删的' })
    const kept = await seedDocument(database, { spaceId, createdBy: amy.id, title: '留着的' })
    await setGrant(database, { documentId: document.id, userId: ben.id, role: 'editor', grantedBy: amy.id })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'viewer', grantedBy: amy.id })
    await setGrant(database, { documentId: kept.id, userId: ben.id, role: 'viewer', grantedBy: amy.id })

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await grantsOn(database, [document.id])).toHaveLength(2)
    // 回收站里的对普通接口不存在
    expect((await open(benSession, document.id)).status).toBe(404)
    expect((await asUser(app.baseUrl, amySession, `/api/trash/${await entryOf(document.id)}/restore`, { method: 'POST' })).status).toBe(200)
    expect((await detailOf(benSession, document.id)).accessVia).toBe('grant')

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await asUser(app.baseUrl, amySession, `/api/trash/${await entryOf(document.id)}`, { method: 'DELETE' })).status).toBe(204)
    expect(await stored(document.id)).toBeUndefined()
    expect(await grantsOn(database, [document.id])).toEqual([])
    expect(await grantsOn(database, [kept.id])).toEqual([{ documentId: kept.id, userId: ben.id, role: 'viewer' }])
  })

  it('一个文件夹的删除单元：子树里每份文档的授权（含早先单独删过、被连带删掉的）一起没了，子树之外的不动', async () => {
    const spaceId = await teamSpace()
    const outer = await newFolder(amySession, spaceId, '要删的文件夹')
    const inner = await newFolder(amySession, spaceId, '里层', outer)
    const atTop = await seedDocument(database, { spaceId, createdBy: amy.id, title: '第一层的', folderId: outer })
    const deep = await seedDocument(database, { spaceId, createdBy: amy.id, title: '里层的', folderId: inner })
    const earlier = await seedDocument(database, { spaceId, createdBy: amy.id, title: '早先删的', folderId: inner })
    const outside = await seedDocument(database, { spaceId, createdBy: amy.id, title: '子树之外的' })
    for (const document of [atTop, deep, earlier, outside])
      await setGrant(database, { documentId: document.id, userId: ben.id, role: 'viewer', grantedBy: amy.id })
    // 早先单独删过：在自己的删除单元里，永久删除外层的单元时被连带
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${earlier.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await asUser(app.baseUrl, amySession, `/api/folders/${outer}`, { method: 'DELETE' })).status).toBe(204)
    const trash = parseExact(trashListResponseSchema, await (await asUser(app.baseUrl, amySession, `/api/trash?spaceId=${spaceId}`)).json())
    const folderEntry = trash.items.find(item => item.kind === 'folder')
    expect(folderEntry).toBeDefined()

    expect((await asUser(app.baseUrl, amySession, `/api/trash/${folderEntry?.id ?? ''}`, { method: 'DELETE' })).status).toBe(204)
    expect(await grantsOn(database, [atTop.id, deep.id, earlier.id])).toEqual([])
    expect(await grantsOn(database, [outside.id])).toEqual([{ documentId: outside.id, userId: ben.id, role: 'viewer' }])
  })
})

describe('spaces 按一批 id 取空间事实（M2-P5 设计 §3.1："与我共享"与搜索补所在空间）', () => {
  it('类型、名称、状态、全员可见、所有者，以及这个人在里面的成员角色与是不是所有者；不存在的 id 不在结果里，重复的只算一次', async () => {
    const service = app.runtime.get(SpacesService)
    const team = await teamSpace({ cat: 'editor', visibleToAll: true })
    const archived = await teamSpace({ cat: undefined })
    await setSpaceState(database, archived, { status: 'archived' })
    const missing = randomUUID()

    const facts = await service.accessFactsOfMany(cat.id, [cat.personalSpaceId, amy.personalSpaceId, team, archived, missing, team])
    expect([...facts.keys()].toSorted()).toEqual([cat.personalSpaceId, amy.personalSpaceId, team, archived].toSorted())
    expect(facts.get(cat.personalSpaceId)).toEqual({ id: cat.personalSpaceId, type: 'personal', name: '凯特', status: 'active', visibleToAll: false, owned: true, memberRole: null, ownerUserId: cat.id })
    expect(facts.get(amy.personalSpaceId)).toEqual({ id: amy.personalSpaceId, type: 'personal', name: '艾米', status: 'active', visibleToAll: false, owned: false, memberRole: null, ownerUserId: amy.id })
    expect(facts.get(team)).toMatchObject({ type: 'team', status: 'active', visibleToAll: true, owned: false, memberRole: 'editor', ownerUserId: null })
    expect(facts.get(archived)).toMatchObject({ type: 'team', status: 'archived', visibleToAll: false, memberRole: null, ownerUserId: null })
    // 与单个空间的事实同一套算法
    expect(facts.get(team)).toMatchObject(await service.accessFactsOf(cat.id, team) ?? {})
  })

  it('超过绑定参数上限（65535）的一串 id 也是一条语句、一个数组参数；空的一串不查询', async () => {
    const service = app.runtime.get(SpacesService)
    const team = await teamSpace({ cat: 'viewer' })
    const many = [...Array.from({ length: 70_000 }, () => randomUUID()), team]
    const facts = await service.accessFactsOfMany(cat.id, many)
    expect([...facts.keys()]).toEqual([team])
    expect((await service.accessFactsOfMany(cat.id, [])).size).toBe(0)
  })
})

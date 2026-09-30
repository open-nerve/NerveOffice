// 空间里的文件夹（M2-P4 设计 §3.2、§3.4，US-M2-07）：列出一层、新建、改名、移动（同一个空间里，或者连同子树移到别的空间）；
// 层数与 10 层上限（含整棵子树一起移动）、成环、同一个文件夹里允许同名、requestId 的幂等；
// 看不到与不存在一致、编辑者与查看者的区别、归档的空间；文档列表按目录过滤；
// 跨空间移动：整棵子树（含里面的文档）换空间、文档的写入代次加一、两边的权限、目标位置的判断；
// 并发：判断过之后、取空间树的锁之前空间被归档，往子树里移进新文档，两个方向的跨空间移动（两个连接构造的交错）。
import type { Folder, FolderListResponse, SpaceRole } from '@nerve-office/contracts'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { documentListResponseSchema, errorResponseSchema, FOLDER_MAX_DEPTH, folderListResponseSchema, folderSchema, trashListResponseSchema } from '@nerve-office/contracts'
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
let spaces = 0

const MISSING_ID = '0199a2c4-0000-7000-8000-0000000000fe'

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

/** 一个新的团队空间：艾米默认是编辑者，本是查看者；凯特不是成员 */
async function teamSpace(options: { status?: 'active' | 'archived', amy?: SpaceRole } = {}): Promise<string> {
  spaces += 1
  const { amy: amyRole = 'editor', ...rest } = options
  return createTeamSpace(database, { name: `文件夹 ${spaces}`, createdBy: root.id, members: { [amy.id]: amyRole, [ben.id]: 'viewer' }, ...rest })
}

/** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
function holdSpaceTree(spaceId: string) {
  return async (client: pg.Client) =>
    client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
}

async function post(user: LoggedIn, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, '/api/folders', { method: 'POST', body: { requestId: randomUUID(), ...body } })
}

async function created(response: Response): Promise<Folder> {
  expect(response.status).toBe(201)
  return parseExact(folderSchema, await response.json())
}

/** 新建一个文件夹并断言成功 */
async function newFolder(user: LoggedIn, body: Record<string, unknown>): Promise<Folder> {
  return created(await post(user, body))
}

async function patch(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/folders/${id}`, { method: 'PATCH', body })
}

async function move(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/folders/${id}/move`, { method: 'POST', body })
}

/** 经删除接口把一个文件夹或一份文档放进回收站，返回它的删除单元 id（S3 的接口） */
async function trash(kind: 'folder' | 'document', spaceId: string, id: string): Promise<string> {
  const removed = await asUser(app.baseUrl, amySession, `/api/${kind === 'folder' ? 'folders' : 'documents'}/${id}`, { method: 'DELETE' })
  expect(removed.status).toBe(204)
  const listed = await asUser(app.baseUrl, amySession, `/api/trash?spaceId=${spaceId}`)
  expect(listed.status).toBe(200)
  const entryId = parseExact(trashListResponseSchema, await listed.json()).items[0]?.id
  if (entryId === undefined)
    throw new Error('删除之后回收站里没有东西')
  return entryId
}

/** 一份文档当前的状态与它所属的删除单元 */
async function trashStateOf(documentId: string): Promise<{ status: string, entry: string | null }> {
  const row = await database.query(async client => (await client.query<{ status: string, trash_entry_id: string | null }>(
    'SELECT status, trash_entry_id FROM documents WHERE id = $1',
    [documentId],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有文档 ${documentId}`)
  return { status: row.status, entry: row.trash_entry_id }
}

async function moved(response: Response): Promise<Folder> {
  expect(response.status).toBe(200)
  return parseExact(folderSchema, await response.json())
}

async function updated(response: Response): Promise<Folder> {
  expect(response.status).toBe(200)
  return parseExact(folderSchema, await response.json())
}

async function list(user: LoggedIn, spaceId: string, parentId?: string): Promise<FolderListResponse> {
  const query = new URLSearchParams({ spaceId })
  if (parentId !== undefined)
    query.set('parentId', parentId)
  const response = await asUser(app.baseUrl, user, `/api/folders?${query.toString()}`)
  expect(response.status).toBe(200)
  return parseExact(folderListResponseSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function depthsOf(ids: readonly string[]): Promise<Record<string, number>> {
  const rows = await database.query(async client => (await client.query<{ id: string, depth: number, parent_id: string | null }>(
    'SELECT id, depth, parent_id FROM folders WHERE id = ANY($1::uuid[])',
    [ids],
  )).rows)
  return Object.fromEntries(rows.map(row => [row.id, row.depth]))
}

async function count(query: string, values: unknown[]): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

/** 这些文件夹当前的位置：所属空间、父文件夹与层数 */
async function placesOf(ids: readonly string[]): Promise<Record<string, { space: string, parent: string | null, depth: number }>> {
  const rows = await database.query(async client => (await client.query<{ id: string, space_id: string, parent_id: string | null, depth: number }>(
    'SELECT id, space_id, parent_id, depth FROM folders WHERE id = ANY($1::uuid[])',
    [ids],
  )).rows)
  return Object.fromEntries(rows.map(row => [row.id, { space: row.space_id, parent: row.parent_id, depth: row.depth }]))
}

/** 这些文档当前的所属空间、位置与写入代次 */
async function documentsOf(ids: readonly string[]): Promise<Record<string, { space: string, folder: string | null, epoch: number }>> {
  const rows = await database.query(async client => (await client.query<{ id: string, space_id: string, folder_id: string | null, write_epoch: number }>(
    'SELECT id, space_id, folder_id, write_epoch FROM documents WHERE id = ANY($1::uuid[])',
    [ids],
  )).rows)
  return Object.fromEntries(rows.map(row => [row.id, { space: row.space_id, folder: row.folder_id, epoch: row.write_epoch }]))
}

/** 移动的审计（folders.moved）：按时间顺序给出 details */
async function moveAudits(folderId: string): Promise<Record<string, unknown>[]> {
  return database.query(async client => (await client.query<{ details: Record<string, unknown> }>(
    'SELECT details FROM audit_events WHERE action = \'folders.moved\' AND target_id = $1 ORDER BY occurred_at',
    [folderId],
  )).rows.map(row => row.details))
}

/** 在一个空间里建一条 levels 层的链，返回每一层（第 0 项是第 1 层） */
async function chain(spaceId: string, levels: number): Promise<Folder[]> {
  const folders: Folder[] = []
  for (let level = 0; level < levels; level += 1)
    folders.push(await newFolder(amySession, { spaceId, parentId: folders.at(-1)?.id, name: `第 ${level + 1} 层` }))
  return folders
}

describe('US-M2-07 文件夹的新建与列出', () => {
  it('建在空间的根目录：层数 1，出现在根目录这一层，记审计', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: ' 资料 ' })
    expect(folder).toMatchObject({ spaceId, parentId: null, name: '资料', depth: 1, permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canDelete: true } })
    expect((await list(amySession, spaceId)).items.map(item => item.id)).toEqual([folder.id])
    const audit = await database.query(async client => (await client.query<{ action: string, actor_id: string, details: Record<string, unknown> }>(
      'SELECT action, actor_id, details FROM audit_events WHERE target_type = \'folder\' AND target_id = $1',
      [folder.id],
    )).rows)
    // 只记位置，不记名称（M2-P6 复核 M-1）
    expect(audit).toEqual([{ action: 'folders.created', actor_id: amy.id, details: { spaceId, parentId: null } }])
  })

  it('建在父文件夹下：层数是父的加一，只出现在那一层；同一个文件夹里允许同名', async () => {
    const spaceId = await teamSpace()
    const parent = await newFolder(amySession, { spaceId, name: '资料' })
    const first = await newFolder(amySession, { spaceId, parentId: parent.id, name: '归档' })
    const second = await newFolder(amySession, { spaceId, parentId: parent.id, name: '归档' })
    expect([first.depth, second.depth]).toEqual([2, 2])
    expect(first.id).not.toBe(second.id)
    expect((await list(amySession, spaceId)).items.map(item => item.id)).toEqual([parent.id])
    expect((await list(amySession, spaceId, parent.id)).items.map(item => item.name)).toEqual(['归档', '归档'])
  })

  it(`最多 ${FOLDER_MAX_DEPTH} 层：第 ${FOLDER_MAX_DEPTH} 层下面再建被拒绝，什么也不写`, async () => {
    const spaceId = await teamSpace()
    const levels = await chain(spaceId, FOLDER_MAX_DEPTH)
    expect(levels.map(folder => folder.depth)).toEqual(Array.from({ length: FOLDER_MAX_DEPTH }, (_, index) => index + 1))
    const response = await post(amySession, { spaceId, parentId: levels.at(-1)?.id, name: '再一层' })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect(await count('SELECT count(*) FROM folders WHERE space_id = $1', [spaceId])).toBe(FOLDER_MAX_DEPTH)
  })

  it('父文件夹在别的空间里、不存在：同一个 NOT_FOUND，响应一致', async () => {
    const spaceId = await teamSpace()
    const elsewhere = await newFolder(amySession, { spaceId: amy.personalSpaceId, name: '私人资料' })
    const foreign = await post(amySession, { spaceId, parentId: elsewhere.id, name: '资料' })
    const missing = await post(amySession, { spaceId, parentId: MISSING_ID, name: '资料' })
    expect([foreign.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(foreign)).toEqual(await errorOf(missing))
    expect(await count('SELECT count(*) FROM folders WHERE space_id = $1', [spaceId])).toBe(0)
  })

  it('看不到的空间与不存在的空间：同一个 NOT_FOUND，列出与新建都是', async () => {
    const spaceId = await teamSpace()
    const unseen = await asUser(app.baseUrl, catSession, `/api/folders?spaceId=${spaceId}`)
    const missing = await asUser(app.baseUrl, catSession, `/api/folders?spaceId=${MISSING_ID}`)
    expect([unseen.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(unseen)).toEqual(await errorOf(missing))
    const created = await post(catSession, { spaceId, name: '资料' })
    const createdMissing = await post(catSession, { spaceId: MISSING_ID, name: '资料' })
    expect([created.status, createdMissing.status]).toEqual([404, 404])
    expect(await errorOf(created)).toEqual(await errorOf(createdMissing))
  })

  it('查看者能列出、不能新建；编辑者两样都行', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const page = await list(benSession, spaceId)
    expect(page.items.map(item => item.id)).toEqual([folder.id])
    expect(page.items[0]?.permissions).toEqual({ canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false })
    const response = await post(benSession, { spaceId, name: '本的资料' })
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '没有在这个空间里新建文件夹的权限' })
  })

  it('归档的空间：成员照样能列出，不能新建、不能改名与移动，说明空间已归档', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    await setSpaceState(database, spaceId, { status: 'archived' })
    expect((await list(amySession, spaceId)).items.map(item => item.id)).toEqual([folder.id])
    for (const response of [await post(amySession, { spaceId, name: '新的' }), await patch(amySession, folder.id, { name: '归档' })]) {
      expect(response.status).toBe(403)
      expect((await errorOf(response)).message).toBe('空间已归档，只能查看')
    }
    await setSpaceState(database, spaceId, { status: 'active' })
    expect((await patch(amySession, folder.id, { name: '归档' })).status).toBe(200)
  })

  it('同一个 requestId 重发：只建一个，返回同一个；换了名称是另一个请求，拒绝', async () => {
    const spaceId = await teamSpace()
    const requestId = randomUUID()
    const first = await created(await post(amySession, { spaceId, name: '资料', requestId }))
    expect(await created(await post(amySession, { spaceId, name: '资料', requestId }))).toEqual(first)
    const conflict = await post(amySession, { spaceId, name: '归档', requestId })
    expect(conflict.status).toBe(409)
    expect((await errorOf(conflict)).code).toBe('REQUEST_ID_CONFLICT')
    expect(await count('SELECT count(*) FROM folders WHERE space_id = $1', [spaceId])).toBe(1)
  })
})

describe('US-M2-07 文件夹的改名与移动', () => {
  it('改名：记审计；名称没有变化时不记审计', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    expect((await updated(await patch(amySession, folder.id, { name: ' 归档 ' }))).name).toBe('归档')
    await patch(amySession, folder.id, { name: '归档' })
    expect(await count('SELECT count(*) FROM audit_events WHERE action = \'folders.renamed\' AND target_id = $1', [folder.id])).toBe(1)
  })

  it('移动一棵子树：整棵的层数一起变（一条 UPDATE，不逐行）；移回根目录再变回来', async () => {
    const spaceId = await teamSpace()
    const [top, middle, leaf] = await chain(spaceId, 3)
    const target = await newFolder(amySession, { spaceId, name: '目标' })
    const ids = [top?.id ?? '', middle?.id ?? '', leaf?.id ?? '']
    const moved = await updated(await patch(amySession, middle?.id ?? '', { parentId: target.id }))
    expect(moved).toMatchObject({ parentId: target.id, depth: 2 })
    expect(await depthsOf(ids)).toEqual({ [ids[0] ?? '']: 1, [ids[1] ?? '']: 2, [ids[2] ?? '']: 3 })

    const back = await updated(await patch(amySession, middle?.id ?? '', { parentId: null }))
    expect(back).toMatchObject({ parentId: null, depth: 1 })
    expect(await depthsOf(ids)).toEqual({ [ids[0] ?? '']: 1, [ids[1] ?? '']: 1, [ids[2] ?? '']: 2 })
    expect(await count('SELECT count(*) FROM audit_events WHERE action = \'folders.moved\' AND target_id = $1', [middle?.id])).toBe(2)
  })

  it('移进自己或自己的子文件夹：FOLDER_CYCLE，位置不变', async () => {
    const spaceId = await teamSpace()
    const [top, middle, leaf] = await chain(spaceId, 3)
    for (const target of [top?.id, middle?.id, leaf?.id]) {
      const response = await patch(amySession, top?.id ?? '', { parentId: target })
      expect(response.status, String(target)).toBe(409)
      expect((await errorOf(response)).code).toBe('FOLDER_CYCLE')
    }
    expect(await depthsOf([top?.id ?? ''])).toEqual({ [top?.id ?? '']: 1 })
  })

  it('整棵子树装不下时拒绝，位置不变；正好装得下时通过', async () => {
    const spaceId = await teamSpace()
    // 9 层的一棵子树：挂到第 1 层下面正好到第 10 层，挂到第 2 层下面就超了
    const deep = await chain(spaceId, FOLDER_MAX_DEPTH - 1)
    const [first, second] = await chain(spaceId, 2)
    const tooDeep = await patch(amySession, deep[0]?.id ?? '', { parentId: second?.id })
    expect(tooDeep.status).toBe(409)
    expect((await errorOf(tooDeep)).code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect(await depthsOf([deep[0]?.id ?? '', deep.at(-1)?.id ?? ''])).toEqual({ [deep[0]?.id ?? '']: 1, [deep.at(-1)?.id ?? '']: FOLDER_MAX_DEPTH - 1 })

    expect((await updated(await patch(amySession, deep[0]?.id ?? '', { parentId: first?.id }))).depth).toBe(2)
    expect(await depthsOf([deep.at(-1)?.id ?? ''])).toEqual({ [deep.at(-1)?.id ?? '']: FOLDER_MAX_DEPTH })
  })

  it('目标文件夹在别的空间里：NOT_FOUND（跨空间移动另有接口）', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const elsewhere = await newFolder(amySession, { spaceId: amy.personalSpaceId, name: '私人资料' })
    const response = await patch(amySession, folder.id, { parentId: elsewhere.id })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toEqual(await errorOf(await patch(amySession, folder.id, { parentId: MISSING_ID })))
  })

  it('查看者不能改名、不能移动；看不到的空间里的文件夹与不存在的都是 NOT_FOUND', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const rename = await patch(benSession, folder.id, { name: '归档' })
    expect(rename.status).toBe(403)
    expect(await errorOf(rename)).toEqual({ code: 'PERMISSION_DENIED', message: '没有给这个文件夹改名的权限' })
    const move = await patch(benSession, folder.id, { parentId: null })
    expect(move.status).toBe(403)
    expect(await errorOf(move)).toEqual({ code: 'PERMISSION_DENIED', message: '没有移动这个文件夹的权限' })

    const unseen = await patch(catSession, folder.id, { name: '归档' })
    const missing = await patch(catSession, MISSING_ID, { name: '归档' })
    expect([unseen.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(unseen)).toEqual(await errorOf(missing))
  })

  it('被移出空间之后：下一次请求就看不到，改名是 404', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    await setMember(database, spaceId, amy.id, undefined)
    expect((await patch(amySession, folder.id, { name: '归档' })).status).toBe(404)
    expect((await asUser(app.baseUrl, amySession, `/api/folders?spaceId=${spaceId}`)).status).toBe(404)
  })
})

describe('US-M2-07 文档列表按目录过滤', () => {
  it('省略 folderId 是空间的根目录，指定文件夹只列那一层，all 是整个空间', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const atRoot = await createDocument(database, { spaceId, createdBy: amy.id, title: '根目录的' })
    const inFolder = await createDocument(database, { spaceId, createdBy: amy.id, title: '文件夹里的', folderId: folder.id })
    const idsOf = async (query: string): Promise<string[]> => {
      const response = await asUser(app.baseUrl, amySession, `/api/documents?spaceId=${spaceId}${query}`)
      expect(response.status).toBe(200)
      return parseExact(documentListResponseSchema, await response.json()).items.map(item => item.id)
    }
    expect(await idsOf('')).toEqual([atRoot])
    expect(await idsOf(`&folderId=${folder.id}`)).toEqual([inFolder])
    expect((await idsOf('&folderId=all')).toSorted()).toEqual([atRoot, inFolder].toSorted())
  })

  it('指定的文件夹在别的空间里、不存在：同一个 NOT_FOUND', async () => {
    const spaceId = await teamSpace()
    const elsewhere = await newFolder(amySession, { spaceId: amy.personalSpaceId, name: '私人资料' })
    const foreign = await asUser(app.baseUrl, amySession, `/api/documents?spaceId=${spaceId}&folderId=${elsewhere.id}`)
    const missing = await asUser(app.baseUrl, amySession, `/api/documents?spaceId=${spaceId}&folderId=${MISSING_ID}`)
    expect([foreign.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(foreign)).toEqual(await errorOf(missing))
  })
})

describe('US-M2-07 文件夹的跨空间移动', () => {
  /** 源空间（艾米是空间管理员）里的一棵两层子树，每一层放一份文档 */
  async function subtree(spaceId: string): Promise<{ top: Folder, leaf: Folder, atTop: string, deep: string }> {
    const top = await newFolder(amySession, { spaceId, name: '资料' })
    const leaf = await newFolder(amySession, { spaceId, parentId: top.id, name: '里面' })
    return {
      top,
      leaf,
      atTop: await createDocument(database, { spaceId, createdBy: amy.id, title: '上层的', folderId: top.id }),
      deep: await createDocument(database, { spaceId, createdBy: amy.id, title: '深处的', folderId: leaf.id }),
    }
  }

  it('源空间管理员 + 目标的新建权限：整棵子树（含深层的文档）都到了新空间，文档的写入代次都加一，记审计', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    const { top, leaf, atTop, deep } = await subtree(from)
    const target = await newFolder(amySession, { spaceId: to, name: '目标' })

    const response = await moved(await move(amySession, top.id, { spaceId: to, folderId: target.id }))
    expect(response).toMatchObject({ spaceId: to, parentId: target.id, depth: 2 })
    // 到了新空间只是编辑者：不能再把它移走
    expect(response.permissions).toEqual({ canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canDelete: true })
    expect(await placesOf([top.id, leaf.id])).toEqual({
      [top.id]: { space: to, parent: target.id, depth: 2 },
      [leaf.id]: { space: to, parent: top.id, depth: 3 },
    })
    // 文档跟着各自的文件夹走：位置不变、空间变了、写入代次加一
    expect(await documentsOf([atTop, deep])).toEqual({
      [atTop]: { space: to, folder: top.id, epoch: 1 },
      [deep]: { space: to, folder: leaf.id, epoch: 1 },
    })
    // 原空间的这一层空了，目标文件夹下面多了这棵子树
    expect((await list(amySession, from)).items).toEqual([])
    expect((await list(amySession, to, target.id)).items.map(item => item.id)).toEqual([top.id])
    expect(await moveAudits(top.id)).toEqual([
      { fromSpaceId: from, fromParentId: null, toSpaceId: to, toParentId: target.id, folders: 2, documents: 2 },
    ])
  })

  it('移到目标空间的根目录：层数从头算；里面的文档跟着走', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    const { top, leaf, deep } = await subtree(from)
    const under = await newFolder(amySession, { spaceId: from, parentId: top.id, name: '搬走的' })
    expect((await moved(await move(amySession, under.id, { spaceId: to }))).depth).toBe(1)
    expect(await placesOf([top.id, leaf.id, under.id])).toEqual({
      [top.id]: { space: from, parent: null, depth: 1 },
      [leaf.id]: { space: from, parent: top.id, depth: 2 },
      [under.id]: { space: to, parent: null, depth: 1 },
    })
    // 没搬走的那一支不受影响
    expect(await documentsOf([deep])).toEqual({ [deep]: { space: from, folder: leaf.id, epoch: 0 } })
  })

  it('只有源空间的空间管理员能移出去：编辑者是 403，什么也不改', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const { top, deep } = await subtree(from)
    const response = await move(amySession, top.id, { spaceId: to })
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '只有空间管理员能把文件夹移出这个空间' })
    expect(await placesOf([top.id])).toEqual({ [top.id]: { space: from, parent: null, depth: 1 } })
    expect(await documentsOf([deep])).toMatchObject({ [deep]: { space: from, epoch: 0 } })
  })

  it('目标空间已归档是 409；看不到与不存在是 404；只能查看是 403', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const archived = await teamSpace({ status: 'archived' })
    const viewerOnly = await teamSpace({ amy: 'viewer' })
    const unseen = await createTeamSpace(database, { name: `文件夹 看不到 ${spaces}`, createdBy: root.id })
    const folder = await newFolder(amySession, { spaceId: from, name: '资料' })

    const cases: [string, number, string][] = [
      [archived, 409, 'SPACE_ARCHIVED'],
      [viewerOnly, 403, 'PERMISSION_DENIED'],
      [unseen, 404, 'NOT_FOUND'],
      [MISSING_ID, 404, 'NOT_FOUND'],
    ]
    for (const [spaceId, status, code] of cases) {
      const response = await move(amySession, folder.id, { spaceId })
      expect(response.status, code).toBe(status)
      expect((await errorOf(response)).code).toBe(code)
    }
    expect(await placesOf([folder.id])).toEqual({ [folder.id]: { space: from, parent: null, depth: 1 } })
  })

  it('源空间已归档：所有人至多是查看者，移不走', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    const folder = await newFolder(amySession, { spaceId: from, name: '资料' })
    await setSpaceState(database, from, { status: 'archived' })
    const response = await move(amySession, folder.id, { spaceId: to })
    expect(response.status).toBe(403)
    expect((await errorOf(response)).message).toBe('空间已归档，只能查看')
  })

  it('目标就是现在所在的空间：按空间内移动处理（编辑者就行，文档的代次不变）；重试是幂等的', async () => {
    const spaceId = await teamSpace()
    const { top, deep } = await subtree(spaceId)
    const target = await newFolder(amySession, { spaceId, name: '目标' })
    expect((await moved(await move(amySession, top.id, { spaceId, folderId: target.id }))).parentId).toBe(target.id)
    expect(await documentsOf([deep])).toMatchObject({ [deep]: { space: spaceId, epoch: 0 } })

    expect((await moved(await move(amySession, top.id, { spaceId, folderId: target.id }))).parentId).toBe(target.id)
    expect(await documentsOf([deep])).toMatchObject({ [deep]: { epoch: 0 } })
    // 位置没有变化的那一次不再记审计
    expect(await moveAudits(top.id)).toEqual([
      { fromSpaceId: spaceId, fromParentId: null, toSpaceId: spaceId, toParentId: target.id },
    ])
  })

  it('同一个空间里移进自己的子文件夹：409 FOLDER_CYCLE，位置不变', async () => {
    const spaceId = await teamSpace()
    const { top, leaf } = await subtree(spaceId)
    const response = await move(amySession, top.id, { spaceId, folderId: leaf.id })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('FOLDER_CYCLE')
    expect(await placesOf([top.id])).toEqual({ [top.id]: { space: spaceId, parent: null, depth: 1 } })
  })

  it('目标文件夹在别的空间里、已经在回收站里、不存在：同一个 NOT_FOUND，什么也不改', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    const { top, deep } = await subtree(from)
    const elsewhere = await newFolder(amySession, { spaceId: from, name: '还在原空间' })
    const trashed = await newFolder(amySession, { spaceId: to, name: '目标空间里被删的' })
    await trash('folder', to, trashed.id)
    const responses = [
      await move(amySession, top.id, { spaceId: to, folderId: elsewhere.id }),
      await move(amySession, top.id, { spaceId: to, folderId: trashed.id }),
      await move(amySession, top.id, { spaceId: to, folderId: MISSING_ID }),
    ]
    expect(responses.map(response => response.status)).toEqual([404, 404, 404])
    const errors = await Promise.all(responses.map(async response => errorOf(response)))
    expect(errors[1]).toEqual(errors[0])
    expect(errors[2]).toEqual(errors[0])
    expect(await placesOf([top.id])).toEqual({ [top.id]: { space: from, parent: null, depth: 1 } })
    expect(await documentsOf([deep])).toMatchObject({ [deep]: { space: from, epoch: 0 } })
  })

  it('子树里已经在回收站的文档也跟着搬：仍在原来的删除单元里，不被拆散在两个空间', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    const folder = await newFolder(amySession, { spaceId: from, name: '资料' })
    const document = await createDocument(database, { spaceId: from, createdBy: amy.id, title: '删过的', folderId: folder.id })
    const entry = await trash('document', from, document)
    expect((await moved(await move(amySession, folder.id, { spaceId: to }))).spaceId).toBe(to)
    // 跟着所在的文件夹到了新空间，位置不变；代次删除时加过一次、这次跨空间移动又加一次
    // 仍然在回收站里、仍然属于原来的那个删除单元（删除单元跟着换登记空间，见 trash.test.ts 的 spec §6b）
    expect(await documentsOf([document])).toEqual({ [document]: { space: to, folder: folder.id, epoch: 2 } })
    expect(await trashStateOf(document)).toEqual({ status: 'trashed', entry })
  })

  it('整棵子树在目标空间里装不下：409 FOLDER_DEPTH_EXCEEDED，什么也不改', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    // 9 层的一棵子树：挂到目标空间的第 1 层下面正好到第 10 层，第 2 层下面就超了
    const deep = await chain(from, FOLDER_MAX_DEPTH - 1)
    const document = await createDocument(database, { spaceId: from, createdBy: amy.id, title: '最深处的', folderId: deep.at(-1)?.id })
    const [first, second] = await chain(to, 2)
    const response = await move(amySession, deep[0]?.id ?? '', { spaceId: to, folderId: second?.id })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('FOLDER_DEPTH_EXCEEDED')
    expect(await placesOf([deep[0]?.id ?? ''])).toEqual({ [deep[0]?.id ?? '']: { space: from, parent: null, depth: 1 } })
    expect(await documentsOf([document])).toMatchObject({ [document]: { space: from, epoch: 0 } })

    expect((await moved(await move(amySession, deep[0]?.id ?? '', { spaceId: to, folderId: first?.id }))).depth).toBe(2)
    expect(await placesOf([deep.at(-1)?.id ?? ''])).toMatchObject({ [deep.at(-1)?.id ?? '']: { space: to, depth: FOLDER_MAX_DEPTH } })
    expect(await documentsOf([document])).toEqual({ [document]: { space: to, folder: deep.at(-1)?.id ?? '', epoch: 1 } })
  })
})

describe('US-M2-14 空间树的锁与并发', () => {
  it('判断过能新建之后、取空间树的锁之前，空间被归档：锁下再判断，403，不新建', async () => {
    const spaceId = await teamSpace()
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(spaceId),
      request: async () => post(amySession, { spaceId, name: '资料' }),
      change: async client => client.query('UPDATE spaces SET status = \'archived\' WHERE id = $1', [spaceId]),
    })
    expect(response.status).toBe(403)
    expect(await count('SELECT count(*) FROM folders WHERE space_id = $1', [spaceId])).toBe(0)
  })

  it('判断过能移动之后、取空间树的锁之前，被移出空间：锁下再判断，404，不移动', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const target = await newFolder(amySession, { spaceId, name: '目标' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(spaceId),
      request: async () => patch(amySession, folder.id, { parentId: target.id }),
      change: async client => client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, amy.id]),
    })
    expect(response.status).toBe(404)
    expect(await depthsOf([folder.id])).toEqual({ [folder.id]: 1 })
  })

  it('跨空间移动等锁期间，有人往子树里移进新文档：锁下才展开子树，那份文档也跟着搬走', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace()
    const folder = await newFolder(amySession, { spaceId: from, name: '资料' })
    const document = await createDocument(database, { spaceId: from, createdBy: amy.id, title: '后来才进来的' })
    const response = await raceAgainstHeldLock(database, {
      // 移动先要排在前面的那个空间的树锁：拿不到，所以还没有展开子树
      hold: holdSpaceTree(from < to ? from : to),
      request: async () => move(amySession, folder.id, { spaceId: to }),
      change: async client => client.query('UPDATE documents SET folder_id = $2 WHERE id = $1', [document, folder.id]),
    })
    expect(response.status).toBe(200)
    expect(await documentsOf([document])).toEqual({ [document]: { space: to, folder: folder.id, epoch: 1 } })
    expect(await moveAudits(folder.id)).toMatchObject([{ documents: 1 }])
  })

  it('两个方向的跨空间移动：都先取排在前面的那个空间的树锁，不成环', async () => {
    const [first, second] = [await teamSpace({ amy: 'admin' }), await teamSpace({ amy: 'admin' })].toSorted()
    if (first === undefined || second === undefined)
      throw new Error('没有建出两个空间')
    // 从排在后面的空间往前面移：按空间 id 排序取锁的话，先要的是排在前面的那一把
    const folder = await newFolder(amySession, { spaceId: second, name: '资料' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(first),
      request: async () => move(amySession, folder.id, { spaceId: first }),
      change: async (client) => {
        // 请求正等在排在前面的那把锁上，还没有拿到排在后面的那一把：反方向的移动因此不会与它成环
        const held = await client.query<{ free: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0)) AS free',
          [second],
        )
        expect(held.rows[0]?.free, '取锁的顺序不是按空间 id 排序').toBe(true)
      },
    })
    expect(response.status).toBe(200)
    expect(await placesOf([folder.id])).toEqual({ [folder.id]: { space: first, parent: null, depth: 1 } })
  })
})

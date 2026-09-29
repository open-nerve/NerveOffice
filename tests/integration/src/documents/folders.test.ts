// 空间里的文件夹（M2-P4 设计 §3.2、§3.4，US-M2-07）：列出一层、新建、改名、同一个空间里移动；
// 层数与 10 层上限（含整棵子树一起移动）、成环、同一个文件夹里允许同名、requestId 的幂等；
// 看不到与不存在一致、编辑者与查看者的区别、归档的空间；文档列表按目录过滤；
// 并发：判断过之后、取空间树的锁之前空间被归档（两个连接构造的交错）。
import type { Folder, FolderListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { documentListResponseSchema, errorResponseSchema, FOLDER_MAX_DEPTH, folderListResponseSchema, folderSchema } from '@nerve-office/contracts'
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

/** 一个新的团队空间：艾米是编辑者，本是查看者；凯特不是成员 */
async function teamSpace(options: { status?: 'active' | 'archived' } = {}): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `文件夹 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'editor', [ben.id]: 'viewer' }, ...options })
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
    expect(folder).toMatchObject({ spaceId, parentId: null, name: '资料', depth: 1, permissions: { canRename: true, canMoveWithinSpace: true } })
    expect((await list(amySession, spaceId)).items.map(item => item.id)).toEqual([folder.id])
    const audit = await database.query(async client => (await client.query<{ action: string, actor_id: string, details: Record<string, unknown> }>(
      'SELECT action, actor_id, details FROM audit_events WHERE target_type = \'folder\' AND target_id = $1',
      [folder.id],
    )).rows)
    expect(audit).toEqual([{ action: 'folders.created', actor_id: amy.id, details: { spaceId, parentId: null, name: '资料' } }])
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
    expect(page.items[0]?.permissions).toEqual({ canRename: false, canMoveWithinSpace: false })
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

describe('US-M2-14 空间树的锁与并发', () => {
  /** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
  function holdSpaceTree(spaceId: string) {
    return async (client: { query: (text: string, values: unknown[]) => Promise<unknown> }) =>
      client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
  }

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
})

// 回收站（M2-P4 S3 的规则细则，US-M2-09）：删除单元的粒度与"不重组"、谁能删、按空间列出、
// 整单恢复与原位置的回落、永久删除与连带、回收站里的东西对普通接口一律"不存在"、写入代次、跨空间移动与删除单元；
// 并发：删文件夹与往里移文档、恢复与永久删除、删除与保存、判断过之后被移出空间（两个连接构造的交错）。
import type { Folder, RestoredTrashEntry, SpaceRole, TrashListResponse } from '@nerve-office/contracts'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { documentListResponseSchema, errorResponseSchema, folderListResponseSchema, folderSchema, restoredTrashEntrySchema, SHEET_TEMPLATE, TRASH_LIST_PAGE_SIZE, TRASH_RETENTION_DAYS, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument, seedDocument } from '../support/documents.ts'
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

/** 一个新的团队空间：艾米默认是编辑者，本是编辑者；凯特不是成员 */
async function teamSpace(options: { status?: 'active' | 'archived', amy?: SpaceRole, ben?: SpaceRole } = {}): Promise<string> {
  spaces += 1
  const { amy: amyRole = 'editor', ben: benRole = 'editor', ...rest } = options
  return createTeamSpace(database, { name: `回收站 ${spaces}`, createdBy: root.id, members: { [amy.id]: amyRole, [ben.id]: benRole }, ...rest })
}

/** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
function holdSpaceTree(spaceId: string) {
  return async (client: pg.Client) =>
    client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
}

async function newFolder(user: LoggedIn, body: Record<string, unknown>): Promise<Folder> {
  const response = await asUser(app.baseUrl, user, '/api/folders', { method: 'POST', body: { requestId: randomUUID(), ...body } })
  expect(response.status).toBe(201)
  return parseExact(folderSchema, await response.json())
}

async function deleteDocument(user: LoggedIn, id: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}`, { method: 'DELETE' })
}

async function deleteFolder(user: LoggedIn, id: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/folders/${id}`, { method: 'DELETE' })
}

async function restore(user: LoggedIn, entryId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/trash/${entryId}/restore`, { method: 'POST' })
}

async function purge(user: LoggedIn, entryId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/trash/${entryId}`, { method: 'DELETE' })
}

async function trash(user: LoggedIn, spaceId: string, cursor?: string): Promise<TrashListResponse> {
  const query = new URLSearchParams({ spaceId })
  if (cursor !== undefined)
    query.set('cursor', cursor)
  const response = await asUser(app.baseUrl, user, `/api/trash?${query.toString()}`)
  expect(response.status).toBe(200)
  return parseExact(trashListResponseSchema, await response.json())
}

/** 删掉并返回它在回收站里的删除单元 */
async function trashedEntry(user: LoggedIn, spaceId: string, remove: () => Promise<Response>): Promise<string> {
  expect((await remove()).status).toBe(204)
  const [entry] = (await trash(user, spaceId)).items
  if (entry === undefined)
    throw new Error('删除之后回收站里没有东西')
  return entry.id
}

async function restored(response: Response): Promise<RestoredTrashEntry> {
  expect(response.status).toBe(200)
  return parseExact(restoredTrashEntrySchema, await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function count(query: string, values: unknown[]): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

/** 这些文档当前的状态、所属的删除单元、位置与写入代次 */
async function documentsOf(ids: readonly string[]): Promise<Record<string, { status: string, entry: string | null, space: string, folder: string | null, epoch: number }>> {
  const rows = await database.query(async client => (await client.query<{ id: string, status: string, trash_entry_id: string | null, space_id: string, folder_id: string | null, write_epoch: number }>(
    'SELECT id, status, trash_entry_id, space_id, folder_id, write_epoch FROM documents WHERE id = ANY($1::uuid[])',
    [ids],
  )).rows)
  return Object.fromEntries(rows.map(row => [row.id, { status: row.status, entry: row.trash_entry_id, space: row.space_id, folder: row.folder_id, epoch: row.write_epoch }]))
}

/** 这些文件夹当前的状态、所属的删除单元、位置与层数 */
async function foldersOf(ids: readonly string[]): Promise<Record<string, { status: string, entry: string | null, space: string, parent: string | null, depth: number }>> {
  const rows = await database.query(async client => (await client.query<{ id: string, status: string, trash_entry_id: string | null, space_id: string, parent_id: string | null, depth: number }>(
    'SELECT id, status, trash_entry_id, space_id, parent_id, depth FROM folders WHERE id = ANY($1::uuid[])',
    [ids],
  )).rows)
  return Object.fromEntries(rows.map(row => [row.id, { status: row.status, entry: row.trash_entry_id, space: row.space_id, parent: row.parent_id, depth: row.depth }]))
}

/** 某个对象上回收站相关的审计（按时间顺序）：新建与移动的那些不在里面 */
async function auditsOf(targetId: string): Promise<{ action: string, actorType: string, details: Record<string, unknown> }[]> {
  return database.query(async client => (await client.query<{ action: string, actor_type: string, details: Record<string, unknown> }>(
    `SELECT action, actor_type, details FROM audit_events
     WHERE target_id = $1 AND action LIKE ANY (ARRAY['%.deleted', '%.restored', '%.purged']) ORDER BY occurred_at, id`,
    [targetId],
  )).rows.map(row => ({ action: row.action, actorType: row.actor_type, details: row.details })))
}

async function documentIds(user: LoggedIn, spaceId: string, folderId = 'all'): Promise<string[]> {
  const response = await asUser(app.baseUrl, user, `/api/documents?spaceId=${spaceId}&folderId=${folderId}`)
  expect(response.status).toBe(200)
  return parseExact(documentListResponseSchema, await response.json()).items.map(item => item.id)
}

/** 模板换上 unitId、A1 写入 value */
function snapshotOf(unitId: string, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8')
}

async function save(user: LoggedIn, document: SeededDocument, value: string, baseRevision: number): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: String(baseRevision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  return asUser(app.baseUrl, user, `/api/documents/${document.id}/content?${query.toString()}`, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(snapshotOf(document.unitId, value)) },
  })
}

/** 在一个空间里建一条 levels 层的链；prefix 用来区分同一个用例里的两条链 */
async function chain(spaceId: string, levels: number, prefix = '第'): Promise<Folder[]> {
  const folders: Folder[] = []
  for (let level = 0; level < levels; level += 1)
    folders.push(await newFolder(amySession, { spaceId, parentId: folders.at(-1)?.id, name: `${prefix} ${level + 1} 层` }))
  return folders
}

/**
 * 直接写库：在一个文件夹里放 count 份各自单独删过的文档（每一份自成一个删除单元）。
 * 只摆出"连带很多个单元"这个局面，删除本身的语义由上面的用例覆盖；经接口删 100 多次太慢
 */
async function seedSeparatelyTrashed(spaceId: string, folderId: string, count: number): Promise<string[]> {
  return database.query(async (client) => {
    const documents = (await client.query<{ id: string }>(
      `INSERT INTO documents (space_id, folder_id, type, title, created_by, unit_id, profile, format_version, sdk_version)
       SELECT $1, $2, 'sheet', '连带 ' || n, $3, gen_random_uuid()::text, 'sheet@1', 1, 'test'
       FROM generate_series(1, $4::int) AS n RETURNING id`,
      [spaceId, folderId, amy.id, count],
    )).rows.map(row => row.id)
    const entries = (await client.query<{ id: string }>(
      `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_space_id, origin_parent_id, title)
       SELECT $1, 'document', $2, now() + make_interval(days => $3::int), $1, $4, '连带'
       FROM unnest($5::uuid[]) RETURNING id`,
      [spaceId, amy.id, TRASH_RETENTION_DAYS, folderId, documents],
    )).rows.map(row => row.id)
    // 一一配对：状态与所属的删除单元要一起写（CHECK 要求二者一致）
    await client.query(
      `UPDATE documents d SET status = 'trashed', trash_entry_id = pair.entry, write_epoch = write_epoch + 1
       FROM (SELECT unnest($1::uuid[]) AS document, unnest($2::uuid[]) AS entry) AS pair WHERE d.id = pair.document`,
      [documents, entries],
    )
    return documents
  })
}

describe('US-M2-09 谁能删（spec §2）', () => {
  it('编辑者删自己创建的文档：进回收站、代次加一、记审计；删别人创建的是 403，什么也不改', async () => {
    const spaceId = await teamSpace()
    const mine = await createDocument(database, { spaceId, createdBy: amy.id, title: '我的' })
    const others = await createDocument(database, { spaceId, createdBy: ben.id, title: '别人的' })

    const denied = await deleteDocument(amySession, others)
    expect(denied.status).toBe(403)
    expect(await errorOf(denied)).toEqual({ code: 'PERMISSION_DENIED', message: '编辑者只能删除自己创建的文档' })
    expect(await documentsOf([others])).toMatchObject({ [others]: { status: 'active', entry: null, epoch: 0 } })

    expect((await deleteDocument(amySession, mine)).status).toBe(204)
    const state = (await documentsOf([mine]))[mine]
    expect(state).toMatchObject({ status: 'trashed', folder: null, epoch: 1 })
    expect(state?.entry).not.toBeNull()
    expect(await auditsOf(mine)).toMatchObject([{ action: 'documents.deleted', actorType: 'user', details: { spaceId, folderId: null, trashEntryId: state?.entry } }])
  })

  it('编辑者删文件夹：里面只有自己的文档可以，有别人的是 403；空文件夹可以', async () => {
    const spaceId = await teamSpace()
    const mine = await newFolder(amySession, { spaceId, name: '我的资料' })
    await createDocument(database, { spaceId, createdBy: amy.id, title: '我的', folderId: mine.id })
    const shared = await newFolder(amySession, { spaceId, name: '公共资料' })
    const inside = await newFolder(amySession, { spaceId, parentId: shared.id, name: '里面' })
    await createDocument(database, { spaceId, createdBy: ben.id, title: '别人的', folderId: inside.id })
    const empty = await newFolder(amySession, { spaceId, name: '空的' })

    // 单独的错误码：界面按错误码取文案，这一条要说"换个人来删"，不能与"空间已归档"说成同一句话（审查 B2）
    const denied = await deleteFolder(amySession, shared.id)
    expect(denied.status).toBe(403)
    expect(await errorOf(denied)).toEqual({ code: 'FOLDER_HAS_OTHERS_DOCUMENTS', message: '文件夹里有别人创建的文档，只有空间管理员能删除' })
    expect(await foldersOf([shared.id, inside.id])).toMatchObject({ [shared.id]: { status: 'active' }, [inside.id]: { status: 'active' } })

    expect((await deleteFolder(amySession, mine.id)).status).toBe(204)
    expect((await deleteFolder(amySession, empty.id)).status).toBe(204)
    expect(await foldersOf([mine.id, empty.id])).toMatchObject({ [mine.id]: { status: 'trashed' }, [empty.id]: { status: 'trashed' } })
  })

  it('编辑者删文件夹只数正常状态的文档：里面别人创建的文档已经单独删进回收站时，照样能删（M2-P6 复核 B 的 S-2）', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(amySession, { spaceId, name: '艾米的资料' })
    await createDocument(database, { spaceId, createdBy: amy.id, title: '我的', folderId: folder.id })
    const bens = await createDocument(database, { spaceId, createdBy: ben.id, title: '本放进来的', folderId: folder.id })
    // 别人的那一份还在：编辑者不能删
    const denied = await deleteFolder(amySession, folder.id)
    expect(denied.status).toBe(403)
    expect((await errorOf(denied)).code).toBe('FOLDER_HAS_OTHERS_DOCUMENTS')
    // 本把自己的那一份删进回收站之后：子树里正常状态的文档全是艾米的，她能删
    expect((await deleteDocument(benSession, bens)).status).toBe(204)
    const response = await deleteFolder(amySession, folder.id)
    expect(response.status, await response.clone().text()).toBe(204)
    expect(await foldersOf([folder.id])).toMatchObject({ [folder.id]: { status: 'trashed' } })
  })

  it('空间管理员删任意；查看者一概不能；归档的空间一概不能', async () => {
    const managed = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId: managed, name: '公共资料' })
    const others = await createDocument(database, { spaceId: managed, createdBy: ben.id, title: '别人的', folderId: folder.id })
    expect((await deleteFolder(amySession, folder.id)).status).toBe(204)
    expect(await documentsOf([others])).toMatchObject({ [others]: { status: 'trashed' } })

    const readOnly = await teamSpace({ amy: 'viewer' })
    const viewerFolder = await newFolder(benSession, { spaceId: readOnly, name: '资料' })
    const viewerDocument = await createDocument(database, { spaceId: readOnly, createdBy: amy.id, title: '本人的' })
    for (const response of [await deleteDocument(amySession, viewerDocument), await deleteFolder(amySession, viewerFolder.id)])
      expect(response.status).toBe(403)

    const archived = await teamSpace({ amy: 'admin' })
    const archivedFolder = await newFolder(amySession, { spaceId: archived, name: '资料' })
    const archivedDocument = await createDocument(database, { spaceId: archived, createdBy: amy.id, title: '归档里的' })
    await setSpaceState(database, archived, { status: 'archived' })
    // 归档也是 403，但是另一个错误码（PERMISSION_DENIED）：界面据此说的是"空间已归档"，不是"里面有别人的文档"
    for (const response of [await deleteDocument(amySession, archivedDocument), await deleteFolder(amySession, archivedFolder.id)]) {
      expect(response.status).toBe(403)
      expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    }
  })
})

describe('US-M2-09 删除单元的粒度（spec §1）', () => {
  it('删文件夹：子树里正常状态的东西全部进同一个删除单元，层数不变，代次都加一', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const [top, middle] = await chain(spaceId, 2)
    const atTop = await createDocument(database, { spaceId, createdBy: amy.id, title: '上层的', folderId: top?.id })
    const deep = await createDocument(database, { spaceId, createdBy: ben.id, title: '深处的', folderId: middle?.id })
    const outside = await createDocument(database, { spaceId, createdBy: amy.id, title: '外面的' })

    const entryId = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, top?.id ?? ''))
    expect(await foldersOf([top?.id ?? '', middle?.id ?? ''])).toEqual({
      [top?.id ?? '']: { status: 'trashed', entry: entryId, space: spaceId, parent: null, depth: 1 },
      [middle?.id ?? '']: { status: 'trashed', entry: entryId, space: spaceId, parent: top?.id ?? null, depth: 2 },
    })
    expect(await documentsOf([atTop, deep, outside])).toMatchObject({
      [atTop]: { status: 'trashed', entry: entryId, epoch: 1 },
      [deep]: { status: 'trashed', entry: entryId, epoch: 1 },
      [outside]: { status: 'active', entry: null, epoch: 0 },
    })
    expect(await auditsOf(top?.id ?? '')).toMatchObject([
      { action: 'folders.deleted', details: { spaceId, parentId: null, trashEntryId: entryId, folders: 2, documents: 2 } },
    ])
  })

  it('子树里早先单独删过的东西（文档与文件夹）留在原来的删除单元里，不并进这次的', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const inside = await newFolder(amySession, { spaceId, parentId: folder.id, name: '里面' })
    const earlierFolder = await newFolder(amySession, { spaceId, parentId: inside.id, name: '早先删的文件夹' })
    const deeper = await newFolder(amySession, { spaceId, parentId: earlierFolder.id, name: '它里面的' })
    const earlier = await createDocument(database, { spaceId, createdBy: amy.id, title: '早先删的', folderId: inside.id })
    const later = await createDocument(database, { spaceId, createdBy: amy.id, title: '后来删的', folderId: inside.id })

    const first = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, earlier))
    const firstFolder = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, earlierFolder.id))
    expect((await deleteFolder(amySession, folder.id)).status).toBe(204)
    const entries = (await trash(amySession, spaceId)).items
    const second = entries.find(entry => entry.id !== first && entry.id !== firstFolder)?.id
    expect(entries.map(entry => [entry.kind, entry.title])).toEqual([['folder', '资料'], ['folder', '早先删的文件夹'], ['document', '早先删的']])
    expect(await documentsOf([earlier, later])).toMatchObject({
      [earlier]: { status: 'trashed', entry: first, epoch: 1 },
      [later]: { status: 'trashed', entry: second, epoch: 1 },
    })
    // 早先删的那棵子树整棵留在它自己的单元里，这次只收走正常状态的那两层
    expect(await foldersOf([folder.id, inside.id, earlierFolder.id, deeper.id])).toMatchObject({
      [folder.id]: { entry: second },
      [inside.id]: { entry: second },
      [earlierFolder.id]: { entry: firstFolder },
      [deeper.id]: { entry: firstFolder },
    })
    // 早先那份不算进这次的份数
    expect(entries.find(entry => entry.id === second)?.documentCount).toBe(1)
    expect(await auditsOf(folder.id)).toMatchObject([{ action: 'folders.deleted', details: { folders: 2, documents: 1 } }])
  })
})

describe('US-M2-09 回收站的列表（spec §6）', () => {
  it('按空间列出：种类、标题、删除者、到期时间、原位置、份数与本人能做的操作；看得到内容的人都看得到', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const parent = await newFolder(amySession, { spaceId, name: '归档' })
    const folder = await newFolder(amySession, { spaceId, parentId: parent.id, name: '资料' })
    await createDocument(database, { spaceId, createdBy: amy.id, title: '里面的', folderId: folder.id })
    const loose = await createDocument(database, { spaceId, createdBy: ben.id, title: '本的周报' })
    expect((await deleteFolder(amySession, folder.id)).status).toBe(204)
    expect((await deleteDocument(benSession, loose)).status).toBe(204)

    const page = await trash(amySession, spaceId)
    expect(page.nextCursor).toBeNull()
    expect(page.items.map(item => [item.kind, item.title, item.documentCount])).toEqual([['document', '本的周报', 1], ['folder', '资料', 1]])
    expect(page.items[0]?.deletedBy).toEqual({ id: ben.id, username: 'ben', displayName: '本' })
    expect(page.items.map(item => item.origin)).toEqual([
      { parentId: null, parentName: null, available: true },
      { parentId: parent.id, parentName: '归档', available: true },
    ])
    // 空间管理员：都能恢复、都能永久删除
    expect(page.items.map(item => item.permissions)).toEqual([{ canRestore: true, canPurge: true }, { canRestore: true, canPurge: true }])
    // 到期时间是删除时间加 30 天
    const [first] = page.items
    expect(Date.parse(first?.expiresAt ?? '') - Date.parse(first?.deletedAt ?? '')).toBe(TRASH_RETENTION_DAYS * 24 * 3600 * 1000)

    // 编辑者（本）看得到同一个列表：只能恢复自己删的，不能永久删除
    expect((await trash(benSession, spaceId)).items.map(item => item.permissions))
      .toEqual([{ canRestore: true, canPurge: false }, { canRestore: false, canPurge: false }])
    // 看不到这个空间的人：与空间不存在同一个 NOT_FOUND
    const unseen = await asUser(app.baseUrl, catSession, `/api/trash?spaceId=${spaceId}`)
    const missing = await asUser(app.baseUrl, catSession, `/api/trash?spaceId=${MISSING_ID}`)
    expect([unseen.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(unseen)).toEqual(await errorOf(missing))
  })

  it(`按删除时间从新到旧分页：每页 ${TRASH_LIST_PAGE_SIZE} 条，游标接着下一页；游标不合法是 REQUEST_INVALID`, async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const removed: string[] = []
    for (let index = 0; index <= TRASH_LIST_PAGE_SIZE; index += 1) {
      const document = await createDocument(database, { spaceId, createdBy: amy.id, title: `文档 ${index}` })
      expect((await deleteDocument(amySession, document)).status).toBe(204)
      removed.push(document)
    }
    const first = await trash(amySession, spaceId)
    expect(first.items).toHaveLength(TRASH_LIST_PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()
    // 最后删的排在最前面
    expect(first.items.map(item => item.title)).toEqual(removed.map((_, index) => `文档 ${removed.length - 1 - index}`).slice(0, TRASH_LIST_PAGE_SIZE))
    const next = await trash(amySession, spaceId, first.nextCursor ?? '')
    expect(next.items.map(item => item.title)).toEqual(['文档 0'])
    expect(next.nextCursor).toBeNull()

    const bad = await asUser(app.baseUrl, amySession, `/api/trash?spaceId=${spaceId}&cursor=%E4%B9%B1%E5%86%99%E7%9A%84`)
    expect(bad.status).toBe(400)
    expect((await errorOf(bad)).code).toBe('REQUEST_INVALID')
  })

  it('原来的父文件夹也在回收站里：原位置已不存在（恢复会回到根目录）', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const parent = await newFolder(amySession, { spaceId, name: '归档' })
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '周报', folderId: parent.id })
    expect((await deleteDocument(amySession, document)).status).toBe(204)
    expect((await deleteFolder(amySession, parent.id)).status).toBe(204)
    const entry = (await trash(amySession, spaceId)).items.find(item => item.kind === 'document')
    expect(entry?.origin).toEqual({ parentId: parent.id, parentName: null, available: false })
  })
})

describe('US-M2-09 恢复（spec §3）', () => {
  it('原位置还在：回到原来的文件夹；代次不再加一；删除单元没了，记审计', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '周报', folderId: folder.id })
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, document))

    expect(await restored(await restore(amySession, entryId)))
      .toEqual({ id: document, kind: 'document', title: '周报', spaceId, folderId: folder.id, movedToRoot: false })
    expect(await documentsOf([document])).toMatchObject({ [document]: { status: 'active', entry: null, folder: folder.id, epoch: 1 } })
    expect(await count('SELECT count(*) FROM trash_entries WHERE id = $1', [entryId])).toBe(0)
    expect(await auditsOf(document)).toMatchObject([
      { action: 'documents.deleted' },
      { action: 'documents.restored', details: { spaceId, folderId: folder.id, movedToRoot: false, trashEntryId: entryId } },
    ])
    expect((await documentIds(amySession, spaceId, folder.id))).toEqual([document])
  })

  /**
   * 原位置不在了只有"父文件夹自己也在回收站里"这一种走得到：
   * 父文件夹被永久删除时，里面的东西（包括早先单独删过的）随连带一起没了（spec §4），不会剩下一个原位置指着空处。
   * 层数超过上限的回落同理走不到：整棵子树跟着父辈一起移动、一起算层数，删除时装得下，恢复时就装得回去。
   */
  it('原位置的父文件夹也在回收站里：回到空间的根目录并带标志', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const parent = await newFolder(amySession, { spaceId, name: '会被删的' })
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: 'A', folderId: parent.id })
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, document))
    expect((await deleteFolder(amySession, parent.id)).status).toBe(204)

    expect(await restored(await restore(amySession, entryId))).toMatchObject({ id: document, folderId: null, movedToRoot: true })
    expect(await documentsOf([document])).toMatchObject({ [document]: { status: 'active', entry: null, folder: null } })
    expect(await documentIds(amySession, spaceId, 'all')).toEqual([document])
  })

  it('文件夹整单恢复：整棵子树回到正常状态，层数按新位置重算；里面的文档位置不变', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const [top, middle, leaf] = await chain(spaceId, 3)
    const deep = await createDocument(database, { spaceId, createdBy: amy.id, title: '最深的', folderId: leaf?.id })
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, middle?.id ?? ''))
    expect(await restored(await restore(amySession, entryId))).toMatchObject({ id: middle?.id, kind: 'folder', folderId: top?.id, movedToRoot: false })
    expect(await foldersOf([middle?.id ?? '', leaf?.id ?? ''])).toEqual({
      [middle?.id ?? '']: { status: 'active', entry: null, space: spaceId, parent: top?.id ?? null, depth: 2 },
      [leaf?.id ?? '']: { status: 'active', entry: null, space: spaceId, parent: middle?.id ?? null, depth: 3 },
    })
    expect(await documentsOf([deep])).toMatchObject({ [deep]: { status: 'active', entry: null, folder: leaf?.id } })

    // 原来的父文件夹被删掉之后再恢复：整棵回到根目录，层数从头算
    const again = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, middle?.id ?? ''))
    expect((await deleteFolder(amySession, top?.id ?? '')).status).toBe(204)
    expect(await restored(await restore(amySession, again))).toMatchObject({ folderId: null, movedToRoot: true })
    expect(await foldersOf([middle?.id ?? '', leaf?.id ?? ''])).toMatchObject({
      [middle?.id ?? '']: { parent: null, depth: 1 },
      [leaf?.id ?? '']: { parent: middle?.id ?? null, depth: 2 },
    })
  })

  it('留在回收站里的子孙也跟着重算层数：恢复之后合法的移动不再被误拒（审查 A2）', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const [top, middle, leaf] = await chain(spaceId, 3)
    // 由深到浅逐个单独删：三棵各自成一个删除单元（删除不动父子关系与层数）
    const leafEntry = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, leaf?.id ?? ''))
    const middleEntry = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, middle?.id ?? ''))
    expect((await deleteFolder(amySession, top?.id ?? '')).status).toBe(204)

    // top 还在回收站里，所以 middle 回到空间的根目录：整棵子树一起降一层，leaf 从第 3 层降到第 2 层
    expect(await restored(await restore(amySession, middleEntry))).toMatchObject({ folderId: null, movedToRoot: true })
    expect(await foldersOf([middle?.id ?? '', leaf?.id ?? ''])).toMatchObject({
      [middle?.id ?? '']: { status: 'active', entry: null, parent: null, depth: 1 },
      // leaf 仍然留在它自己的删除单元里，只有层数跟着变
      [leaf?.id ?? '']: { status: 'trashed', entry: leafEntry, parent: middle?.id ?? null, depth: 2 },
    })

    // 接着把 middle 移到一条 8 层链子的最深处：整棵（含回收站里的 leaf）到第 9、10 层，正好装得下，不该被 409 拒绝
    const deep = await chain(spaceId, 8, '深')
    const moved = await asUser(app.baseUrl, amySession, `/api/folders/${middle?.id ?? ''}/move`, { method: 'POST', body: { spaceId, folderId: deep.at(-1)?.id } })
    expect(moved.status, await moved.clone().text()).toBe(200)
    expect(await foldersOf([middle?.id ?? '', leaf?.id ?? ''])).toMatchObject({
      [middle?.id ?? '']: { depth: 9 },
      [leaf?.id ?? '']: { depth: 10 },
    })
  })

  it('子孙里属于别的删除单元的东西仍然留在回收站里（spec §3 的"顺序"）', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const earlier = await createDocument(database, { spaceId, createdBy: amy.id, title: '早先删的', folderId: folder.id })
    const first = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, earlier))
    const second = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, folder.id))

    expect(await restored(await restore(amySession, second))).toMatchObject({ id: folder.id, movedToRoot: false })
    expect(await foldersOf([folder.id])).toMatchObject({ [folder.id]: { status: 'active', entry: null } })
    expect(await documentsOf([earlier])).toMatchObject({ [earlier]: { status: 'trashed', entry: first } })
    // 那一单还在回收站里，原位置又回来了
    expect((await trash(amySession, spaceId)).items.map(item => [item.id, item.origin.available])).toEqual([[first, true]])
  })

  it('恢复的权限：删除者与空间管理员可以，同空间的另一个编辑者不行；被移出空间、被降为查看者的删除者与归档之后都不行', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const document = await createDocument(database, { spaceId, createdBy: ben.id, title: '本的' })
    const entryId = await trashedEntry(benSession, spaceId, async () => deleteDocument(benSession, document))

    const another = await createAccount(database, { username: `dan${spaces}`, displayName: '丹' })
    await setMember(database, spaceId, another.id, 'editor')
    const danSession = await login(app.baseUrl, another.username, another.password)
    const denied = await restore(danSession, entryId)
    expect(denied.status).toBe(403)
    expect(await errorOf(denied)).toEqual({ code: 'PERMISSION_DENIED', message: '只有删除的人或空间管理员能恢复' })

    // 删完之后被移出空间的人：连回收站都看不到了
    await setMember(database, spaceId, ben.id, undefined)
    expect((await restore(benSession, entryId)).status).toBe(404)

    // 删完之后被降为查看者：本人也不能再恢复（恢复是把内容放回空间里，按当前权限算）
    await setMember(database, spaceId, ben.id, 'viewer')
    const demoted = await restore(benSession, entryId)
    expect(demoted.status).toBe(403)
    expect(await errorOf(demoted)).toEqual({ code: 'PERMISSION_DENIED', message: '只有删除的人或空间管理员能恢复' })
    expect((await trash(benSession, spaceId)).items.map(item => item.permissions)).toEqual([{ canRestore: false, canPurge: false }])
    await setMember(database, spaceId, ben.id, 'editor')

    // 归档之后：空间管理员与删除者本人都不能恢复；列表里的权限位也一起变
    await setSpaceState(database, spaceId, { status: 'archived' })
    for (const session of [amySession, benSession]) {
      const archived = await restore(session, entryId)
      expect(archived.status).toBe(403)
      expect((await errorOf(archived)).message).toBe('空间已归档，只能查看')
    }
    expect((await trash(benSession, spaceId)).items.map(item => item.permissions)).toEqual([{ canRestore: false, canPurge: false }])
    await setSpaceState(database, spaceId, { status: 'active' })

    expect((await restore(benSession, entryId)).status).toBe(200)
  })
})

describe('US-M2-09 永久删除（spec §4）', () => {
  it('内容与修订记录一起没了；只有空间管理员能做；记审计', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, document.id))

    const denied = await purge(benSession, entryId)
    expect(denied.status).toBe(403)
    expect(await errorOf(denied)).toEqual({ code: 'PERMISSION_DENIED', message: '只有空间管理员能永久删除' })

    expect((await purge(amySession, entryId)).status).toBe(204)
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document.id])).toBe(0)
    expect(await count('SELECT count(*) FROM document_contents WHERE document_id = $1', [document.id])).toBe(0)
    expect(await count('SELECT count(*) FROM document_revisions WHERE document_id = $1', [document.id])).toBe(0)
    expect(await count('SELECT count(*) FROM trash_entries WHERE id = $1', [entryId])).toBe(0)
    const audits = await auditsOf(document.id)
    expect(audits).toMatchObject([{ action: 'documents.deleted' }, { action: 'documents.purged', actorType: 'user' }])
    // 明细逐字段相等：只记份数与删除单元，不记标题（M2 总设计 §2.1 第 5 条，M2-P6 复核 M-1）
    expect(audits[1]?.details).toEqual({ spaceId, trashEntryId: entryId, folders: 0, documents: 1, cascadedEntries: 0 })
  })

  it('连带：子树里属于别的删除单元的行一起删掉，那些单元也一起清掉，审计记下份数', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const inside = await newFolder(amySession, { spaceId, parentId: folder.id, name: '里面' })
    const earlierDocument = await createDocument(database, { spaceId, createdBy: amy.id, title: '早先删的文档', folderId: inside.id })
    const earlierFolder = await newFolder(amySession, { spaceId, parentId: inside.id, name: '早先删的文件夹' })
    const insideEarlier = await createDocument(database, { spaceId, createdBy: amy.id, title: '它里面的', folderId: earlierFolder.id })
    const later = await createDocument(database, { spaceId, createdBy: amy.id, title: '后来删的', folderId: inside.id })

    const documentEntry = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, earlierDocument))
    const folderEntry = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, earlierFolder.id))
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, folder.id))
    expect((await trash(amySession, spaceId)).items).toHaveLength(3)

    expect((await purge(amySession, entryId)).status).toBe(204)
    expect(await count('SELECT count(*) FROM documents WHERE id = ANY($1::uuid[])', [[earlierDocument, insideEarlier, later]])).toBe(0)
    expect(await count('SELECT count(*) FROM folders WHERE id = ANY($1::uuid[])', [[folder.id, inside.id, earlierFolder.id]])).toBe(0)
    expect((await trash(amySession, spaceId)).items).toEqual([])
    // 那两个连带的单元真的清掉了；审计的明细只记份数，不记 id 列表（审查 A1）
    expect(await count('SELECT count(*) FROM trash_entries WHERE id = ANY($1::uuid[])', [[documentEntry, folderEntry]])).toBe(0)
    expect((await auditsOf(folder.id)).at(-1))
      .toMatchObject({ action: 'folders.purged', details: { folders: 3, documents: 3, trashEntryId: entryId, cascadedEntries: 2 } })
  })

  it('连带上百个删除单元：照样删得掉，审计明细只记份数（审查 A1）', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    // 120 个连带单元：明细里如果记的是 id 列表，早就超过 AUDIT_DETAILS_MAX_BYTES，整个永久删除会 500，那一单永远清不掉
    const documents = await seedSeparatelyTrashed(spaceId, folder.id, 120)
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteFolder(amySession, folder.id))

    expect((await purge(amySession, entryId)).status).toBe(204)
    expect(await count('SELECT count(*) FROM documents WHERE id = ANY($1::uuid[])', [documents])).toBe(0)
    expect(await count('SELECT count(*) FROM folders WHERE id = $1', [folder.id])).toBe(0)
    expect(await count('SELECT count(*) FROM trash_entries WHERE space_id = $1', [spaceId])).toBe(0)
    expect((await auditsOf(folder.id)).at(-1)).toMatchObject({
      action: 'folders.purged',
      details: { spaceId, trashEntryId: entryId, folders: 1, documents: 120, cascadedEntries: 120 },
    })
  })

  it('归档的空间里不能永久删除；删除单元不存在与看不到那个空间：同一个 NOT_FOUND', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, document))

    await setSpaceState(database, spaceId, { status: 'archived' })
    const archived = await purge(amySession, entryId)
    expect(archived.status).toBe(403)
    expect((await errorOf(archived)).message).toBe('空间已归档，只能查看')
    await setSpaceState(database, spaceId, { status: 'active' })

    const unseen = await purge(catSession, entryId)
    const missing = await purge(catSession, MISSING_ID)
    expect([unseen.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(unseen)).toEqual(await errorOf(missing))
    expect((await purge(amySession, entryId)).status).toBe(204)
    // 已经永久删除了：再恢复、再永久删除都是 NOT_FOUND
    expect((await restore(amySession, entryId)).status).toBe(404)
    expect((await purge(amySession, entryId)).status).toBe(404)
  })
})

describe('US-M2-09 回收站里的东西对普通接口不存在（spec §5）', () => {
  it('不在列表里；打开、保存、改名、移动、复制、再删除都是 NOT_FOUND，与不存在一致', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const target = await newFolder(amySession, { spaceId, name: '目标' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const staying = await createDocument(database, { spaceId, createdBy: amy.id, title: '留着的' })
    expect((await deleteDocument(amySession, document.id)).status).toBe(204)

    expect(await documentIds(amySession, spaceId)).toEqual([staying])
    const requests: [string, Response][] = [
      ['元数据', await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`)],
      ['内容', await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/content`)],
      ['保存', await save(amySession, document, '删了之后', 1)],
      ['改名', await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`, { method: 'PATCH', body: { title: '改名' } })],
      ['移动', await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId, folderId: target.id } })],
      ['复制', await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId, requestId: randomUUID() } })],
      ['再删除', await deleteDocument(amySession, document.id)],
    ]
    const missing = await errorOf(await asUser(app.baseUrl, amySession, `/api/documents/${MISSING_ID}`))
    for (const [name, response] of requests) {
      expect(response.status, name).toBe(404)
      expect(await errorOf(response), name).toEqual(missing)
    }
  })

  it('回收站里的文件夹：列不出来、改不了名、移不动、删不了，都与不存在一致', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const keep = await newFolder(amySession, { spaceId, name: '留着的' })
    expect((await deleteFolder(amySession, folder.id)).status).toBe(204)

    const listed = await asUser(app.baseUrl, amySession, `/api/folders?spaceId=${spaceId}`)
    expect(listed.status).toBe(200)
    expect(parseExact(folderListResponseSchema, await listed.json()).items.map(item => item.id)).toEqual([keep.id])
    const requests: [string, Response][] = [
      ['列出那一层', await asUser(app.baseUrl, amySession, `/api/folders?spaceId=${spaceId}&parentId=${folder.id}`)],
      ['改名', await asUser(app.baseUrl, amySession, `/api/folders/${folder.id}`, { method: 'PATCH', body: { name: '改名' } })],
      ['移动', await asUser(app.baseUrl, amySession, `/api/folders/${folder.id}/move`, { method: 'POST', body: { spaceId } })],
      ['往里新建', await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, parentId: folder.id, name: '新的', requestId: randomUUID() } })],
      ['再删除', await deleteFolder(amySession, folder.id)],
    ]
    const missing = await errorOf(await asUser(app.baseUrl, amySession, `/api/folders?spaceId=${spaceId}&parentId=${MISSING_ID}`))
    for (const [name, response] of requests) {
      expect(response.status, name).toBe(404)
      expect(await errorOf(response), name).toEqual(missing)
    }
  })
})

describe('US-M2-09 跨空间移动与删除单元（spec §6b）', () => {
  it('子树整体换空间：里面的删除单元跟着改登记空间，在新空间的回收站里看得到，恢复回到新空间的原位置', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId: from, name: '资料' })
    const inside = await newFolder(amySession, { spaceId: from, parentId: folder.id, name: '里面' })
    const document = await createDocument(database, { spaceId: from, createdBy: amy.id, title: '删过的', folderId: inside.id })
    const subFolder = await newFolder(amySession, { spaceId: from, parentId: inside.id, name: '删过的文件夹' })
    const documentEntry = await trashedEntry(amySession, from, async () => deleteDocument(amySession, document))
    expect((await deleteFolder(amySession, subFolder.id)).status).toBe(204)

    expect((await asUser(app.baseUrl, amySession, `/api/folders/${folder.id}/move`, { method: 'POST', body: { spaceId: to } })).status).toBe(200)
    // 原空间的回收站空了，新空间的回收站里有这两单
    expect((await trash(amySession, from)).items).toEqual([])
    const moved = await trash(amySession, to)
    expect(moved.items.map(item => [item.kind, item.title])).toEqual([['folder', '删过的文件夹'], ['document', '删过的']])
    expect(moved.items.every(item => item.spaceId === to)).toBe(true)
    expect(moved.items.find(item => item.id === documentEntry)?.origin).toEqual({ parentId: inside.id, parentName: '里面', available: true })

    expect(await restored(await restore(amySession, documentEntry))).toMatchObject({ spaceId: to, folderId: inside.id, movedToRoot: false })
    expect(await documentsOf([document])).toMatchObject({ [document]: { status: 'active', space: to, folder: inside.id } })
    // origin_space_id 也跟着改了
    expect(await count('SELECT count(*) FROM trash_entries WHERE space_id = $1 AND origin_space_id = $1', [to])).toBe(1)
  })
})

describe('US-M2-14 回收站的并发（spec §7）', () => {
  it('删文件夹等锁期间有人往子树里移进新文档：锁下才展开子树，那份文档也一起进回收站', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const document = await createDocument(database, { spaceId, createdBy: ben.id, title: '后来才进来的' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(spaceId),
      request: async () => deleteFolder(amySession, folder.id),
      change: async client => client.query('UPDATE documents SET folder_id = $2 WHERE id = $1', [document, folder.id]),
    })
    expect(response.status).toBe(204)
    const state = (await documentsOf([document]))[document]
    expect(state).toMatchObject({ status: 'trashed', epoch: 1 })
    expect(await auditsOf(folder.id)).toMatchObject([{ action: 'folders.deleted', details: { documents: 1 } }])
    // 删掉之后再往里移：目标文件夹已经在回收站里，NOT_FOUND
    const another = await createDocument(database, { spaceId, createdBy: amy.id, title: '又一份' })
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${another}`, { method: 'PATCH', body: { folderId: folder.id } })).status).toBe(404)
  })

  it('恢复与永久删除同时发生：先拿到锁的做成，后到的看到删除单元已经不在（NOT_FOUND）', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const entryId = await trashedEntry(amySession, spaceId, async () => deleteDocument(amySession, document))
    const [first, second] = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(spaceId),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const restoring = step(restore(amySession, entryId))
        await waitForWaiting(1)
        return Promise.all([restoring, step(purge(amySession, entryId))])
      },
      // 两个请求都在树锁上排队，放开之后按到达的顺序执行
      change: async client => client.query('SELECT 1'),
    })
    expect(first?.status).toBe(200)
    expect(second?.status).toBe(404)
    expect(await documentsOf([document])).toMatchObject({ [document]: { status: 'active', entry: null } })
  })

  it('删除与保存同时发生：删除之前的保存照常写入，删除之后的保存被拒（保存不取树锁）', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const [saved, removed] = await raceAgainstHeldLock(database, {
      // 持住文档行：保存与删除都要锁它，按到达的顺序排队
      hold: async client => client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [document.id]),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const saving = step(save(amySession, document, '删之前写的', 1))
        await waitForWaiting(1)
        return Promise.all([saving, step(deleteDocument(amySession, document.id))])
      },
      change: async client => client.query('SELECT 1'),
    })
    expect([saved?.status, removed?.status]).toEqual([200, 204])
    // 删除之前写进去的内容随文档进了回收站；删除之后的保存被拒
    expect(await count('SELECT count(*) FROM document_revisions WHERE document_id = $1', [document.id])).toBe(2)
    expect((await save(amySession, document, '删之后写的', 2)).status).toBe(404)
  })

  /**
   * 树锁是按取锁之前读到的空间取的：刚好被跨空间移走时这把锁保护不到它，所以四个写操作都在锁下重新核对一次空间。
   * 恢复这一处沉淀成用例（审查 A 建议 8），删除文档、删除文件夹、文件夹与文档的改名和移动是同一条范式。
   */
  it('等树锁期间这一单被搬到别的空间：恢复 404，那份文档还在回收站里', async () => {
    const from = await teamSpace({ amy: 'admin' })
    const to = await teamSpace({ amy: 'admin' })
    const document = await createDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })
    const entryId = await trashedEntry(amySession, from, async () => deleteDocument(amySession, document))
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => restore(amySession, entryId),
      // 恢复正等在来源空间的树锁上：这一单连同那份文档被搬到另一个空间（跨空间移动的效果）。
      // 艾米在新空间里也是空间管理员，所以挡住它的只能是锁下"这一单已经不在我锁着的空间里"这一条
      change: async (client) => {
        await client.query('UPDATE documents SET space_id = $2 WHERE id = $1', [document, to])
        await client.query('UPDATE trash_entries SET space_id = $2, origin_space_id = $2 WHERE id = $1', [entryId, to])
      },
    })
    expect(response.status).toBe(404)
    expect(await documentsOf([document])).toMatchObject({ [document]: { status: 'trashed', entry: entryId, space: to } })
    // 那一单还在新空间的回收站里，没有被这次恢复动过
    expect((await trash(amySession, to)).items.map(item => item.id)).toEqual([entryId])
  })

  it('判断过能删之后、取空间树的锁之前被移出空间：锁下再判断，404，什么也不改', async () => {
    const spaceId = await teamSpace({ amy: 'admin' })
    const folder = await newFolder(amySession, { spaceId, name: '资料' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(spaceId),
      request: async () => deleteFolder(amySession, folder.id),
      change: async client => client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, amy.id]),
    })
    expect(response.status).toBe(404)
    expect(await foldersOf([folder.id])).toMatchObject({ [folder.id]: { status: 'active', entry: null } })
    expect(await count('SELECT count(*) FROM trash_entries WHERE space_id = $1', [spaceId])).toBe(0)
  })
})

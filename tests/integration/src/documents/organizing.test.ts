// 文档的整理（M2-P4 设计 §3.2、§3.4，US-M2-07、08）：改名、空间内移动、跨空间移动与复制。
// 权限（编辑者、空间管理员、查看者、归档的空间）、目标位置的判断（别的空间、回收站里、不存在都是同一个 NOT_FOUND）、
// 写入代次（跨空间加一、空间内不加）、复制的逐字节一致与两份互不影响、requestId 的幂等；
// 并发：移动与保存同时发生、判断过之后目标空间被归档、两个方向的跨空间移动（按空间 id 排序取树锁）；
// 复制的源文档在锁下判断（M2-P6 复核 A 的 S1）：判断之后被移出空间、源被移走时复制被拒绝，
// 复制进行中的移出、删除、移动与保存都等复制提交之后才生效（不成环）；目标空间同样在锁下再判断（复验 R-S1）。
// 复制与其他各类操作两个方向的交错见 copy-locks.test.ts。
import type { CreatedDocument, DocumentDetail } from '@nerve-office/contracts'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createdDocumentSchema, createdFolderSchema, documentDetailSchema, documentListResponseSchema, errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
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

/** 一个新的团队空间：艾米是空间管理员，本是编辑者；凯特不是成员 */
async function teamSpace(options: { status?: 'active' | 'archived', amy?: 'admin' | 'editor' | 'viewer' } = {}): Promise<string> {
  spaces += 1
  const { amy: amyRole = 'admin', ...rest } = options
  return createTeamSpace(database, { name: `整理 ${spaces}`, createdBy: root.id, members: { [amy.id]: amyRole, [ben.id]: 'editor' }, ...rest })
}

async function newFolder(user: LoggedIn, spaceId: string, name: string): Promise<string> {
  const response = await asUser(app.baseUrl, user, '/api/folders', { method: 'POST', body: { spaceId, name, requestId: randomUUID() } })
  expect(response.status).toBe(201)
  return parseExact(createdFolderSchema, await response.json()).id
}

/** 经删除接口把一个文件夹放进回收站（S3 的接口） */
async function trashFolder(folderId: string): Promise<void> {
  expect((await asUser(app.baseUrl, amySession, `/api/folders/${folderId}`, { method: 'DELETE' })).status).toBe(204)
}

async function patch(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}`, { method: 'PATCH', body })
}

async function move(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}/move`, { method: 'POST', body })
}

async function copy(user: LoggedIn, id: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${id}/copy`, { method: 'POST', body: { requestId: randomUUID(), ...body } })
}

async function detail(response: Response): Promise<DocumentDetail> {
  expect(response.status).toBe(200)
  return parseExact(documentDetailSchema, await response.json())
}

/** 复制的响应：201，副本的元数据加上这次是不是重放（M2-P6 复核第二批 S-1） */
async function copyResult(response: Response): Promise<CreatedDocument> {
  expect(response.status).toBe(201)
  return parseExact(createdDocumentSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

/** 模板换上 unitId、A1 写入 value：副本与源的 unitId 相同，同一份快照两边都能保存 */
function snapshotOf(unitId: string, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8')
}

async function save(user: LoggedIn, document: { id: string, unitId: string }, value: string, baseRevision: number): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: String(baseRevision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  const raw = snapshotOf(document.unitId, value)
  return asUser(app.baseUrl, user, `/api/documents/${document.id}/content?${query.toString()}`, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(raw) },
  })
}

interface StoredDocument {
  readonly space_id: string
  readonly folder_id: string | null
  readonly title: string
  readonly revision: number
  readonly write_epoch: number
  readonly unit_id: string
  readonly created_by: string
  readonly status: string
  readonly updated_at: Date
  readonly snapshot: Buffer
}

async function stored(id: string): Promise<StoredDocument> {
  const row = await database.query(async client => (await client.query<StoredDocument>(
    `SELECT d.space_id, d.folder_id, d.title, d.revision, d.write_epoch, d.unit_id, d.created_by, d.status, d.updated_at, c.snapshot
     FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1`,
    [id],
  )).rows[0])
  if (row === undefined)
    throw new Error(`没有文档 ${id}`)
  return row
}

async function auditOf(action: string, targetId: string): Promise<{ actor_id: string, details: Record<string, unknown> }[]> {
  return database.query(async client => (await client.query<{ actor_id: string, details: Record<string, unknown> }>(
    'SELECT actor_id, details FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY occurred_at',
    [action, targetId],
  )).rows)
}

async function idsIn(user: LoggedIn, spaceId: string, folderId?: string): Promise<string[]> {
  const query = folderId === undefined ? '' : `&folderId=${folderId}`
  const response = await asUser(app.baseUrl, user, `/api/documents?spaceId=${spaceId}${query}`)
  expect(response.status).toBe(200)
  return parseExact(documentListResponseSchema, await response.json()).items.map(item => item.id)
}

describe('US-M2-07 改名与空间内移动', () => {
  it('改名：标题改了，写入代次与更新时间都不变（内容没有改），记审计；标题没有变化时不记', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const before = await stored(document.id)
    expect((await detail(await patch(amySession, document.id, { title: ' 月报 ' }))).title).toBe('月报')
    const after = await stored(document.id)
    expect(after).toMatchObject({ title: '月报', write_epoch: 0, revision: 1 })
    expect(after.updated_at).toEqual(before.updated_at)
    // 只记位置，不记改动前后的标题（M2 总设计 §2.1 第 5 条，M2-P6 复核 M-1）
    expect(await auditOf('documents.renamed', document.id)).toEqual([{ actor_id: amy.id, details: { spaceId, folderId: null } }])

    await patch(amySession, document.id, { title: '月报' })
    expect(await auditOf('documents.renamed', document.id)).toHaveLength(1)
  })

  it('空间内移动：文件夹变了、写入代次不变；列表按目录过滤跟着变；记原位置与目标位置', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const folder = await newFolder(amySession, spaceId, '资料')
    expect((await detail(await patch(amySession, document.id, { folderId: folder }))).folderId).toBe(folder)
    expect(await stored(document.id)).toMatchObject({ folder_id: folder, write_epoch: 0 })
    expect(await idsIn(amySession, spaceId)).toEqual([])
    expect(await idsIn(amySession, spaceId, folder)).toEqual([document.id])

    expect((await detail(await patch(amySession, document.id, { folderId: null }))).folderId).toBeNull()
    expect(await idsIn(amySession, spaceId)).toEqual([document.id])
    expect((await auditOf('documents.moved', document.id)).map(event => event.details)).toEqual([
      { fromSpaceId: spaceId, fromFolderId: null, toSpaceId: spaceId, toFolderId: folder },
      { fromSpaceId: spaceId, fromFolderId: folder, toSpaceId: spaceId, toFolderId: null },
    ])
  })

  it('目标文件夹在别的空间里、已经在回收站里、不存在：同一个 NOT_FOUND，什么也不改', async () => {
    const spaceId = await teamSpace()
    const other = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const elsewhere = await newFolder(amySession, other, '别处的资料')
    const trashed = await newFolder(amySession, spaceId, '资料')
    await trashFolder(trashed)
    const responses = [
      await patch(amySession, document.id, { folderId: elsewhere }),
      await patch(amySession, document.id, { folderId: trashed }),
      await patch(amySession, document.id, { folderId: MISSING_ID }),
    ]
    expect(responses.map(response => response.status)).toEqual([404, 404, 404])
    const errors = await Promise.all(responses.map(async response => errorOf(response)))
    expect(errors[1]).toEqual(errors[0])
    expect(errors[2]).toEqual(errors[0])
    expect(await stored(document.id)).toMatchObject({ folder_id: null })
  })

  it('查看者不能改名、不能移动；不是成员的人与不存在的文档都是 NOT_FOUND', async () => {
    const spaceId = await teamSpace({ amy: 'viewer' })
    const document = await seedDocument(database, { spaceId, createdBy: ben.id, title: '周报' })
    const rename = await patch(amySession, document.id, { title: '月报' })
    expect(rename.status).toBe(403)
    expect(await errorOf(rename)).toEqual({ code: 'PERMISSION_DENIED', message: '没有给这份文档改名的权限' })
    const moved = await patch(amySession, document.id, { folderId: null })
    expect(moved.status).toBe(403)
    expect(await errorOf(moved)).toEqual({ code: 'PERMISSION_DENIED', message: '没有移动这份文档的权限' })

    const unseen = await patch(catSession, document.id, { title: '月报' })
    const missing = await patch(catSession, MISSING_ID, { title: '月报' })
    expect([unseen.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(unseen)).toEqual(await errorOf(missing))
    expect(await stored(document.id)).toMatchObject({ title: '周报' })
  })

  it('归档的空间：所有人至多是查看者，改名与移动都被拒绝，说明空间已归档', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    await setSpaceState(database, spaceId, { status: 'archived' })
    const response = await patch(amySession, document.id, { title: '月报' })
    expect(response.status).toBe(403)
    expect((await errorOf(response)).message).toBe('空间已归档，只能查看')
    await setSpaceState(database, spaceId, { status: 'active' })
    expect((await patch(amySession, document.id, { title: '月报' })).status).toBe(200)
  })

  it('两项都给：一次改名并移动，各记一条审计；标题不合法时整条请求拒绝（400）', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const folder = await newFolder(amySession, spaceId, '资料')
    expect(await detail(await patch(amySession, document.id, { title: '月报', folderId: folder }))).toMatchObject({ title: '月报', folderId: folder })
    expect(await auditOf('documents.renamed', document.id)).toHaveLength(1)
    expect(await auditOf('documents.moved', document.id)).toHaveLength(1)

    const invalid = await patch(amySession, document.id, { title: '  ', folderId: null })
    expect(invalid.status).toBe(400)
    expect(await stored(document.id)).toMatchObject({ title: '月报', folder_id: folder })
  })
})

describe('US-M2-07 跨空间移动', () => {
  it('源空间管理员 + 目标的新建权限：换空间与位置、写入代次加一；原空间看不到它了，原空间的编辑者也改不动', async () => {
    const from = await teamSpace()
    const to = await teamSpace({ amy: 'editor' })
    await setMember(database, to, ben.id, undefined)
    const folder = await newFolder(amySession, from, '资料')
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报', folderId: folder })
    const target = await newFolder(amySession, to, '目标')

    const moved = await detail(await move(amySession, document.id, { spaceId: to, folderId: target }))
    expect(moved).toMatchObject({ spaceId: to, folderId: target })
    // 到了新空间只是编辑者：不能再把它移出去
    expect(moved.permissions).toMatchObject({ canEdit: true, canMoveAcrossSpaces: false })
    expect(await stored(document.id)).toMatchObject({ space_id: to, folder_id: target, write_epoch: 1, revision: 1 })
    expect(await idsIn(amySession, from, folder)).toEqual([])
    expect(await idsIn(amySession, to, target)).toEqual([document.id])
    // 原空间的编辑者（不是新空间的成员）连看都看不到了
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`)).status).toBe(404)
    expect((await save(benSession, document, 'x', 1)).status).toBe(404)
    expect(await auditOf('documents.moved', document.id)).toEqual([{
      actor_id: amy.id,
      details: { fromSpaceId: from, fromFolderId: folder, toSpaceId: to, toFolderId: target },
    }])
  })

  it('移到根目录：原来所在的文件夹不跟着走（文件夹属于原来的空间）', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const folder = await newFolder(amySession, from, '资料')
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报', folderId: folder })
    expect((await detail(await move(amySession, document.id, { spaceId: to }))).folderId).toBeNull()
    expect(await stored(document.id)).toMatchObject({ space_id: to, folder_id: null })
  })

  it('只有源空间的空间管理员能移出去：编辑者是 403，什么也不改', async () => {
    const from = await teamSpace({ amy: 'editor' })
    const to = await teamSpace()
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })
    const response = await move(amySession, document.id, { spaceId: to })
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '只有空间管理员能把文档移出这个空间' })
    expect(await stored(document.id)).toMatchObject({ space_id: from, write_epoch: 0 })
  })

  it('目标空间已归档是 409；看不到与不存在是 404；只能查看是 403', async () => {
    const from = await teamSpace()
    const archived = await teamSpace({ status: 'archived' })
    const viewerOnly = await teamSpace({ amy: 'viewer' })
    const unseen = await createTeamSpace(database, { name: `整理 看不到 ${spaces}`, createdBy: root.id })
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })

    const cases: [string, number, string][] = [
      [archived, 409, 'SPACE_ARCHIVED'],
      [viewerOnly, 403, 'PERMISSION_DENIED'],
      [unseen, 404, 'NOT_FOUND'],
      [MISSING_ID, 404, 'NOT_FOUND'],
    ]
    for (const [spaceId, status, code] of cases) {
      const response = await move(amySession, document.id, { spaceId })
      expect(response.status, code).toBe(status)
      expect((await errorOf(response)).code).toBe(code)
    }
    expect(await stored(document.id)).toMatchObject({ space_id: from, write_epoch: 0 })
  })

  it('源空间已归档：所有人至多是查看者，移不走', async () => {
    const from = await teamSpace({ status: 'archived' })
    const to = await teamSpace()
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })
    const response = await move(amySession, document.id, { spaceId: to })
    expect(response.status).toBe(403)
    expect((await errorOf(response)).message).toBe('空间已归档，只能查看')
  })

  it('目标就是现在所在的空间：按空间内移动处理（编辑者就行，代次不变）；重试是幂等的', async () => {
    const spaceId = await teamSpace({ amy: 'editor' })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const folder = await newFolder(amySession, spaceId, '资料')
    expect((await detail(await move(amySession, document.id, { spaceId, folderId: folder }))).folderId).toBe(folder)
    expect(await stored(document.id)).toMatchObject({ folder_id: folder, write_epoch: 0 })
    expect((await detail(await move(amySession, document.id, { spaceId, folderId: folder }))).folderId).toBe(folder)
    expect(await stored(document.id)).toMatchObject({ write_epoch: 0 })
    expect(await auditOf('documents.moved', document.id)).toHaveLength(1)
  })

  it('目标文件夹不在目标空间里：NOT_FOUND，什么也不改', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const elsewhere = await newFolder(amySession, from, '资料')
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })
    const response = await move(amySession, document.id, { spaceId: to, folderId: elsewhere })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toEqual(await errorOf(await move(amySession, document.id, { spaceId: to, folderId: MISSING_ID })))
    expect(await stored(document.id)).toMatchObject({ space_id: from, write_epoch: 0 })
  })
})

describe('US-M2-08 复制', () => {
  /** 一份内容与源不同的文档：复制之后比较字节 */
  async function sourceDocument(spaceId: string, title = '周报'): Promise<SeededDocument> {
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title })
    expect((await save(amySession, document, '只此一份', 1)).status).toBe(200)
    return document
  }

  it('副本与源逐字节一致、unitId 不变：新的 id、修订号 1、代次 0、创建人是操作者，修订记录一条，记审计', async () => {
    const spaceId = await teamSpace()
    const source = await sourceDocument(spaceId)
    const folder = await newFolder(amySession, spaceId, '资料')
    const copied = await copyResult(await copy(amySession, source.id, { spaceId, folderId: folder }))
    expect(copied.id).not.toBe(source.id)
    expect(copied).toMatchObject({ title: '周报 的副本', spaceId, folderId: folder, revision: 1 })

    const [before, after] = [await stored(source.id), await stored(copied.id)]
    expect(after.snapshot.equals(before.snapshot)).toBe(true)
    expect(after.unit_id).toBe(before.unit_id)
    expect(after).toMatchObject({ revision: 1, write_epoch: 0, created_by: amy.id, status: 'active' })
    const revisions = await database.query(async client => (await client.query<{ revision: number, kind: string }>(
      'SELECT revision, kind FROM document_revisions WHERE document_id = $1 ORDER BY revision',
      [copied.id],
    )).rows)
    expect(revisions).toEqual([{ revision: 1, kind: 'created' }])
    expect(await auditOf('documents.copied', copied.id)).toEqual([{
      actor_id: amy.id,
      details: { sourceId: source.id, sourceSpaceId: spaceId, spaceId, folderId: folder },
    }])
  })

  it('两份各自保存互不影响：副本保存之后源的修订号与内容都不变，反过来也一样', async () => {
    const spaceId = await teamSpace()
    const source = await sourceDocument(spaceId)
    const copied = await copyResult(await copy(amySession, source.id, { spaceId }))
    const both = { id: copied.id, unitId: source.unitId }

    expect((await save(amySession, both, '副本改过', 1)).status).toBe(200)
    expect(await stored(copied.id)).toMatchObject({ revision: 2 })
    const sourceAfter = await stored(source.id)
    expect(sourceAfter.revision).toBe(2)
    expect(sourceAfter.snapshot.equals((await stored(copied.id)).snapshot)).toBe(false)

    // 源再保存一次：副本不动（副本的修订号仍然是 2）
    expect((await save(amySession, source, '源又改了', 2)).status).toBe(200)
    expect(await stored(source.id)).toMatchObject({ revision: 3 })
    expect(await stored(copied.id)).toMatchObject({ revision: 2 })
  })

  it('复制到别的空间：要目标空间的新建权限；查看者与归档空间里的文档也能复制出去', async () => {
    const from = await teamSpace({ amy: 'viewer', status: 'archived' })
    const to = await teamSpace({ amy: 'editor' })
    const source = await seedDocument(database, { spaceId: from, createdBy: ben.id, title: '周报' })
    const copied = await copyResult(await copy(amySession, source.id, { spaceId: to, title: '我的副本' }))
    expect(copied).toMatchObject({ title: '我的副本', spaceId: to })
    expect(await stored(copied.id)).toMatchObject({ created_by: amy.id, space_id: to })
  })

  it('看不到源文档、源文档不存在：同一个 NOT_FOUND；目标空间已归档 409、只能查看 403、看不到 404', async () => {
    const spaceId = await teamSpace()
    const source = await seedDocument(database, { spaceId, createdBy: amy.id, title: '周报' })
    const unseen = await copy(catSession, source.id, { spaceId: cat.personalSpaceId })
    const missing = await copy(catSession, MISSING_ID, { spaceId: cat.personalSpaceId })
    expect([unseen.status, missing.status]).toEqual([404, 404])
    expect(await errorOf(unseen)).toEqual(await errorOf(missing))

    const archived = await teamSpace({ status: 'archived' })
    const viewerOnly = await teamSpace({ amy: 'viewer' })
    for (const [target, status, code] of [[archived, 409, 'SPACE_ARCHIVED'], [viewerOnly, 403, 'PERMISSION_DENIED']] as const) {
      const response = await copy(amySession, source.id, { spaceId: target })
      expect(response.status, code).toBe(status)
      expect((await errorOf(response)).code).toBe(code)
    }
    // 一次也没有复制成功：这个空间里还是只有源文档
    expect(await database.query(async client => (await client.query('SELECT id FROM documents WHERE space_id = $1', [spaceId])).rowCount)).toBe(1)
  })

  it('目标文件夹：落进指定的文件夹；在别的空间里、已经在回收站里都是 NOT_FOUND，什么也不写', async () => {
    const spaceId = await teamSpace()
    const other = await teamSpace()
    const source = await sourceDocument(spaceId, '季度预算')
    const target = await newFolder(amySession, spaceId, '目标')
    const copied = await copyResult(await copy(amySession, source.id, { spaceId, folderId: target }))
    expect(copied.folderId).toBe(target)
    expect(await stored(copied.id)).toMatchObject({ folder_id: target, space_id: spaceId })
    expect(await idsIn(amySession, spaceId, target)).toEqual([copied.id])

    const elsewhere = await newFolder(amySession, other, '别处的资料')
    const trashed = await newFolder(amySession, spaceId, '删掉的')
    await trashFolder(trashed)
    const responses = [
      await copy(amySession, source.id, { spaceId, folderId: elsewhere }),
      await copy(amySession, source.id, { spaceId, folderId: trashed }),
      await copy(amySession, source.id, { spaceId, folderId: MISSING_ID }),
    ]
    expect(responses.map(response => response.status)).toEqual([404, 404, 404])
    const errors = await Promise.all(responses.map(async response => errorOf(response)))
    expect(errors[1]).toEqual(errors[0])
    expect(errors[2]).toEqual(errors[0])
    // 三次都没有写出副本：这个空间里还是源文档与第一份副本
    expect(await database.query(async client => (await client.query('SELECT id FROM documents WHERE space_id = $1', [spaceId])).rowCount)).toBe(2)
  })

  it('同一个 requestId 重发：只复制一份，返回同一份；换了目标是另一个请求，拒绝', async () => {
    const spaceId = await teamSpace()
    const source = await seedDocument(database, { spaceId, createdBy: amy.id, title: '季报' })
    const requestId = randomUUID()
    const first = await copyResult(await copy(amySession, source.id, { spaceId, requestId }))
    expect(first.replayed).toBe(false)
    expect(await copyResult(await copy(amySession, source.id, { spaceId, requestId }))).toEqual({ ...first, replayed: true })
    const conflict = await copy(amySession, source.id, { spaceId, requestId, title: '另一个标题' })
    expect(conflict.status).toBe(409)
    expect((await errorOf(conflict)).code).toBe('REQUEST_ID_CONFLICT')
    expect(await database.query(async client => (await client.query('SELECT id FROM documents WHERE space_id = $1', [spaceId])).rowCount)).toBe(2)
  })

  it('标题超过上限时按码点截断，不截成半个字符', async () => {
    const spaceId = await teamSpace()
    const title = '😀'.repeat(200)
    const source = await seedDocument(database, { spaceId, createdBy: amy.id, title })
    const copied = await copyResult(await copy(amySession, source.id, { spaceId }))
    expect(copied.title).toBe(`${'😀'.repeat(196)} 的副本`)
    expect([...copied.title]).toHaveLength(200)
  })
})

describe('US-M2-14 移动的并发与锁', () => {
  /** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
  function holdSpaceTree(spaceId: string) {
    return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
  }

  it('移动与保存同时发生：移动在文档行上等着，保存的修订号与内容都留住', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [document.id]),
      request: async () => move(amySession, document.id, { spaceId: to }),
      // 保存已经提交（修订号前进）：移动拿到锁之后按新的行版本改
      change: async client => client.query('UPDATE documents SET revision = revision + 1, updated_at = now() WHERE id = $1', [document.id]),
    })
    expect((await detail(response)).revision).toBe(2)
    expect(await stored(document.id)).toMatchObject({ space_id: to, revision: 2, write_epoch: 1 })
  })

  it('判断过之后、取空间树的锁之前，目标空间被归档：锁下再判断，409，不移动', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '周报' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from < to ? from : to),
      request: async () => move(amySession, document.id, { spaceId: to }),
      change: async client => client.query('UPDATE spaces SET status = \'archived\' WHERE id = $1', [to]),
    })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('SPACE_ARCHIVED')
    expect(await stored(document.id)).toMatchObject({ space_id: from, write_epoch: 0 })
  })

  it('两个方向的跨空间移动：都先取排在前面的那个空间的树锁，不成环', async () => {
    const [first, second] = [await teamSpace(), await teamSpace()].toSorted()
    if (first === undefined || second === undefined)
      throw new Error('没有建出两个空间')
    // 从排在后面的空间往前面移：按空间 id 排序取锁的话，先要的是排在前面的那一把
    const document = await seedDocument(database, { spaceId: second, createdBy: amy.id, title: '周报' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(first),
      request: async () => move(amySession, document.id, { spaceId: first }),
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
    expect(await stored(document.id)).toMatchObject({ space_id: first, write_epoch: 1 })
  })
})

describe('US-M2-14 复制的并发与锁：源文档在锁下判断（M2-P6 复核 A 的 S1）', () => {
  /** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步相同） */
  function holdSpaceTree(spaceId: string) {
    return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
  }

  /**
   * 让复制停在"锁都已经取到"之后：另一个事务先写一条同一个 requestId 的修订记录、不提交，
   * 复制最后写修订记录时就在这个唯一键上等着（这时它已经持有空间行与源文档行的共享锁）。
   * 那一行挂在一份无关的文档上：外键检查对源文档行取的锁不能混进来
   */
  function holdRequestId(requestId: string, unrelatedDocumentId: string) {
    return async (client: pg.Client) => client.query(
      `INSERT INTO document_revisions (document_id, revision, kind, request_id, payload_digest, client_instance_id, local_seq, saved_by)
       VALUES ($1, 1000, 'saved', $2, sha256('held'::bytea), gen_random_uuid(), 1, $3)`,
      [unrelatedDocumentId, requestId, cat.id],
    )
  }

  /** 放开那一行：同一个事务里删掉它再提交，复制的修订记录照常写进去 */
  function releaseRequestId(requestId: string) {
    return async (client: pg.Client) => client.query('DELETE FROM document_revisions WHERE request_id = $1', [requestId])
  }

  async function copiesOf(sourceId: string): Promise<string[]> {
    return database.query(async client => (await client.query<{ target_id: string }>(
      'SELECT target_id FROM audit_events WHERE action = \'documents.copied\' AND details->>\'sourceId\' = $1',
      [sourceId],
    )).rows.map(row => row.target_id))
  }

  async function contentOf(documentId: string): Promise<string> {
    return zlib.gunzipSync((await stored(documentId)).snapshot).toString('utf8')
  }

  it('判断过能读源文档之后被移出空间、源文档随后写进了新内容：锁下重新判断，404，不复制（A 的交错）', async () => {
    const space = await teamSpace()
    const document = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '机密' })
    const response = await raceAgainstHeldLock(database, {
      // 挡住复制在目标空间（本的个人空间）的树锁上：源文档的判断已经做完
      hold: holdSpaceTree(ben.personalSpaceId),
      request: async () => copy(benSession, document.id, { spaceId: ben.personalSpaceId }),
      change: async () => {
        // 空间管理员移出本，然后写进本不该再看到的内容；这时本直接读源文档已经是 404
        expect((await asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${ben.id}`, { method: 'DELETE' })).status).toBe(204)
        expect((await save(amySession, document, '移出之后才写的内容', 1)).status).toBe(200)
        expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}/content`)).status).toBe(404)
      },
    })
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('NOT_FOUND')
    expect(await copiesOf(document.id)).toEqual([])
    expect(await idsIn(benSession, ben.personalSpaceId)).toEqual([])
  })

  /**
   * 锁下再判断目标空间（M2-P6 复验 R-S1）：不加锁的判断之后、取到目标空间的树锁之前，目标空间被归档、本被移出或降为查看者。
   * 复制挡在目标空间的树锁上时这些改动提交，锁下的判断必须看到它们——用取锁之前的判断结果就会照样复制进去
   */
  const TARGET_CHANGES: readonly (readonly [string, (client: pg.Client, target: string) => Promise<unknown>, number, string])[] = [
    ['目标空间被归档', async (client, target) => client.query('UPDATE spaces SET status = \'archived\' WHERE id = $1', [target]), 409, 'SPACE_ARCHIVED'],
    ['本被移出目标空间', async (client, target) => client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [target, ben.id]), 404, 'NOT_FOUND'],
    ['本在目标空间被降为查看者', async (client, target) => client.query('UPDATE space_members SET role = \'viewer\' WHERE space_id = $1 AND user_id = $2', [target, ben.id]), 403, 'PERMISSION_DENIED'],
  ]

  it.each(TARGET_CHANGES)('判断之后、取目标空间的树锁之前%s：锁下再判断目标，拒绝，不产生副本（M2-P6 复验 R-S1）', async (_name, change, status, code) => {
    const source = await teamSpace()
    const target = await teamSpace()
    const document = await seedDocument(database, { spaceId: source, createdBy: amy.id, title: '周报' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(target),
      request: async () => copy(benSession, document.id, { spaceId: target }),
      change: async client => change(client, target),
    })
    expect(response.status, await response.clone().text()).toBe(status)
    expect((await errorOf(response)).code).toBe(code)
    expect(await copiesOf(document.id)).toEqual([])
    expect(await database.query(async client => (await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM documents WHERE space_id = $1',
      [target],
    )).rows[0]?.count)).toBe(0)
  })

  it('判断之后、取锁之前源文档被移到了别的空间（本在那里仍然看得到）：锁保护不到它，404，不复制', async () => {
    const space = await teamSpace()
    const elsewhere = await teamSpace()
    const document = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '周报' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(ben.personalSpaceId),
      request: async () => copy(benSession, document.id, { spaceId: ben.personalSpaceId }),
      change: async () => {
        expect((await move(amySession, document.id, { spaceId: elsewhere })).status).toBe(200)
      },
    })
    expect(response.status).toBe(404)
    expect(await copiesOf(document.id)).toEqual([])
  })

  it('复制持着源空间的行锁时移出这个人：移出等复制提交之后才生效，复制照常成功，之后本再也读不到源文档', async () => {
    const space = await teamSpace()
    const document = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '周报' })
    const unrelated = await seedDocument(database, { spaceId: cat.personalSpaceId, createdBy: cat.id, title: '无关' })
    const requestId = randomUUID()
    const [copied, removed] = await raceAgainstHeldLock(database, {
      hold: holdRequestId(requestId, unrelated.id),
      request: async (steps) => {
        const copying = steps.step(copy(benSession, document.id, { spaceId: ben.personalSpaceId, requestId }))
        await steps.waitForWaiting(1)
        // 移出要锁空间行（FOR NO KEY UPDATE）：等在复制持有的共享锁上
        const removing = steps.step(asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${ben.id}`, { method: 'DELETE' }))
        return Promise.all([copying, removing])
      },
      // 两个请求都在锁上等着（复制等这一行，移出等复制）才放开
      change: releaseRequestId(requestId),
      waiting: 2,
    })
    expect(copied.status).toBe(201)
    expect(removed.status).toBe(204)
    expect(await copiesOf(document.id)).toHaveLength(1)
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`)).status).toBe(404)
  })

  /** 复制进行中对源文档的改动：都要锁源文档行（FOR UPDATE） */
  const CHANGES: readonly (readonly [string, (document: SeededDocument, elsewhere: string) => Promise<Response>, number])[] = [
    ['删除', async document => asUser(app.baseUrl, amySession, `/api/documents/${document.id}`, { method: 'DELETE' }), 204],
    ['跨空间移动', async (document, elsewhere) => move(amySession, document.id, { spaceId: elsewhere }), 200],
    ['保存', async document => save(amySession, document, '复制之后才写的内容', 1), 200],
  ]

  it.each(CHANGES)('复制持着源文档行的共享锁时%s等它提交之后才生效：复制照常成功，副本是复制那一刻的内容，不成环', async (_name, change, status) => {
    const space = await teamSpace()
    const elsewhere = await teamSpace()
    const document = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '源文档' })
    const unrelated = await seedDocument(database, { spaceId: cat.personalSpaceId, createdBy: cat.id, title: '无关' })
    const requestId = randomUUID()
    const [copied, changed] = await raceAgainstHeldLock(database, {
      hold: holdRequestId(requestId, unrelated.id),
      request: async (steps) => {
        const copying = steps.step(copy(benSession, document.id, { spaceId: ben.personalSpaceId, requestId }))
        await steps.waitForWaiting(1)
        // 改动要锁源文档行（FOR UPDATE）：等在复制持有的共享锁上
        const changing = steps.step(change(document, elsewhere))
        return Promise.all([copying, changing])
      },
      // 两个请求都在锁上等着（复制等这一行，改动等复制）才放开
      change: releaseRequestId(requestId),
      waiting: 2,
    })
    expect(copied.status, await copied.clone().text()).toBe(201)
    expect(changed.status, await changed.clone().text()).toBe(status)
    // 副本是复制那一刻的内容：之后的保存没有进副本
    expect(await contentOf((await copyResult(copied)).id)).not.toContain('复制之后才写的内容')
  })
})

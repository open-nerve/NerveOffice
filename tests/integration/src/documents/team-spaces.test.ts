// 团队空间里的文档（M2-P2 设计 §3.4–§3.6）：按空间列出、新建到指定空间（M1 兼容、重放、审计）、详情带所在的空间；
// 全员可见与归档；新建与归档、移出成员的并发（两个连接构造的交错）；已经打开的编辑器在撤权之后的保存（M2-P6 复核 S2）。
// 逐格的权限见 permissions/content-matrix.test.ts。
import type { CreatedDocument, DocumentListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createdDocumentSchema, documentDetailSchema, documentListResponseSchema, errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument, seedDocument } from '../support/documents.ts'
import { acquireLease, saveContent } from '../support/edit-leases.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
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
  rootSession = await login(app.baseUrl, 'root', root.password)
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

async function created(response: Response): Promise<CreatedDocument> {
  expect(response.status).toBe(201)
  return parseExact(createdDocumentSchema, await response.json())
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

  it('详情：个人空间的文档带着个人空间，只有 id 与类型（M2-P5：存的名称是所有者建号时的显示名，可以伪造，规范 §2.4；逐字核对，多给一个字段就失败）', async () => {
    const id = await createDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: '私人笔记' })
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${id}`)
    expect(parseExact(documentDetailSchema, await response.json()).space).toEqual({ id: amy.personalSpaceId, type: 'personal' })
  })

  it('同一个请求重放：同样带着空间时返回同一份文档；同一个 requestId 换了空间（或不带空间）是另一个请求', async () => {
    const spaceId = await teamSpace('产品部')
    const requestId = randomUUID()
    const first = await created(await create(amySession, { requestId, spaceId }))
    expect(first.replayed).toBe(false)
    // 重放：同一份文档，标为重放（M2-P6 复核第二批 S-1）
    expect(await created(await create(amySession, { requestId, spaceId }))).toEqual({ ...first, replayed: true })
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
    // 查看者只剩下复制（M2-P4）：能读就能复制，目标空间的新建权限另判
    expect(detail.permissions).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false })
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
    // 查看者只剩下复制（M2-P4）：能读就能复制，目标空间的新建权限另判
    expect(detail.permissions).toEqual({ canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false })
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

describe('US-M2-14 已经打开的编辑器：撤权之后的下一次保存（M2-P6 复核 S2）', () => {
  /** 模板换上 unitId、A1 写入 value 的快照 */
  function snapshotOf(unitId: string, value: string): Uint8Array {
    const sheet = SHEET_TEMPLATE.sheets['sheet-1']
    return zlib.gzipSync(Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8'))
  }

  /**
   * 保存（M3-P1 起要求编辑租约）：没给租约时先以这个人申请、保存之后释放（support/edit-leases.ts）；申请不了的人照样发出，
   * 结果由先于租约的判断给出。在途的保存那一条先申请好、传进来：同一个页面在归档前后各保存一次
   */
  async function save(user: LoggedIn, document: SeededDocument, value: string, baseRevision = 1, lease?: HeldLease): Promise<Response> {
    return saveContent(app.baseUrl, user, document.id, snapshotOf(document.unitId, value), { baseRevision, lease })
  }

  async function contentText(documentId: string): Promise<string> {
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${documentId}/content`)
    expect(response.status).toBe(200)
    // 内容带 Content-Encoding: gzip 下发，fetch 已经解压
    return response.text()
  }

  it('降为查看者：403（只能查看）；移出：404；归档：403（说明空间已归档）；移到他看不到的空间：404；内容一次也没被改', async () => {
    const spaceId = await createTeamSpace(database, { name: '撤权', createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' } })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '撤权的文档' })
    // 编辑器已经打开：读到元数据，能编辑
    const opened = parseExact(documentDetailSchema, await (await asUser(app.baseUrl, benSession, `/api/documents/${document.id}`)).json())
    expect(opened.permissions.canEdit).toBe(true)

    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    const demoted = await save(benSession, document, '降级之后')
    expect(demoted.status).toBe(403)
    expect(await errorOf(demoted)).toEqual({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })

    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'DELETE' })).status).toBe(204)
    const removed = await save(benSession, document, '移出之后')
    expect(removed.status).toBe(404)
    expect((await errorOf(removed)).code).toBe('NOT_FOUND')

    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members`, { method: 'POST', body: { userId: ben.id, role: 'editor' } })).status).toBe(201)
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${spaceId}/archive`, { method: 'POST' })).status).toBe(200)
    const archived = await save(benSession, document, '归档之后')
    expect(archived.status).toBe(403)
    // 与改名、移动、删除一样说明是归档（M2-P6 复核 A 的 G3）
    expect(await errorOf(archived)).toEqual({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${spaceId}/restore`, { method: 'POST' })).status).toBe(200)

    // 空间管理员把文档移到自己的个人空间：本在那里没有角色
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: amy.personalSpaceId } })).status).toBe(200)
    expect((await save(benSession, document, '移走之后')).status).toBe(404)

    expect(await contentText(document.id)).not.toMatch(/之后/)
  })

  it('US-M3-12 M2 接受的窗口在 M3 收口（ADR-014，M2-P2 设计 §7 的审查 A3）：保存已过锁下的判断、还没提交时归档开始——归档要锁这份文档的行，等保存提交之后才生效；之后的保存被拒绝', async () => {
    const spaceId = await createTeamSpace(database, { name: '在途的保存', createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' } })
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '在途' })
    const lease = await acquireLease(app.baseUrl, benSession, document.id)
    let archiving: Promise<Response> | undefined
    let archiveWaited: boolean | undefined
    const response = await raceAgainstHeldLock(database, {
      // 挡住保存的最后一步（换内容）：锁下的判断与租约都已经过了，文档行在这次保存手里
      hold: async client => client.query('SELECT 1 FROM document_contents WHERE document_id = $1 FOR UPDATE', [document.id]),
      request: async () => save(benSession, document, '归档之前提交的保存', 1, lease),
      change: async () => {
        // 归档经收回写入权结束这个空间里的租约，要先锁住这份文档的行：排在这次保存后面。
        // M2 时收回写入权什么也不锁，归档会抢在保存之前提交，保存随后照样写进已归档的空间——就是这里收口的窗口
        archiving = asUser(app.baseUrl, rootSession, `/api/admin/spaces/${spaceId}/archive`, { method: 'POST' })
        archiveWaited = !await completesWithoutWaiting(database, archiving, 2)
      },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    if (archiving === undefined)
      throw new Error('归档没有发出')
    expect([(await archiving).status, archiveWaited]).toEqual([200, true])
    // 保存先提交、归档随后生效：修订号 2 是这次保存；归档结束了本的租约，文档的代次又加一
    const state = await database.query(async client => (await client.query<{ status: string, revision: number, write_epoch: number, end_reason: string | null }>(
      `SELECT s.status, d.revision, d.write_epoch, l.end_reason
       FROM documents d JOIN spaces s ON s.id = d.space_id JOIN document_edit_leases l ON l.document_id = d.id WHERE d.id = $1`,
      [document.id],
    )).rows[0])
    expect(state).toEqual({ status: 'archived', revision: 2, write_epoch: lease.writeEpoch + 1, end_reason: 'revoked' })
    expect(await contentText(document.id)).toContain('归档之前提交的保存')
    // 之后的保存被拒绝：归档的空间里只能查看（先于租约判断），带着原来的租约也一样；什么也没写
    expect(await errorOf(await save(benSession, document, '归档之后的保存', 2, lease))).toEqual({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    expect(await contentText(document.id)).not.toContain('归档之后的保存')
  })
})

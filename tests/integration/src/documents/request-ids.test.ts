// 幂等的 requestId（M2-P6 复核 S2）：别人拿同一个 requestId 重放（新建、复制、新建文件夹、保存），拿不到第一个人的东西，
// 也得不到它的任何信息——一律 409 REQUEST_ID_CONFLICT，错误体里只有码、说明与请求标识；
// 本人重放时已经看不到那份文档（被移出空间、文档进了回收站），同样 409，不返回它的元数据。
// 本人重放只要求仍能访问（00 号计划书 §7.4 第 2 步，M2-P6 复核 A 的 S-4）：提交之后被降为查看者、空间被归档，
// 重发同一个请求拿到原来的结果（保存、新建文档、新建文件夹一致），不是 403——客户端会把 403 当作"没有提交"。
// 新建文件夹与新建文档一样先查重放（M2 Codex 评审复验的一般 4）：只看它现在所在的空间，看得到是重放，看不到是 409。
// 同一个新建文件夹的请求两次同时到达：后拿到空间树的锁的一方在锁下查到前一方建好的，按重放回答（M2 Codex 评审第二轮复验的建议 1）；
// 进了回收站之后原样重发，新建文件夹与新建文档一样是 409，不论这次请求里的空间能新建、只能看还是已经看不到（第二轮复验的一般 4）。
// 修订记录与回执之间同样只用一次（M3-P3 审查 A3）：内容相同的保存（回执）用过的 requestId，新建、复制、另存为副本都是 409；
// 两份文档上同时用同一个 requestId 保存，一份内容相同（回执）、一份内容不同（修订记录），只有一份成功。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createdFolderSchema, errorResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount
let bob: TestAccount
let aliceSession: LoggedIn
let bobSession: LoggedIn
let team: string
let rootId: string
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  rootId = root.id
  alice = await createAccount(database, { username: 'alice' })
  bob = await createAccount(database, { username: 'bob' })
  aliceSession = await login(app.baseUrl, alice.username, alice.password)
  bobSession = await login(app.baseUrl, bob.username, bob.password)
  team = await createTeamSpace(database, { name: '幂等：团队', createdBy: root.id, members: { [alice.id]: 'editor' } })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 409 REQUEST_ID_CONFLICT，错误体里除了码与说明只有请求标识：没有那份文档的任何信息 */
async function expectConflict(response: Response): Promise<void> {
  expect(response.status).toBe(409)
  const body = parseExact(errorResponseSchema, await response.json())
  expect(body.error.code).toBe('REQUEST_ID_CONFLICT')
  expect(Object.keys(body.error).toSorted()).toEqual(['code', 'message', 'requestId'])
}

function gzipOf(unitId: string): Uint8Array {
  return zlib.gzipSync(Buffer.from(sheetSnapshotFor(unitId), 'utf8'))
}

describe('别人的 requestId', () => {
  it('新建：别人用同一个 requestId（请求体完全相同，或者换成自己的空间）一律 409', async () => {
    const requestId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title: 'Alice 的机密', requestId, spaceId: team } })).status).toBe(201)
    await expectConflict(await asUser(app.baseUrl, bobSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title: 'Alice 的机密', requestId, spaceId: team } }))
    await expectConflict(await asUser(app.baseUrl, bobSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId } }))
  })

  it('复制、新建文件夹、保存：别人用同一个 requestId 一律 409；拿它复制他看不到的源文档也是 409 而不是 404（只说明这个 requestId 用过）', async () => {
    const source = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: 'Alice 的源' })
    const bobs = await seedDocument(database, { spaceId: bob.personalSpaceId, createdBy: bob.id, title: 'Bob 的' })

    const copyId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${source.id}/copy`, { method: 'POST', body: { spaceId: alice.personalSpaceId, requestId: copyId } })).status).toBe(201)
    await expectConflict(await asUser(app.baseUrl, bobSession, `/api/documents/${bobs.id}/copy`, { method: 'POST', body: { spaceId: bob.personalSpaceId, requestId: copyId } }))
    await expectConflict(await asUser(app.baseUrl, bobSession, `/api/documents/${source.id}/copy`, { method: 'POST', body: { spaceId: alice.personalSpaceId, requestId: copyId } }))

    const folderId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { spaceId: alice.personalSpaceId, name: 'Alice 的目录', requestId: folderId } })).status).toBe(201)
    await expectConflict(await asUser(app.baseUrl, bobSession, '/api/folders', { method: 'POST', body: { spaceId: bob.personalSpaceId, name: 'Alice 的目录', requestId: folderId } }))

    const saveId = randomUUID()
    // M3-P1 起保存要求编辑租约：两人各自先申请（saveContent）；请求标识的冲突在租约之前判断
    expect((await saveContent(app.baseUrl, aliceSession, source.id, gzipOf(source.unitId), { baseRevision: 1, requestId: saveId })).status).toBe(200)
    await expectConflict(await saveContent(app.baseUrl, bobSession, bobs.id, gzipOf(bobs.unitId), { baseRevision: 1, requestId: saveId }))
  })

  it('本人重放：已经看不到那份文档（被移出空间、文档进了回收站）时 409，不返回它的元数据', async () => {
    const removedId = randomUUID()
    const body = { type: 'sheet', title: '移出之前建的', requestId: removedId, spaceId: team }
    expect((await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body })).status).toBe(201)
    await setMember(database, team, alice.id, undefined)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body }))
    await setMember(database, team, alice.id, 'editor')

    const trashedId = randomUUID()
    const created = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: trashedId } })
    const document = (await created.json()) as { id: string }
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${document.id}`, { method: 'DELETE' })).status).toBe(204)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: trashedId } }))
  })
})

describe('本人重放只要求仍能访问（00 号计划书 §7.4 第 2 步，M2-P6 复核 A 的 S-4）', () => {
  /** 新的团队空间，Alice 是编辑者 */
  async function editorsSpace(): Promise<string> {
    spaces += 1
    return createTeamSpace(database, { name: `幂等：重放 ${spaces}`, createdBy: rootId, members: { [alice.id]: 'editor' } })
  }

  /**
   * 保存（M3-P1 起要求编辑租约）：先申请、保存之后释放（support/edit-leases.ts）。降为查看者、被移出之后申请不了，
   * 重发照样发出（谁的也不是的租约）：重放在租约之前判断，拿到原来的结果（US-M3-13）
   */
  async function save(documentId: string, unitId: string, requestId: string): Promise<Response> {
    return saveContent(app.baseUrl, aliceSession, documentId, gzipOf(unitId), { baseRevision: 1, requestId })
  }

  it('保存已经提交、回包丢了；随后被降为查看者或空间被归档，用同一个 requestId 重发：拿到原来的结果；不是重放的保存仍是 403', async () => {
    const spaceId = await editorsSpace()
    const document = await seedDocument(database, { spaceId, createdBy: alice.id, title: '周报' })
    const requestId = randomUUID()
    const first = await save(document.id, document.unitId, requestId)
    expect(first.status).toBe(200)
    const original: unknown = await first.json()

    await setMember(database, spaceId, alice.id, 'viewer')
    const demoted = await save(document.id, document.unitId, requestId)
    expect({ status: demoted.status, body: await demoted.json() }).toEqual({ status: 200, body: original })
    expect((await save(document.id, document.unitId, randomUUID())).status).toBe(403)

    await setMember(database, spaceId, alice.id, 'admin')
    await setSpaceState(database, spaceId, { status: 'archived' })
    const archived = await save(document.id, document.unitId, requestId)
    expect({ status: archived.status, body: await archived.json() }).toEqual({ status: 200, body: original })
    // 只保存过一次：修订号 2，修订记录两条（新建与这一次保存）
    const revisions = await database.query(async client => (await client.query<{ revision: number }>('SELECT revision FROM document_revisions WHERE document_id = $1 ORDER BY revision', [document.id])).rows)
    expect(revisions.map(row => row.revision)).toEqual([1, 2])
  })

  it('新建文档与新建文件夹：建好之后被降为查看者、空间被归档，重发拿到同一个（201），两者的回答一致；不是重放的新建是 403', async () => {
    const spaceId = await editorsSpace()
    const documentRequest = { type: 'sheet', requestId: randomUUID(), spaceId }
    const folderRequest = { spaceId, name: 'Alice 的文件夹', requestId: randomUUID() }
    const createdDocument = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: documentRequest })
    const createdFolder = await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: folderRequest })
    expect([createdDocument.status, createdFolder.status]).toEqual([201, 201])
    const ids = { document: ((await createdDocument.json()) as { id: string }).id, folder: ((await createdFolder.json()) as { id: string }).id }

    const replayed = async (): Promise<{ document: [number, string], folder: [number, string] }> => {
      const document = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: documentRequest })
      const folder = await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: folderRequest })
      return { document: [document.status, ((await document.json()) as { id: string }).id], folder: [folder.status, ((await folder.json()) as { id: string }).id] }
    }
    await setMember(database, spaceId, alice.id, 'viewer')
    expect(await replayed()).toEqual({ document: [201, ids.document], folder: [201, ids.folder] })
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { ...folderRequest, requestId: randomUUID() } })).status).toBe(403)

    await setMember(database, spaceId, alice.id, 'admin')
    await setSpaceState(database, spaceId, { status: 'archived' })
    expect(await replayed()).toEqual({ document: [201, ids.document], folder: [201, ids.folder] })
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { ...folderRequest, requestId: randomUUID() } })).status).toBe(403)
    const folders = await database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM folders WHERE space_id = $1', [spaceId])).rows[0]?.count))
    expect(folders).toBe(1)
  })

  it('看不到了（被移出空间）：保存的重放是 404（文档在地址里），新建文件夹的重放与新建文档一样是 409，都不给结果、不透露那份文档与那个文件夹', async () => {
    const spaceId = await editorsSpace()
    const document = await seedDocument(database, { spaceId, createdBy: alice.id, title: '周报' })
    const saveId = randomUUID()
    expect((await save(document.id, document.unitId, saveId)).status).toBe(200)
    const folderRequest = { spaceId, name: 'Alice 的文件夹', requestId: randomUUID() }
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: folderRequest })).status).toBe(201)

    await setMember(database, spaceId, alice.id, undefined)
    expect((await save(document.id, document.unitId, saveId)).status).toBe(404)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: folderRequest }))
    // 不是重放的新建照旧：看不到这个空间是 404
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { ...folderRequest, requestId: randomUUID() } })).status).toBe(404)
  })
})

/**
 * 新建文件夹的重放按新建时存下的请求摘要判断（M2 Codex 评审 CX6）：原来拿请求与文件夹现在的名称、位置比较，
 * 建好之后改名、移动（同一个空间里、跨空间），原样的重试被判成冲突（409），客户端随即放弃这个标识；
 * 载荷不同、却碰巧与现状相同的请求反而被当成重放（201、replayed）。与新建文档的重放同一个做法
 */
describe('新建文件夹的重放按新建时的请求（M2 Codex 评审 CX6）', () => {
  interface FolderBody {
    readonly id: string
    readonly spaceId: string
    readonly parentId: string | null
    readonly name: string
    readonly replayed?: boolean
  }

  async function createFolder(body: { readonly spaceId: string, readonly parentId?: string, readonly name: string, readonly requestId: string }): Promise<{ status: number, folder: FolderBody }> {
    const response = await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body })
    return { status: response.status, folder: (await response.json()) as FolderBody }
  }

  it('新建 → 改名 → 原样重发：重放（201、同一个 id、replayed），返回现在的名称；不再建', async () => {
    const request = { spaceId: alice.personalSpaceId, name: '待整理', requestId: randomUUID() }
    const created = await createFolder(request)
    expect(created).toMatchObject({ status: 201, folder: { name: '待整理', replayed: false } })
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${created.folder.id}`, { method: 'PATCH', body: { name: '已整理' } })).status).toBe(200)
    expect(await createFolder(request)).toMatchObject({ status: 201, folder: { id: created.folder.id, name: '已整理', replayed: true } })
    expect(await database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM folders WHERE request_id = $1', [request.requestId])).rows[0]?.count))).toBe(1)
  })

  it('新建 → 同一个空间里移动 → 原样重发：重放；再跨空间移动 → 原样重发：重放，位置是它现在所在的空间', async () => {
    const parent = await createFolder({ spaceId: alice.personalSpaceId, name: '上一层', requestId: randomUUID() })
    const request = { spaceId: alice.personalSpaceId, parentId: parent.folder.id, name: '要搬的', requestId: randomUUID() }
    const created = await createFolder(request)
    expect(created.status).toBe(201)
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${created.folder.id}`, { method: 'PATCH', body: { parentId: null } })).status).toBe(200)
    expect(await createFolder(request)).toMatchObject({ status: 201, folder: { id: created.folder.id, spaceId: alice.personalSpaceId, parentId: null, replayed: true } })

    // 个人空间的所有者是空间管理员，Alice 在团队空间里是编辑者（能新建）：可以把它搬过去
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${created.folder.id}/move`, { method: 'POST', body: { spaceId: team } })).status).toBe(200)
    expect(await createFolder(request)).toMatchObject({ status: 201, folder: { id: created.folder.id, spaceId: team, parentId: null, replayed: true } })
  })

  /** 新的团队空间，Alice 是 role（跨空间移动要源空间的空间管理员） */
  async function spaceWithAlice(role: 'admin' | 'editor'): Promise<string> {
    spaces += 1
    return createTeamSpace(database, { name: `幂等：搬走 ${spaces}`, createdBy: rootId, members: { [alice.id]: role } })
  }

  it('新建 → 跨空间移到看得到的空间 → 原来的空间看不到了 → 原样重发：重放（201、replayed），位置与权限按它现在所在的空间（先查重放，M2 Codex 评审复验的一般 4）', async () => {
    const origin = await spaceWithAlice('admin')
    const request = { spaceId: origin, name: '要搬走的', requestId: randomUUID() }
    const created = await createFolder(request)
    expect(created.status).toBe(201)
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${created.folder.id}/move`, { method: 'POST', body: { spaceId: alice.personalSpaceId } })).status).toBe(200)
    await setMember(database, origin, alice.id, undefined)
    // 原来的空间确实看不到了：不是重放的新建是 404
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { ...request, requestId: randomUUID() } })).status).toBe(404)

    const replayed = await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: request })
    expect(replayed.status).toBe(201)
    expect(await replayed.json()).toMatchObject({ id: created.folder.id, spaceId: alice.personalSpaceId, parentId: null, replayed: true, permissions: { canRename: true, canMoveAcrossSpaces: true, canDelete: true } })
    expect(await database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM folders WHERE request_id = $1', [request.requestId])).rows[0]?.count))).toBe(1)
  })

  it('新建 → 跨空间移走 → 原来的空间与它现在所在的空间都看不到了 → 原样重发：冲突（409），不透露它在哪里', async () => {
    const origin = await spaceWithAlice('admin')
    const target = await spaceWithAlice('editor')
    const request = { spaceId: origin, name: '搬到别处的', requestId: randomUUID() }
    const created = await createFolder(request)
    expect(created.status).toBe(201)
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${created.folder.id}/move`, { method: 'POST', body: { spaceId: target } })).status).toBe(200)
    await setMember(database, origin, alice.id, undefined)
    await setMember(database, target, alice.id, undefined)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: request }))
  })

  it('同一个 requestId、载荷不同：冲突（409），即使这次的载荷与文件夹现在的样子相同（改名之后拿新名称重发）', async () => {
    const request = { spaceId: alice.personalSpaceId, name: '待整理', requestId: randomUUID() }
    const created = await createFolder(request)
    expect(created.status).toBe(201)
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${created.folder.id}`, { method: 'PATCH', body: { name: '已整理' } })).status).toBe(200)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { ...request, name: '已整理' } }))
  })
})

/**
 * 同一个新建文件夹的请求两次同时到达（结果未知之后的重试赶上了还在路上的原请求；M2 Codex 评审复验的一般 4 加上的"锁下再查一次重放"，
 * 第二轮复验的建议 1 补上这条回归）：两次都在锁外查不到，走到空间树的锁上排队；后拿到锁的一方在锁下再查一次，看到前一方建好并提交的，
 * 按重放回答，而不是插入时撞上 requestId 的唯一约束、回 409。这一步成立靠的是数据库的语义——事务级的 advisory lock 到提交才放开，
 * READ COMMITTED 下拿到锁之后的语句看得到前一方已经提交的行——只有真实的数据库证明得了，单元测试的假仓储证明不了。
 * 交错是确定的（support/held-lock.ts）：测试的连接持着这个空间的树锁（与结构性改动的第一步同一个键），等两次请求都在锁上等着了再放开
 */
describe('新建文件夹：同一个请求的两次同时到达（锁下再查一次重放，M2 Codex 评审第二轮复验的建议 1）', () => {
  /** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步同一个键，space-tree.repository.ts） */
  function holdSpaceTree(spaceId: string) {
    return async (client: pg.Client) =>
      client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
  }

  it('两次都在空间树的锁上等着，放开之后：一次新建（201、replayed 为假），一次重放（201、replayed 为真、同一个 id），库里只有一行', async () => {
    const request = { spaceId: alice.personalSpaceId, name: '同时到达的同一个请求', requestId: randomUUID() }
    const responses = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(alice.personalSpaceId),
      request: async () => Promise.all([
        asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: request }),
        asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: request }),
      ]),
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status)).toEqual([201, 201])
    const folders = await Promise.all(responses.map(async response => parseExact(createdFolderSchema, await response.json())))
    expect(folders.map(folder => folder.replayed).toSorted()).toEqual([false, true])
    expect(new Set(folders.map(folder => folder.id)).size).toBe(1)
    expect(await database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM folders WHERE request_id = $1', [request.requestId])).rows[0]?.count))).toBe(1)
  })
})

/**
 * 进了回收站之后原样重发（M2 Codex 评审第二轮复验的一般 4）：回收站里的东西对普通接口不存在，按"看不到"回答，新建文件夹与新建文档一致。
 * 原来新建文件夹按 requestId 只找正常状态的，进了回收站的被当成新的请求，回答随这次请求里的空间而变：能新建时插入撞上唯一约束是 409，
 * 降为查看者是 403，被移出空间是 404——客户端遇到 403、404 会说"新建被拒绝"，实际上却已经建过；新建文档在这三种情况下一律 409
 */
describe('进了回收站之后原样重发：新建文件夹与新建文档一样是 409（M2 Codex 评审第二轮复验的一般 4）', () => {
  /** 这个空间里的文档与文件夹，不论状态 */
  async function contentsOf(spaceId: string): Promise<{ documents: unknown[], folders: unknown[] }> {
    return database.query(async client => ({
      documents: (await client.query('SELECT id, status FROM documents WHERE space_id = $1', [spaceId])).rows,
      folders: (await client.query('SELECT id, status FROM folders WHERE space_id = $1', [spaceId])).rows,
    }))
  }

  it.each([
    ['仍能新建（空间管理员）', 'admin'],
    ['降为查看者', 'viewer'],
    ['被移出空间', undefined],
  ] as const)('%s：文档与文件夹的重放都是 409，不透露它们，也不再建', async (_name, role) => {
    spaces += 1
    const spaceId = await createTeamSpace(database, { name: `幂等：回收站 ${spaces}`, createdBy: rootId, members: { [alice.id]: 'admin' } })
    const documentRequest = { type: 'sheet', title: '要删的表', spaceId, requestId: randomUUID() }
    const folderRequest = { spaceId, name: '要删的文件夹', requestId: randomUUID() }
    const createdDocument = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: documentRequest })
    const createdFolder = await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: folderRequest })
    expect([createdDocument.status, createdFolder.status]).toEqual([201, 201])
    const ids = { document: ((await createdDocument.json()) as { id: string }).id, folder: ((await createdFolder.json()) as { id: string }).id }
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${ids.document}`, { method: 'DELETE' })).status).toBe(204)
    expect((await asUser(app.baseUrl, aliceSession, `/api/folders/${ids.folder}`, { method: 'DELETE' })).status).toBe(204)

    if (role !== 'admin')
      await setMember(database, spaceId, alice.id, role)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: documentRequest }))
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: folderRequest }))
    // 没有因此再建，回收站里的也没有被恢复出来：这个空间里仍只有那两个，都在回收站里
    expect(await contentsOf(spaceId)).toEqual({ documents: [{ id: ids.document, status: 'trashed' }], folders: [{ id: ids.folder, status: 'trashed' }] })
  })
})

/**
 * 修订记录与回执之间同样只用一次（ADR-011"同一个 requestId 用于不同的请求时拒绝"，M3-P3 审查 A3）：两张表各有自己的唯一约束，管不到对方，
 * 所以每一种写入都在事务的第一步取这个 requestId 的 advisory lock、锁下查两张表（RequestLedger）
 */
describe('修订记录与回执之间同样只用一次（M3-P3 审查 A3）', () => {
  /** 这个 requestId 在两张表里各有几条 */
  async function usesOf(requestId: string): Promise<{ revisions: number, receipts: number }> {
    return database.query(async client => (await client.query<{ revisions: number, receipts: number }>(
      `SELECT (SELECT count(*)::int FROM document_revisions WHERE request_id = $1) AS revisions,
              (SELECT count(*)::int FROM document_save_receipts WHERE request_id = $1) AS receipts`,
      [requestId],
    )).rows[0] ?? { revisions: -1, receipts: -1 })
  }

  /** 内容的 gzip：模板换上 unitId，A1 写入 value */
  function contentOf(unitId: string, value: string): Uint8Array {
    const raw = JSON.parse(sheetSnapshotFor(unitId)) as { sheets: Record<string, Record<string, unknown>> }
    const sheet = raw.sheets['sheet-1']
    if (sheet !== undefined)
      sheet.cellData = { 0: { 0: { v: value } } }
    return zlib.gzipSync(Buffer.from(JSON.stringify(raw), 'utf8'))
  }

  it('先后发生：内容相同的保存（回执）用过的 requestId，之后新建、复制、另存为副本一律 409，什么也不建；那次保存的重放照旧', async () => {
    const document = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: '回执用过的' })
    expect((await saveContent(app.baseUrl, aliceSession, document.id, contentOf(document.unitId, '内容'), { baseRevision: 1 })).status).toBe(200)
    const requestId = randomUUID()
    const unchanged = await saveContent(app.baseUrl, aliceSession, document.id, contentOf(document.unitId, '内容'), { baseRevision: 2, requestId })
    expect(unchanged.status).toBe(200)
    const confirmation: unknown = await unchanged.json()
    expect(confirmation).toMatchObject({ revision: 2, unchanged: true })
    const documents = async (): Promise<number> => database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM documents WHERE created_by = $1', [alice.id])).rows[0]?.count))
    const before = await documents()

    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId } }))
    await expectConflict(await asUser(app.baseUrl, aliceSession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId: alice.personalSpaceId, requestId } }))
    await expectConflict(await postConflictCopy(app.baseUrl, aliceSession, document.id, document.unitId, { requestId }))
    expect(await documents()).toBe(before)
    expect(await usesOf(requestId)).toEqual({ revisions: 0, receipts: 1 })
    // 那次保存的原样重发照旧拿到原来的确认
    const replayed = await saveContent(app.baseUrl, aliceSession, document.id, contentOf(document.unitId, '内容'), { baseRevision: 2, requestId })
    expect({ status: replayed.status, body: await replayed.json() }).toEqual({ status: 200, body: confirmation })
  })

  it('反过来：新建用过的 requestId，之后内容相同的保存同样 409，不写回执', async () => {
    const requestId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId } })).status).toBe(201)
    const document = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: '另一份' })
    // 与模板相同的内容（新建的种子内容就是模板）：本该是内容相同、写回执
    await expectConflict(await saveContent(app.baseUrl, aliceSession, document.id, gzipOf(document.unitId), { baseRevision: 1, requestId }))
    expect(await usesOf(requestId)).toEqual({ revisions: 1, receipts: 0 })
  })

  /**
   * 两份文档上同时用同一个 requestId：一份内容相同（写回执）、一份内容不同（写修订记录）。两张表的唯一约束各管各的，原来两边都能成功。
   * 交错是确定的（support/held-lock.ts）：测试的连接以 SHARE 模式锁住两张表，两次保存都走不到插入；没有 requestId 的锁时，两次都已经过了
   * 锁下的再查、停在各自的插入上，放开之后都成功——这正是要排除的；有了这把锁，后到的一方停在锁上，前一方提交之后它在锁下的再查里看到，409
   */
  it('两份文档上并发的同一个 requestId（一份写回执、一份写修订记录）：只有一份成功，另一份 409；这个 requestId 只出现在一张表里', async () => {
    const same = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: '内容相同的那份' })
    const changed = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: '内容不同的那份' })
    expect((await saveContent(app.baseUrl, aliceSession, same.id, contentOf(same.unitId, '内容'), { baseRevision: 1 })).status).toBe(200)
    const sameLease = await acquireLease(app.baseUrl, aliceSession, same.id)
    const changedLease = await acquireLease(app.baseUrl, aliceSession, changed.id)
    const requestId = randomUUID()
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('LOCK TABLE document_save_receipts, document_revisions IN SHARE MODE'),
      request: async () => Promise.all([
        saveContent(app.baseUrl, aliceSession, same.id, contentOf(same.unitId, '内容'), { baseRevision: 2, requestId, lease: sameLease }),
        saveContent(app.baseUrl, aliceSession, changed.id, contentOf(changed.unitId, '改了'), { baseRevision: 1, requestId, lease: changedLease }),
      ]),
      waiting: 2,
      change: async () => undefined,
    })
    await releaseLease(app.baseUrl, aliceSession, same.id, sameLease)
    await releaseLease(app.baseUrl, aliceSession, changed.id, changedLease)
    const outcomes = await Promise.all(responses.map(async response => ({ status: response.status, body: (await response.json()) as { error?: { code: string } } })))
    expect(outcomes.map(outcome => outcome.status).toSorted()).toEqual([200, 409])
    expect(outcomes.find(outcome => outcome.status === 409)?.body.error?.code).toBe('REQUEST_ID_CONFLICT')
    const uses = await usesOf(requestId)
    expect(uses.revisions + uses.receipts).toBe(1)
  })
})

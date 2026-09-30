// 看不到与不存在完全一致（ADR-014；M2-P6 复核 S2，两位审查者的逐条比较合在一起）：带 id 的每一个接口，
// 对"看不到"的对象与"不存在"的对象发同样的请求，比较状态码、错误体（去掉请求标识）、非易变的响应头，
// 以及应用在这个请求里对数据库发出的语句序列（语句文本，按顺序）。语句序列相同，执行路径就相同，耗时没有可以分辨的差别。
// 权限矩阵的 404 格只比较响应；这里另外守着"不存在时也照样查一次"（文件夹、删除单元不存在时用全零的空间判断一次权限）。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { ComparableResponse } from '../support/comparable-response.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import type { StatementCapture } from '../support/statement-capture.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { comparableOf } from '../support/comparable-response.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'
import { captureStatements } from '../support/statement-capture.ts'

/** 发请求的人：外人（与团队空间、别人的个人空间都没有关系）、团队空间的空间管理员、没有加入的系统管理员 */
type ActorName = 'outsider' | 'admin' | 'systemAdmin'

interface World {
  readonly owner: TestAccount
  readonly admin: TestAccount
  readonly outsider: TestAccount
  readonly systemAdmin: TestAccount
  readonly sessions: Readonly<Record<ActorName, LoggedIn>>
  /** 团队空间：空间管理员是 admin，外人与系统管理员都看不到 */
  readonly team: string
  readonly teamDocument: { readonly id: string, readonly unitId: string }
  readonly teamFolder: string
  readonly teamTrashEntry: string
  /** 团队空间回收站里的那份文档：对空间管理员自己也"不存在" */
  readonly teamTrashedDocument: string
  /** owner 的个人空间里的文档、文件夹与删除单元：别人一概看不到 */
  readonly personalDocument: { readonly id: string, readonly unitId: string }
  readonly personalFolder: string
  readonly personalTrashEntry: string
  /** 外人自己的个人空间里的文档与文件夹：他拿它们往看不到的地方放 */
  readonly outsiderDocument: string
  readonly outsiderFolder: string
  /** 一个停用的账户与他的一份文档（系统管理员转移用） */
  readonly leaver: { readonly id: string, readonly document: string }
}

let database: TestDatabase
let app: TestApp
let capture: StatementCapture
let w: World

async function createFolder(session: LoggedIn, spaceId: string, name: string): Promise<string> {
  const response = await asUser(app.baseUrl, session, '/api/folders', { method: 'POST', body: { spaceId, name, requestId: randomUUID() } })
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}

/** 经接口删掉一份文档，返回它的删除单元 */
async function trashed(session: LoggedIn, documentId: string): Promise<string> {
  expect((await asUser(app.baseUrl, session, `/api/documents/${documentId}`, { method: 'DELETE' })).status).toBe(204)
  const entry = await database.query(async client => (await client.query<{ trash_entry_id: string }>(
    'SELECT trash_entry_id FROM documents WHERE id = $1',
    [documentId],
  )).rows[0]?.trash_entry_id)
  if (entry === undefined)
    throw new Error('删除之后没有删除单元')
  return entry
}

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const owner = await createAccount(database, { username: 'parity-owner' })
  const admin = await createAccount(database, { username: 'parity-admin' })
  const outsider = await createAccount(database, { username: 'parity-outsider' })
  const systemAdmin = await createAccount(database, { username: 'parity-system-admin', systemRole: 'admin' })
  const sessions = {
    owner: await login(app.baseUrl, owner.username, owner.password),
    admin: await login(app.baseUrl, admin.username, admin.password),
    outsider: await login(app.baseUrl, outsider.username, outsider.password),
    systemAdmin: await login(app.baseUrl, systemAdmin.username, systemAdmin.password),
  }
  const team = await createTeamSpace(database, { name: '一致：团队', createdBy: systemAdmin.id, members: { [admin.id]: 'admin' } })
  const teamTrashedDocument = (await seedDocument(database, { spaceId: team, createdBy: admin.id, title: '团队里删掉的' })).id
  const personalTrashed = (await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '个人空间里删掉的' })).id
  const leaver = await createPassiveAccount(database, { username: 'parity-leaver', status: 'disabled' })
  w = {
    owner,
    admin,
    outsider,
    systemAdmin,
    sessions: { outsider: sessions.outsider, admin: sessions.admin, systemAdmin: sessions.systemAdmin },
    team,
    teamDocument: await seedDocument(database, { spaceId: team, createdBy: admin.id, title: '团队里的文档' }),
    teamFolder: await createFolder(sessions.admin, team, '团队里的文件夹'),
    teamTrashEntry: await trashed(sessions.admin, teamTrashedDocument),
    teamTrashedDocument,
    personalDocument: await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '个人空间里的文档' }),
    personalFolder: await createFolder(sessions.owner, owner.personalSpaceId, '个人空间里的文件夹'),
    personalTrashEntry: await trashed(sessions.owner, personalTrashed),
    outsiderDocument: (await seedDocument(database, { spaceId: outsider.personalSpaceId, createdBy: outsider.id, title: '外人自己的' })).id,
    outsiderFolder: await createFolder(sessions.outsider, outsider.personalSpaceId, '外人自己的文件夹'),
    leaver: { id: leaver.id, document: (await seedDocument(database, { spaceId: leaver.personalSpaceId, createdBy: leaver.id, title: '停用者的' })).id },
  }
  capture = captureStatements(database.name)
})

afterAll(async () => {
  capture.restore()
  await app.close()
  await database.drop()
})

interface Observed extends ComparableResponse {
  readonly statements: string[]
}

async function observe(request: () => Promise<Response>): Promise<Observed> {
  const { result, statements } = await capture.during(async () => comparableOf(await request()))
  return { ...result, statements }
}

interface Probe {
  readonly name: string
  readonly actor: ActorName
  /** hidden 为真时对看不到的对象发请求，为假时对不存在的对象发同样的请求 */
  readonly request: (session: LoggedIn, hidden: boolean) => Promise<Response>
}

async function call(session: LoggedIn, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return asUser(app.baseUrl, session, path, body === undefined ? { method } : { method, body })
}

/** 不存在的对象：每次一个新的 id */
const missing = (): string => randomUUID()
/** 看不到的对象或不存在的对象 */
const pick = (hidden: boolean, id: string): string => (hidden ? id : missing())

async function save(session: LoggedIn, documentId: string, unitId: string): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  return asUser(app.baseUrl, session, `/api/documents/${documentId}/content?${query.toString()}`, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(Buffer.from(sheetSnapshotFor(unitId), 'utf8')) },
  })
}

const PROBES: readonly Probe[] = [
  // ---- 文档：外人对团队空间里的文档 ----
  { name: 'GET 文档元数据', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}`) },
  { name: 'GET 文档内容', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/content`) },
  { name: 'PUT 保存内容', actor: 'outsider', request: async (s, h) => save(s, pick(h, w.teamDocument.id), h ? w.teamDocument.unitId : randomUUID()) },
  { name: 'PATCH 改名', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}`, 'PATCH', { title: '新标题' }) },
  { name: 'PATCH 移到根目录', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}`, 'PATCH', { folderId: null }) },
  { name: 'PATCH 空请求体', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}`, 'PATCH', {}) },
  { name: 'POST 移到自己的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/move`, 'POST', { spaceId: w.outsider.personalSpaceId }) },
  { name: 'POST 移到它所在的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/move`, 'POST', { spaceId: w.team }) },
  { name: 'POST 复制到自己的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/copy`, 'POST', { spaceId: w.outsider.personalSpaceId, requestId: randomUUID() }) },
  { name: 'DELETE 文档', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}`, 'DELETE') },
  // ---- 文档：外人对别人个人空间里的文档；空间管理员对回收站里的文档 ----
  { name: 'GET 个人空间的文档元数据', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}`) },
  { name: 'GET 个人空间的文档内容', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}/content`) },
  { name: 'PUT 保存个人空间的文档', actor: 'outsider', request: async (s, h) => save(s, pick(h, w.personalDocument.id), h ? w.personalDocument.unitId : randomUUID()) },
  { name: 'DELETE 个人空间的文档', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}`, 'DELETE') },
  { name: 'GET 回收站里的文档（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}`) },
  { name: 'POST 复制回收站里的文档（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/copy`, 'POST', { spaceId: w.team, requestId: randomUUID() }) },
  // ---- 目标位置：外人把自己的东西往看不到的空间、看不到的空间里的文件夹放 ----
  { name: 'PATCH 自己的文档换到看不到的文件夹', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${w.outsiderDocument}`, 'PATCH', { folderId: pick(h, w.teamFolder) }) },
  { name: 'POST 自己的文档移动，目标文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${w.outsiderDocument}/move`, 'POST', { spaceId: w.outsider.personalSpaceId, folderId: pick(h, w.teamFolder) }) },
  { name: 'POST 自己的文档复制，目标文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${w.outsiderDocument}/copy`, 'POST', { spaceId: w.outsider.personalSpaceId, folderId: pick(h, w.teamFolder), requestId: randomUUID() }) },
  { name: 'POST 自己的文档移到看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${w.outsiderDocument}/move`, 'POST', { spaceId: pick(h, w.team) }) },
  { name: 'POST 自己的文档复制到看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${w.outsiderDocument}/copy`, 'POST', { spaceId: pick(h, w.team), requestId: randomUUID() }) },
  { name: 'POST 新建文档，文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, '/api/documents', 'POST', { type: 'sheet', requestId: randomUUID(), spaceId: w.outsider.personalSpaceId, folderId: pick(h, w.teamFolder) }) },
  { name: 'GET 按空间列出，文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/documents?spaceId=${w.outsider.personalSpaceId}&folderId=${pick(h, w.teamFolder)}`) },
  { name: 'GET 列出文件夹，父文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/folders?spaceId=${w.outsider.personalSpaceId}&parentId=${pick(h, w.teamFolder)}`) },
  { name: 'POST 新建文件夹，父文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, '/api/folders', 'POST', { spaceId: w.outsider.personalSpaceId, parentId: pick(h, w.teamFolder), name: '新的', requestId: randomUUID() }) },
  { name: 'PATCH 自己的文件夹换到看不到的父文件夹', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${w.outsiderFolder}`, 'PATCH', { parentId: pick(h, w.teamFolder) }) },
  { name: 'POST 自己的文件夹移动，目标文件夹在看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${w.outsiderFolder}/move`, 'POST', { spaceId: w.outsider.personalSpaceId, folderId: pick(h, w.teamFolder) }) },
  { name: 'POST 自己的文件夹移到看不到的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${w.outsiderFolder}/move`, 'POST', { spaceId: pick(h, w.team) }) },
  // ---- 空间与成员 ----
  { name: 'GET 按空间列出文档', actor: 'outsider', request: async (s, h) => call(s, `/api/documents?spaceId=${pick(h, w.team)}`) },
  { name: 'GET 按空间列出文档（个人空间）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents?spaceId=${pick(h, w.owner.personalSpaceId)}`) },
  { name: 'POST 新建文档到看不到的空间', actor: 'outsider', request: async (s, h) => call(s, '/api/documents', 'POST', { type: 'sheet', requestId: randomUUID(), spaceId: pick(h, w.team) }) },
  { name: 'GET 空间页头', actor: 'outsider', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}`) },
  { name: 'PUT 空间改名', actor: 'outsider', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}/name`, 'PUT', { name: '改名' }) },
  { name: 'GET 成员', actor: 'outsider', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}/members`) },
  { name: 'POST 添加成员', actor: 'outsider', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}/members`, 'POST', { userId: w.outsider.id, role: 'viewer' }) },
  { name: 'PUT 调整角色', actor: 'outsider', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}/members/${w.admin.id}`, 'PUT', { role: 'viewer' }) },
  { name: 'DELETE 移出成员', actor: 'outsider', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}/members/${w.admin.id}`, 'DELETE') },
  // ---- 文件夹 ----
  { name: 'GET 列出文件夹', actor: 'outsider', request: async (s, h) => call(s, `/api/folders?spaceId=${pick(h, w.team)}`) },
  { name: 'POST 新建文件夹', actor: 'outsider', request: async (s, h) => call(s, '/api/folders', 'POST', { spaceId: pick(h, w.team), name: '新的', requestId: randomUUID() }) },
  { name: 'PATCH 文件夹改名', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${pick(h, w.teamFolder)}`, 'PATCH', { name: '改名' }) },
  { name: 'PATCH 文件夹移到根目录', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${pick(h, w.teamFolder)}`, 'PATCH', { parentId: null }) },
  { name: 'POST 文件夹移到自己的空间', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${pick(h, w.teamFolder)}/move`, 'POST', { spaceId: w.outsider.personalSpaceId }) },
  { name: 'DELETE 文件夹', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${pick(h, w.teamFolder)}`, 'DELETE') },
  { name: 'DELETE 个人空间的文件夹', actor: 'outsider', request: async (s, h) => call(s, `/api/folders/${pick(h, w.personalFolder)}`, 'DELETE') },
  // ---- 回收站 ----
  { name: 'GET 回收站', actor: 'outsider', request: async (s, h) => call(s, `/api/trash?spaceId=${pick(h, w.team)}`) },
  { name: 'GET 回收站（个人空间）', actor: 'outsider', request: async (s, h) => call(s, `/api/trash?spaceId=${pick(h, w.owner.personalSpaceId)}`) },
  { name: 'POST 恢复', actor: 'outsider', request: async (s, h) => call(s, `/api/trash/${pick(h, w.teamTrashEntry)}/restore`, 'POST') },
  { name: 'DELETE 永久删除', actor: 'outsider', request: async (s, h) => call(s, `/api/trash/${pick(h, w.teamTrashEntry)}`, 'DELETE') },
  { name: 'POST 恢复（个人空间）', actor: 'outsider', request: async (s, h) => call(s, `/api/trash/${pick(h, w.personalTrashEntry)}/restore`, 'POST') },
  { name: 'DELETE 永久删除（个人空间）', actor: 'outsider', request: async (s, h) => call(s, `/api/trash/${pick(h, w.personalTrashEntry)}`, 'DELETE') },
  // ---- 没有加入的系统管理员：团队空间的内容、个人空间的一切 ----
  { name: '系统管理员 GET 团队空间的文档', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}`) },
  { name: '系统管理员 GET 团队空间的内容', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/content`) },
  { name: '系统管理员 GET 团队空间页头', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}`) },
  { name: '系统管理员 GET 团队空间的文件夹', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/folders?spaceId=${pick(h, w.team)}`) },
  { name: '系统管理员 GET 团队空间的回收站', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/trash?spaceId=${pick(h, w.team)}`) },
  { name: '系统管理员 POST 恢复团队空间的删除单元', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/trash/${pick(h, w.teamTrashEntry)}/restore`, 'POST') },
  { name: '系统管理员 PATCH 团队空间的文件夹', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/folders/${pick(h, w.teamFolder)}`, 'PATCH', { name: '改名' }) },
  { name: '系统管理员 POST 新建文档到团队空间', actor: 'systemAdmin', request: async (s, h) => call(s, '/api/documents', 'POST', { type: 'sheet', requestId: randomUUID(), spaceId: pick(h, w.team) }) },
  { name: '系统管理员 GET 个人空间的成员', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.owner.personalSpaceId)}/members`) },
  { name: '系统管理员 POST 把自己加进个人空间', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.owner.personalSpaceId)}/members`, 'POST', { userId: w.systemAdmin.id, role: 'viewer' }) },
  { name: '系统管理员 PUT 个人空间改名', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.owner.personalSpaceId)}/name`, 'PUT', { name: '改名' }) },
  { name: '系统管理员 PUT 个人空间全员可见', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/admin/spaces/${pick(h, w.owner.personalSpaceId)}/visibility`, 'PUT', { visibleToAll: true }) },
  { name: '系统管理员 POST 归档个人空间', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/admin/spaces/${pick(h, w.owner.personalSpaceId)}/archive`, 'POST') },
  { name: '系统管理员 转移到写成团队空间的个人空间', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/admin/users/${w.leaver.id}/documents/transfer`, 'POST', { documentIds: [w.leaver.document], target: { type: 'team', spaceId: pick(h, w.owner.personalSpaceId) } }) },
]

describe('看不到与不存在完全一致：响应、响应头与语句序列（ADR-014，M2-P6 复核 S2）', () => {
  it.each(PROBES)('$name（$actor）', async (probe) => {
    const session = w.sessions[probe.actor]
    // 先发一次热身：会话的顺延等与目标无关的语句不落在比较里（顺延按分钟算，比较的三次紧挨着发）
    await probe.request(session, false)
    const hidden = await observe(async () => probe.request(session, true))
    const absent = await observe(async () => probe.request(session, false))
    const hiddenAgain = await observe(async () => probe.request(session, true))
    expect(hidden.status).toBe(404)
    expect(absent).toEqual(hidden)
    // 同一个请求再发一次，语句序列稳定：比较是有意义的
    expect(hiddenAgain.statements).toEqual(hidden.statements)
    expect(hidden.statements.length).toBeGreaterThan(0)
  })
})

// 看不到与不存在完全一致（ADR-014；M2-P6 复核 S2，两位审查者的逐条比较合在一起）：带 id 的每一个接口，
// 对"看不到"的对象与"不存在"的对象发同样的请求，比较状态码、错误体（去掉请求标识）、非易变的响应头，
// 以及应用在这个请求里对数据库发出的语句序列（语句文本，按顺序）。语句序列相同，执行路径就相同，耗时没有可以分辨的差别。
// 权限矩阵的 404 格只比较响应；这里另外守着"不存在时也照样查一次"（文件夹、删除单元不存在时用全零的空间判断一次权限）。
// M2-P5 加了分享的三个带 id 的接口（先判断文档：看不到的文档加不存在的被授权人同样 404），以及"只凭授权的人"对所在空间的
// 空间级接口（授权不给空间里的任何东西开口子：与不存在的空间执行同样的语句，documents/grants.test.ts 另核对了响应）。
// S4 起两个只凭授权的人（只有查看授权的、只有编辑授权的）都是发请求的人：他们知道分享给自己的文档在哪个空间，
// 拿同一个空间里没分享给他们的文档、文件夹、删除单元去试，取消了分享的文档、进了回收站的有授权的文档，都与不存在的一模一样。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { ComparableResponse } from '../support/comparable-response.ts'
import type { TestDatabase } from '../support/database.ts'
import type { Route } from '../support/routes.ts'
import type { LoggedIn } from '../support/session-client.ts'
import type { StatementCapture } from '../support/statement-capture.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { EDIT_LEASE_HEADER, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, clientFormatQuery, renewBody } from '../support/client-format.ts'
import { comparableOf } from '../support/comparable-response.ts'
import { conflictCopyPath, pageSnapshot } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { grantsOn, removeGrant, setGrants } from '../support/grants.ts'
import { matchesRoute, pathParameters, routesOf } from '../support/routes.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'
import { captureStatements } from '../support/statement-capture.ts'

/**
 * 发请求的人：外人（与团队空间、别人的个人空间都没有关系）、团队空间的空间管理员、没有加入的系统管理员，
 * 以及两个只凭授权的人（M2-P5）：都不是团队空间的成员，teamDocument 上一个有查看授权、一个有编辑授权；
 * 只有查看授权的人另在 owner 个人空间里的 personalDocument 上有查看授权
 */
type ActorName = 'outsider' | 'admin' | 'systemAdmin' | 'grantViewer' | 'grantEditor'

interface World {
  readonly owner: TestAccount
  readonly admin: TestAccount
  readonly outsider: TestAccount
  readonly systemAdmin: TestAccount
  /** 只有查看授权的人：teamDocument 与 personalDocument 上的查看授权 */
  readonly grantViewer: TestAccount
  /** 只有编辑授权的人：teamDocument 上的编辑授权 */
  readonly grantEditor: TestAccount
  readonly sessions: Readonly<Record<ActorName, LoggedIn>>
  /** 团队空间：空间管理员是 admin，外人与系统管理员都看不到 */
  readonly team: string
  readonly teamDocument: { readonly id: string, readonly unitId: string }
  /** 团队空间里另一份文档：没有分享给任何人——两个只凭授权的人拿它试探 */
  readonly teamOtherDocument: { readonly id: string, readonly unitId: string }
  /** 团队空间里分享给只有查看授权的人、又取消了的文档 */
  readonly revokedDocument: string
  readonly teamFolder: string
  readonly teamTrashEntry: string
  /** 团队空间回收站里的那份文档：对空间管理员自己也"不存在"；两个只凭授权的人在它上面有授权，同样"不存在" */
  readonly teamTrashedDocument: string
  /** owner 的个人空间里的文档、文件夹与删除单元：别人一概看不到（personalDocument 分享给了只有查看授权的人） */
  readonly personalDocument: { readonly id: string, readonly unitId: string }
  /** owner 的个人空间里另一份文档：没有分享给任何人 */
  readonly personalOtherDocument: string
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
  const grantViewer = await createAccount(database, { username: 'parity-grant-viewer' })
  const grantEditor = await createAccount(database, { username: 'parity-grant-editor' })
  const sessions = {
    owner: await login(app.baseUrl, owner.username, owner.password),
    admin: await login(app.baseUrl, admin.username, admin.password),
    outsider: await login(app.baseUrl, outsider.username, outsider.password),
    systemAdmin: await login(app.baseUrl, systemAdmin.username, systemAdmin.password),
    grantViewer: await login(app.baseUrl, grantViewer.username, grantViewer.password),
    grantEditor: await login(app.baseUrl, grantEditor.username, grantEditor.password),
  }
  const team = await createTeamSpace(database, { name: '一致：团队', createdBy: systemAdmin.id, members: { [admin.id]: 'admin' } })
  const teamDocument = await seedDocument(database, { spaceId: team, createdBy: admin.id, title: '团队里的文档' })
  const teamOtherDocument = await seedDocument(database, { spaceId: team, createdBy: admin.id, title: '团队里没分享的文档' })
  const revokedDocument = (await seedDocument(database, { spaceId: team, createdBy: admin.id, title: '取消了分享的文档' })).id
  const teamTrashedDocument = (await seedDocument(database, { spaceId: team, createdBy: admin.id, title: '团队里删掉的' })).id
  const personalDocument = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '个人空间里的文档' })
  const personalOtherDocument = (await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '个人空间里没分享的' })).id
  const personalTrashed = (await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '个人空间里删掉的' })).id
  await setGrants(database, [
    { documentId: teamDocument.id, userId: grantViewer.id, role: 'viewer', grantedBy: admin.id },
    { documentId: teamDocument.id, userId: grantEditor.id, role: 'editor', grantedBy: admin.id },
    { documentId: revokedDocument, userId: grantViewer.id, role: 'viewer', grantedBy: admin.id },
    // 进回收站之前分享给了两个人：授权跟着文档走，文档在回收站里时对普通接口不存在
    { documentId: teamTrashedDocument, userId: grantViewer.id, role: 'viewer', grantedBy: admin.id },
    { documentId: teamTrashedDocument, userId: grantEditor.id, role: 'editor', grantedBy: admin.id },
    { documentId: personalDocument.id, userId: grantViewer.id, role: 'viewer', grantedBy: owner.id },
  ])
  await removeGrant(database, revokedDocument, grantViewer.id)
  const leaver = await createPassiveAccount(database, { username: 'parity-leaver', status: 'disabled' })
  w = {
    owner,
    admin,
    outsider,
    systemAdmin,
    grantViewer,
    grantEditor,
    sessions: { outsider: sessions.outsider, admin: sessions.admin, systemAdmin: sessions.systemAdmin, grantViewer: sessions.grantViewer, grantEditor: sessions.grantEditor },
    team,
    teamDocument,
    teamOtherDocument,
    revokedDocument,
    teamFolder: await createFolder(sessions.admin, team, '团队里的文件夹'),
    teamTrashEntry: await trashed(sessions.admin, teamTrashedDocument),
    teamTrashedDocument,
    personalDocument,
    personalOtherDocument,
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

/**
 * 只记下请求（"方法 路径"）、不发出去：核对这份清单覆盖了哪些接口时用（见文件末尾，M2-P6 第 6 片复核 S5）。
 * 发请求的两个函数（call、save）都先看它
 */
let recording: string[] | undefined

function recorded(method: string, path: string): Response | undefined {
  if (recording === undefined)
    return undefined
  recording.push(`${method} ${path}`)
  return new Response(null, { status: 204 })
}

async function call(session: LoggedIn, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<Response> {
  return recorded(method, path) ?? asUser(app.baseUrl, session, path, { method, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) })
}

/** 编辑权的心跳与释放带的令牌（M3-P1）：格式合法的一个，判断访问在租约之前，带不带、对不对都一样 404 */
const LEASE_TOKEN = { [EDIT_LEASE_HEADER]: `${'a'.repeat(41)}-_` }

/** 不存在的对象：每次一个新的 id */
const missing = (): string => randomUUID()
/** 看不到的对象或不存在的对象 */
const pick = (hidden: boolean, id: string): string => (hidden ? id : missing())

/**
 * 保存：带上格式合法的令牌与代次（M3-P1 起保存要求编辑租约，writeEpoch 必填）与现在的页面的构建与数据格式（M3-P3），请求本身合法、
 * 只看访问的判断；不先申请（看不到的人也申请不了），要比较的语句只有保存这一个请求的。判断访问在租约之前，看不到与不存在一样 404；
 * 事务之外的重放预检（M3-P3：按新的 requestId 查修订记录与回执，都查不到）、格式的核对与快照的检查（与文档无关）两边一样
 */
async function save(session: LoggedIn, documentId: string, unitId: string): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1', writeEpoch: '1', ...clientFormatQuery() })
  const path = `/api/documents/${documentId}/content?${query.toString()}`
  return recorded('PUT', path) ?? asUser(app.baseUrl, session, path, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(Buffer.from(sheetSnapshotFor(unitId), 'utf8')) },
    headers: LEASE_TOKEN,
  })
}

/**
 * 另存为副本（M3-P2）：格式合法的请求（快照的顶层 id 是那份文档的 unitId，标题与 requestId 合法），只看访问的判断；
 * 读不到原文档在 unitId 与放在哪里之前，看不到与不存在一样 404。不存在的那份用随机的 unitId
 */
async function conflictCopy(session: LoggedIn, documentId: string, unitId: string): Promise<Response> {
  const path = conflictCopyPath(documentId)
  return recorded('POST', path) ?? asUser(app.baseUrl, session, path, {
    method: 'POST',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(pageSnapshot(unitId)) },
  })
}

/** 读取内容的条件请求（M3-P2）：带着对得上的修订号（新建的文档都是 1）或 *，权限照样先判断 */
const IF_NONE_MATCH = (value: string): Record<string, string> => ({ 'if-none-match': value })

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
  // ---- 分享（M2-P5 设计 §3.2、§3.6）：先判断文档，看不到的文档不论被授权人是谁、存不存在都与不存在的文档相同 ----
  { name: 'GET 授权列表', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/grants`) },
  { name: 'GET 个人空间文档的授权列表', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}/grants`) },
  { name: 'PUT 设置授权（被授权人不存在）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/grants/${missing()}`, 'PUT', { role: 'viewer' }) },
  { name: 'PUT 设置授权（被授权人是有效账户）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/grants/${w.admin.id}`, 'PUT', { role: 'editor' }) },
  { name: 'PUT 设置授权（给自己）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}/grants/${w.outsider.id}`, 'PUT', { role: 'editor' }) },
  { name: 'DELETE 取消授权', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/grants/${w.grantEditor.id}`, 'DELETE') },
  { name: 'DELETE 取消授权（被授权人不存在）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}/grants/${missing()}`, 'DELETE') },
  { name: 'GET 回收站里的文档的授权列表（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/grants`) },
  { name: 'PUT 给回收站里的文档设置授权（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/grants/${w.outsider.id}`, 'PUT', { role: 'viewer' }) },
  { name: 'DELETE 取消回收站里的文档的授权（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/grants/${w.outsider.id}`, 'DELETE') },
  { name: '系统管理员 PUT 团队空间文档的授权', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/grants/${w.outsider.id}`, 'PUT', { role: 'viewer' }) },
  // ---- 只凭授权的人对所在空间的空间级接口（M2-P5 设计 §3.4(1)、§3.6）：授权不给空间里的任何东西开口子 ----
  { name: '只凭授权 GET 空间页头', actor: 'grantEditor', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}`) },
  { name: '只凭授权 GET 按空间列出文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents?spaceId=${pick(h, w.team)}`) },
  { name: '只凭授权 GET 列出文件夹', actor: 'grantEditor', request: async (s, h) => call(s, `/api/folders?spaceId=${pick(h, w.team)}`) },
  { name: '只凭授权 GET 回收站', actor: 'grantEditor', request: async (s, h) => call(s, `/api/trash?spaceId=${pick(h, w.team)}`) },
  { name: '只凭授权 GET 成员', actor: 'grantEditor', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.team)}/members`) },
  { name: '只凭授权 GET 按文件夹列出文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents?spaceId=${w.grantEditor.personalSpaceId}&folderId=${pick(h, w.teamFolder)}`) },
  { name: '只凭授权 POST 新建文档到所在的空间', actor: 'grantEditor', request: async (s, h) => call(s, '/api/documents', 'POST', { type: 'sheet', requestId: randomUUID(), spaceId: pick(h, w.team) }) },
  { name: '只凭授权 POST 新建文件夹到所在的空间', actor: 'grantEditor', request: async (s, h) => call(s, '/api/folders', 'POST', { spaceId: pick(h, w.team), name: '新的', requestId: randomUUID() }) },
  { name: '只凭授权 PATCH 所在空间的文件夹', actor: 'grantEditor', request: async (s, h) => call(s, `/api/folders/${pick(h, w.teamFolder)}`, 'PATCH', { name: '改名' }) },
  { name: '只凭授权 POST 恢复所在空间的删除单元', actor: 'grantEditor', request: async (s, h) => call(s, `/api/trash/${pick(h, w.teamTrashEntry)}/restore`, 'POST') },
  { name: '只凭授权 POST 新建文档，文件夹在所在的空间', actor: 'grantEditor', request: async (s, h) => call(s, '/api/documents', 'POST', { type: 'sheet', requestId: randomUUID(), spaceId: w.grantEditor.personalSpaceId, folderId: pick(h, w.teamFolder) }) },
  { name: '只有查看授权 GET 空间页头（个人空间里的授权）', actor: 'grantViewer', request: async (s, h) => call(s, `/api/spaces/${pick(h, w.owner.personalSpaceId)}`) },
  { name: '只有查看授权 GET 按空间列出（个人空间里的授权）', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents?spaceId=${pick(h, w.owner.personalSpaceId)}`) },
  { name: '只有查看授权 GET 回收站（个人空间里的授权）', actor: 'grantViewer', request: async (s, h) => call(s, `/api/trash?spaceId=${pick(h, w.owner.personalSpaceId)}`) },
  { name: '只有查看授权 DELETE 个人空间的文件夹', actor: 'grantViewer', request: async (s, h) => call(s, `/api/folders/${pick(h, w.personalFolder)}`, 'DELETE') },
  // ---- 只凭授权的人对同一个空间里没分享给他的文档（S4）：知道空间、猜得到 id，也与不存在的一模一样 ----
  { name: '只有查看授权 GET 没分享的文档', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}`) },
  { name: '只有查看授权 GET 没分享的文档的内容', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/content`) },
  { name: '只有查看授权 GET 没分享的文档的授权列表', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/grants`) },
  { name: '只有查看授权 GET 个人空间里没分享的文档', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalOtherDocument)}`) },
  { name: '只有编辑授权 PUT 保存没分享的文档', actor: 'grantEditor', request: async (s, h) => save(s, pick(h, w.teamOtherDocument.id), h ? w.teamOtherDocument.unitId : randomUUID()) },
  { name: '只有编辑授权 PATCH 改名没分享的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}`, 'PATCH', { title: '新标题' }) },
  { name: '只有编辑授权 PATCH 移动没分享的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}`, 'PATCH', { folderId: null }) },
  { name: '只有编辑授权 POST 移动没分享的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/move`, 'POST', { spaceId: w.grantEditor.personalSpaceId }) },
  { name: '只有编辑授权 POST 复制没分享的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/copy`, 'POST', { spaceId: w.grantEditor.personalSpaceId, requestId: randomUUID() }) },
  { name: '只有编辑授权 DELETE 没分享的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}`, 'DELETE') },
  { name: '只有编辑授权 PUT 给没分享的文档设置授权', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/grants/${w.grantViewer.id}`, 'PUT', { role: 'viewer' }) },
  { name: '只有编辑授权 DELETE 取消没分享的文档上的授权', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/grants/${w.grantViewer.id}`, 'DELETE') },
  // ---- 授权没了或者文档进了回收站（S4）：取消了的分享与不存在一样；有授权的文档进了回收站，对被授权的人也不存在 ----
  { name: '只有查看授权 GET 取消了分享的文档', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.revokedDocument)}`) },
  { name: '只有查看授权 GET 取消了分享的文档的内容', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.revokedDocument)}/content`) },
  { name: '只有编辑授权 GET 回收站里有授权的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}`) },
  { name: '只有编辑授权 PATCH 改名回收站里有授权的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}`, 'PATCH', { title: '新标题' }) },
  { name: '只有查看授权 POST 复制回收站里有授权的文档', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/copy`, 'POST', { spaceId: w.grantViewer.personalSpaceId, requestId: randomUUID() }) },
  // ---- 编辑权（M3-P1 设计 §3.2、§3.5）：先判断访问与编辑权，看不到的文档与不存在的一样，不读租约、不取任何锁 ----
  { name: 'GET 编辑状态', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/edit-lease`) },
  { name: 'POST 申请编辑权', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/edit-lease`, 'POST', acquireBody(randomUUID())) },
  { name: 'PUT 续租', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/edit-lease`, 'PUT', renewBody(0), LEASE_TOKEN) },
  { name: 'DELETE 释放', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/edit-lease`, 'DELETE', undefined, LEASE_TOKEN) },
  { name: 'POST 申请个人空间文档的编辑权', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}/edit-lease`, 'POST', acquireBody(randomUUID())) },
  { name: 'GET 回收站里的文档的编辑状态（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/edit-lease`) },
  { name: 'POST 申请回收站里的文档的编辑权（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/edit-lease`, 'POST', acquireBody(randomUUID())) },
  { name: 'PUT 续租回收站里的文档（空间管理员自己）', actor: 'admin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamTrashedDocument)}/edit-lease`, 'PUT', renewBody(0), LEASE_TOKEN) },
  { name: '系统管理员 POST 申请团队空间文档的编辑权', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/edit-lease`, 'POST', acquireBody(randomUUID())) },
  { name: '只有编辑授权 POST 申请没分享的文档的编辑权', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/edit-lease`, 'POST', acquireBody(randomUUID())) },
  { name: '只有编辑授权 DELETE 释放没分享的文档', actor: 'grantEditor', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/edit-lease`, 'DELETE', undefined, LEASE_TOKEN) },
  { name: '只有查看授权 GET 没分享的文档的编辑状态', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamOtherDocument.id)}/edit-lease`) },
  // ---- 另存为副本与读取的条件请求（M3-P2 设计 §3.2、§3.6）：只要求能读原文档，读不到的与不存在的一样；304 之前照样判断权限 ----
  { name: 'POST 另存为副本', actor: 'outsider', request: async (s, h) => conflictCopy(s, pick(h, w.teamDocument.id), h ? w.teamDocument.unitId : randomUUID()) },
  { name: 'POST 另存为副本（个人空间的文档）', actor: 'outsider', request: async (s, h) => conflictCopy(s, pick(h, w.personalDocument.id), h ? w.personalDocument.unitId : randomUUID()) },
  { name: 'POST 另存为副本（回收站里的文档，空间管理员自己）', actor: 'admin', request: async (s, h) => conflictCopy(s, pick(h, w.teamTrashedDocument), randomUUID()) },
  { name: '系统管理员 POST 另存为副本（团队空间的文档）', actor: 'systemAdmin', request: async (s, h) => conflictCopy(s, pick(h, w.teamDocument.id), h ? w.teamDocument.unitId : randomUUID()) },
  { name: '只有查看授权 POST 另存为副本（没分享的文档）', actor: 'grantViewer', request: async (s, h) => conflictCopy(s, pick(h, w.teamOtherDocument.id), h ? w.teamOtherDocument.unitId : randomUUID()) },
  { name: '只有查看授权 POST 另存为副本（取消了分享的文档）', actor: 'grantViewer', request: async (s, h) => conflictCopy(s, pick(h, w.revokedDocument), randomUUID()) },
  { name: 'GET 文档内容（条件请求，修订号对得上）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.teamDocument.id)}/content`, 'GET', undefined, IF_NONE_MATCH('"1"')) },
  { name: 'GET 文档内容（条件请求，*）', actor: 'outsider', request: async (s, h) => call(s, `/api/documents/${pick(h, w.personalDocument.id)}/content`, 'GET', undefined, IF_NONE_MATCH('*')) },
  { name: '只有查看授权 GET 取消了分享的文档的内容（条件请求）', actor: 'grantViewer', request: async (s, h) => call(s, `/api/documents/${pick(h, w.revokedDocument)}/content`, 'GET', undefined, IF_NONE_MATCH('"1"')) },
  // 路由表的覆盖核对发现的（M2-P6 第 6 片复核 S5）：恢复与归档成对，原来漏了
  { name: '系统管理员 POST 恢复个人空间', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/admin/spaces/${pick(h, w.owner.personalSpaceId)}/restore`, 'POST') },
  { name: '系统管理员 转移到写成团队空间的个人空间', actor: 'systemAdmin', request: async (s, h) => call(s, `/api/admin/users/${w.leaver.id}/documents/transfer`, 'POST', { documentIds: [w.leaver.document], target: { type: 'team', spaceId: pick(h, w.owner.personalSpaceId) } }) },
]

describe('前提：两个只凭授权的人的授权确实生效（不然他们的探测与外人的没有区别）', () => {
  it('分享给他们的文档打得开，途径是 grant；只有查看授权的人也打得开个人空间里分享给他的那一份；取消了的那一份库里确实没有授权', async () => {
    for (const [actor, documentId] of [['grantViewer', w.teamDocument.id], ['grantEditor', w.teamDocument.id], ['grantViewer', w.personalDocument.id]] as const) {
      const response = await asUser(app.baseUrl, w.sessions[actor], `/api/documents/${documentId}`)
      expect(response.status, `${actor} ${documentId}`).toBe(200)
      expect((await response.json() as { accessVia: string }).accessVia).toBe('grant')
    }
    expect(await grantsOn(database, [w.revokedDocument])).toEqual([])
    expect((await grantsOn(database, [w.teamTrashedDocument])).map(grant => grant.userId).toSorted()).toEqual([w.grantViewer.id, w.grantEditor.id].toSorted())
  })
})

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

/**
 * 路径里带 id 的接口里，不在上面清单里的：都是只给系统管理员的管理接口，系统管理员看得到全部账户与邀请（停用的、作废的也在），
 * 没有"看不到"的对象，别人一律 403（与对象存不存在无关，management-matrix 的反向用例）；不存在的 id 回 404 由各自的集成测试核对
 */
const NO_HIDDEN_OBJECTS = '只给系统管理员：系统管理员看得到全部账户与邀请，没有"看不到"的对象；别人一律 403，与对象存不存在无关'
const EXEMPT: Readonly<Record<string, string>> = {
  'POST /api/admin/invitations/:id/reissue': NO_HIDDEN_OBJECTS,
  'POST /api/admin/invitations/:id/revoke': NO_HIDDEN_OBJECTS,
  'GET /api/admin/users/:id': NO_HIDDEN_OBJECTS,
  'POST /api/admin/users/:id/disable': NO_HIDDEN_OBJECTS,
  'GET /api/admin/users/:id/documents': NO_HIDDEN_OBJECTS,
  'POST /api/admin/users/:id/enable': NO_HIDDEN_OBJECTS,
  'POST /api/admin/users/:id/password-reset': NO_HIDDEN_OBJECTS,
  'PUT /api/admin/users/:id/system-role': NO_HIDDEN_OBJECTS,
  'POST /api/admin/users/:id/unlock-login': NO_HIDDEN_OBJECTS,
}

describe('路径里带 id 的每个接口都在上面的清单里，或者明确豁免（M2-P6 第 6 片复核 S5）', () => {
  it('接口从应用的路由表列出（不手写）：清单发出的请求逐个对上路由表；没对上的带 id 的接口都写明豁免的原因，豁免的不在清单里', async () => {
    const routes = routesOf(app)
    const requests = await probeRequests()
    const name = (route: Route): string => `${route.method} ${route.path}`
    // 清单里的请求都是真实的接口（写错路径的探测会被这里发现）
    expect(requests.filter(request => !routes.some(route => matchesRoute(route, ...splitRequest(request))))).toEqual([])
    const withIds = routes.filter(route => pathParameters(route).length > 0)
    const covered = new Set(withIds.filter(route => requests.some(request => matchesRoute(route, ...splitRequest(request)))).map(name))
    expect(withIds.map(name).filter(route => !covered.has(route) && EXEMPT[route] === undefined), '既不在清单里、也没有写明豁免的带 id 的接口').toEqual([])
    expect(Object.keys(EXEMPT).filter(route => covered.has(route) || !withIds.some(item => name(item) === route)), '豁免的接口已经在清单里，或者已经不在路由表里').toEqual([])
  })
})

/** 清单里每个探测发出的请求（"方法 路径"）：只记下，不发出去 */
async function probeRequests(): Promise<string[]> {
  const requests: string[] = []
  recording = requests
  try {
    for (const probe of PROBES)
      await probe.request(w.sessions[probe.actor], true)
  }
  finally {
    recording = undefined
  }
  return requests
}

/** "方法 路径" 拆成两段 */
function splitRequest(request: string): [method: string, path: string] {
  const [method = '', path = ''] = request.split(' ')
  return [method, path]
}

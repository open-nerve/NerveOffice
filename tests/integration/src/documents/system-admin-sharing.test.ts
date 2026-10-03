// 系统管理员被单独分享（需求方 2026-10-02 的决定，00 号计划书 r12、ADR-014）：所有者或空间管理员可以像对别的同事一样，
// 把一份文档单独分享给系统管理员——团队空间里的（他不是成员）与个人空间里的都可以，靠的是对方的主动分享，不是系统角色：
// - 凭授权能读，编辑授权能保存，出现在他的"与我共享"里；看不到所在空间的目录结构（空间页头、按空间列出、文件夹、回收站与不存在的
//   空间一样 404，详情不带文件夹）；
// - 系统角色本身不给内容权限：同一个空间里没分享给他的文档照旧 404，与不存在相同，搜索里也没有；
// - 分享记审计（documents.shared：操作者是分享的人，目标是文档，明细是被授权人与角色）。
// 实现本来就允许（授权与系统角色无关，access-rules 的 documentAccessOf）；审查 A 的探针记下了现状，这里把需求方的决定钉住。
import type { DocumentDetail } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createdFolderSchema, documentDetailSchema, documentGrantSchema, errorResponseSchema, searchResponseSchema, sharedListResponseSchema, SHEET_TEMPLATE, userDirectoryResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { grantsOn } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员：不是任何团队空间的成员 */
let admin: TestAccount
/** 团队空间的空间管理员，也是自己个人空间的所有者 */
let amy: TestAccount
let adminSession: LoggedIn
let amySession: LoggedIn
let worlds = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  admin = await createAccount(database, { username: 'sys-admin', displayName: '系统管理员', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  adminSession = await login(app.baseUrl, admin.username, admin.password)
  amySession = await login(app.baseUrl, amy.username, amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/**
 * 每条用例自己的一批：团队空间（系统管理员建的，艾米是空间管理员，他不是成员）里文件夹中的一份与根目录下的一份；艾米个人空间里的两份。
 * 标题都带这一批自己的记号（tag）：搜索按它找，结果只有这一批里的
 */
interface SharedWorld {
  readonly tag: string
  readonly teamSpace: string
  readonly teamShared: SeededDocument
  readonly teamOther: SeededDocument
  readonly personalShared: SeededDocument
  readonly personalOther: SeededDocument
}

async function newWorld(): Promise<SharedWorld> {
  worlds += 1
  const tag = `批次${worlds}号`
  const teamSpace = await createTeamSpace(database, { name: `财务部 ${tag}`, createdBy: admin.id, members: { [amy.id]: 'admin' } })
  const folder = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId: teamSpace, name: '预算', requestId: randomUUID() } })
  expect(folder.status, await folder.clone().text()).toBe(201)
  const folderId = parseExact(createdFolderSchema, await folder.json()).id
  return {
    tag,
    teamSpace,
    teamShared: await seedDocument(database, { spaceId: teamSpace, createdBy: amy.id, title: `财务的预算 ${tag}`, folderId }),
    teamOther: await seedDocument(database, { spaceId: teamSpace, createdBy: amy.id, title: `财务的工资 ${tag}` }),
    personalShared: await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: `艾米的计划 ${tag}` }),
    personalOther: await seedDocument(database, { spaceId: amy.personalSpaceId, createdBy: amy.id, title: `艾米的日记 ${tag}` }),
  }
}

/** 艾米经接口把这份文档分享给系统管理员（团队空间里她是空间管理员，个人空间里她是所有者） */
async function shareWithAdmin(document: SeededDocument, role: 'viewer' | 'editor'): Promise<void> {
  const response = await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${admin.id}`, { method: 'PUT', body: { role } })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(parseExact(documentGrantSchema, await response.json())).toMatchObject({ user: { id: admin.id, username: admin.username }, role, status: 'active', grantedBy: { id: amy.id } })
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

interface SharingAudit { readonly action: string, readonly actorId: string, readonly details: unknown }

/** 这份文档上的分享审计，按发生的先后 */
async function sharingAudits(documentId: string): Promise<SharingAudit[]> {
  return database.query(async client => (await client.query<SharingAudit>(
    `SELECT action, actor_id AS "actorId", details FROM audit_events
     WHERE target_type = 'document' AND target_id = $1 AND action IN ('documents.shared', 'documents.share_changed', 'documents.share_revoked')
     ORDER BY occurred_at, id`,
    [documentId],
  )).rows)
}

describe('US-M2-10 系统管理员被单独分享（需求方 2026-10-02 的决定）：像别的同事一样，靠对方的分享，不是系统角色', () => {
  it('团队空间里的（他不是成员）与个人空间里的：分享之前看不到；经接口分享给他之后凭授权能读、编辑授权能保存，出现在"与我共享"里；记审计', async () => {
    const world = await newWorld()
    const shared = [world.teamShared, world.personalShared]
    // 前提：分享之前他看不到（系统角色不给内容权限）
    for (const document of shared)
      expect((await open(adminSession, document.id)).status, document.id).toBe(404)
    // 同事选择里列得出他：分享的界面选得到
    const directory = parseExact(userDirectoryResponseSchema, await (await asUser(app.baseUrl, amySession, `/api/users?query=${admin.username}`)).json())
    expect(directory.items.map(item => item.id)).toContain(admin.id)

    for (const document of shared)
      await shareWithAdmin(document, 'editor')
    expect((await grantsOn(database, shared.map(document => document.id))).map(grant => [grant.documentId, grant.userId, grant.role]).toSorted())
      .toEqual(shared.map(document => [document.id, admin.id, 'editor']).toSorted())

    // 凭授权能读：途径是 grant，不带文件夹（团队空间里那一份在文件夹里），不能分享、移动、删除；内容读得到
    expect(await detailOf(adminSession, world.teamShared.id)).toMatchObject({
      spaceId: world.teamSpace,
      folderId: null,
      accessVia: 'grant',
      space: { id: world.teamSpace, type: 'team' },
      permissions: { canEdit: true, canRename: true, canCopy: true, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false, canShare: false },
    })
    // 个人空间：只给 id 与类型，不给存的名称（规范 §2.4）
    expect((await detailOf(adminSession, world.personalShared.id)).space).toEqual({ id: amy.personalSpaceId, type: 'personal' })
    for (const document of shared) {
      expect((await asUser(app.baseUrl, adminSession, `/api/documents/${document.id}/content`)).status, document.id).toBe(200)
      // 编辑授权能保存
      const saved = await save(adminSession, document, 1)
      expect(saved.status, await saved.clone().text()).toBe(200)
    }

    // "与我共享"：恰好是这两份，内容权限是编辑者；个人空间按所有者呈现
    const list = parseExact(sharedListResponseSchema, await (await asUser(app.baseUrl, adminSession, '/api/shared')).json())
    expect(list.items.map(item => item.id).toSorted()).toEqual(shared.map(document => document.id).toSorted())
    expect(list.items.map(item => item.contentRole)).toEqual(['editor', 'editor'])
    expect(list.items.find(item => item.id === world.personalShared.id)?.space).toEqual({ id: amy.personalSpaceId, type: 'personal', owner: { id: amy.id, username: amy.username, displayName: '艾米' } })

    // 分享记审计：操作者是分享的人（艾米），明细是被授权人与角色
    for (const document of shared)
      expect(await sharingAudits(document.id), document.id).toEqual([{ action: 'documents.shared', actorId: amy.id, details: { userId: admin.id, role: 'editor' } }])
  })

  it('查看授权只能读：保存 403；系统角色不把它抬成编辑者', async () => {
    const world = await newWorld()
    await shareWithAdmin(world.personalShared, 'viewer')
    expect(await detailOf(adminSession, world.personalShared.id)).toMatchObject({ accessVia: 'grant', permissions: { canEdit: false, canShare: false } })
    expect(await errorOf(await save(adminSession, world.personalShared, 1))).toEqual({ status: 403, code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
  })

  it('US-M2-14 看不到所在空间的目录结构：空间页头、按空间列出、文件夹、回收站都与不存在的空间逐字相同（404）', async () => {
    const world = await newWorld()
    await shareWithAdmin(world.teamShared, 'editor')
    await shareWithAdmin(world.personalShared, 'editor')
    // 前提：授权确实生效（他凭授权打得开），不然下面的 404 什么也证明不了
    for (const document of [world.teamShared, world.personalShared])
      expect((await detailOf(adminSession, document.id)).accessVia, document.id).toBe('grant')
    const missingSpace = randomUUID()
    const paths = (id: string): string[] => [`/api/spaces/${id}`, `/api/documents?spaceId=${id}`, `/api/folders?spaceId=${id}`, `/api/trash?spaceId=${id}`]
    for (const spaceId of [world.teamSpace, amy.personalSpaceId]) {
      for (const [index, path] of paths(spaceId).entries()) {
        const hidden = await asUser(app.baseUrl, adminSession, path)
        expect(hidden.status, path).toBe(404)
        expect(await errorOf(hidden), path).toEqual(await errorOf(await asUser(app.baseUrl, adminSession, paths(missingSpace)[index] ?? '')))
      }
    }
  })

  it('US-M2-14 系统角色本身不给内容权限：同一个空间里没分享给他的文档照旧 404，与不存在相同；搜索里只有分享给他的', async () => {
    const world = await newWorld()
    await shareWithAdmin(world.teamShared, 'editor')
    await shareWithAdmin(world.personalShared, 'viewer')
    const missing = await open(adminSession, randomUUID())
    const absent = await errorOf(missing)
    for (const document of [world.teamOther, world.personalOther]) {
      const hidden = await open(adminSession, document.id)
      expect(hidden.status, document.id).toBe(404)
      expect(await errorOf(hidden), document.id).toEqual(absent)
      expect((await asUser(app.baseUrl, adminSession, `/api/documents/${document.id}/content`)).status, document.id).toBe(404)
    }
    // 搜索：两半都要（能看到的空间与授权），他在这两个空间里都没有空间角色，只搜得到分享给他的那两份
    const found = parseExact(searchResponseSchema, await (await asUser(app.baseUrl, adminSession, `/api/search?query=${encodeURIComponent(world.tag)}`)).json())
    expect(found.items.map(item => item.id).toSorted()).toEqual([world.teamShared.id, world.personalShared.id].toSorted())
    expect(found.items.map(item => item.accessVia)).toEqual(['grant', 'grant'])
  })
})

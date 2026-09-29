// 团队空间的成员与空间角色（M2-P2 设计 §3.9，US-M2-06）：查看、添加、调整、移出，至少保留一个空间管理员，改名；
// 被移出的人下一次请求就看不到；归档之后空间管理员不能管理、系统管理员可以；审计；
// 并发（两个连接构造的交错）：同时降低自己、互相降级、添加时对方被停用、移出要等进行中的新建。
import type { SpaceMember, SpaceMemberListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { errorResponseSchema, spaceMemberListResponseSchema, spaceMemberSchema, teamSpaceSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument } from '../support/documents.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let benSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  cat = await createAccount(database, { username: 'cat', displayName: '凯特' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

let spaces = 0

/** 一个新的团队空间：艾米是空间管理员，另有给定的成员 */
async function teamSpace(members: Record<string, 'admin' | 'editor' | 'viewer'> = {}): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `成员测试 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', ...members } })
}

function membersPath(spaceId: string, userId?: string): string {
  return userId === undefined ? `/api/spaces/${spaceId}/members` : `/api/spaces/${spaceId}/members/${userId}`
}

async function add(user: LoggedIn, spaceId: string, userId: string, role: 'admin' | 'editor' | 'viewer' = 'viewer'): Promise<Response> {
  return asUser(app.baseUrl, user, membersPath(spaceId), { method: 'POST', body: { userId, role } })
}

async function changeRole(user: LoggedIn, spaceId: string, userId: string, role: 'admin' | 'editor' | 'viewer'): Promise<Response> {
  return asUser(app.baseUrl, user, membersPath(spaceId, userId), { method: 'PUT', body: { role } })
}

async function remove(user: LoggedIn, spaceId: string, userId: string): Promise<Response> {
  return asUser(app.baseUrl, user, membersPath(spaceId, userId), { method: 'DELETE' })
}

async function list(user: LoggedIn, spaceId: string): Promise<SpaceMemberListResponse> {
  const response = await asUser(app.baseUrl, user, membersPath(spaceId))
  expect(response.status).toBe(200)
  return parseExact(spaceMemberListResponseSchema, await response.json())
}

async function member(response: Response, status = 200): Promise<SpaceMember> {
  expect(response.status, await response.clone().text()).toBe(status)
  return parseExact(spaceMemberSchema, await response.json())
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function rolesOf(spaceId: string): Promise<Record<string, string>> {
  const rows = await database.query(async client => (await client.query<{ user_id: string, role: string }>('SELECT user_id, role FROM space_members WHERE space_id = $1', [spaceId])).rows)
  return Object.fromEntries(rows.map(row => [row.user_id, row.role]))
}

async function auditOf(spaceId: string) {
  return database.query(async client => (await client.query<{ action: string, actor_id: string | null, details: unknown }>(
    'SELECT action, actor_id, details FROM audit_events WHERE target_type = \'space\' AND target_id = $1 ORDER BY occurred_at, id',
    [spaceId],
  )).rows)
}

describe('US-M2-06 查看成员', () => {
  it('先按角色、再按显示名排序，带账户状态（停用的照样列出）；空间管理员能管理，其他成员只能看', async () => {
    const gone = await createPassiveAccount(database, { username: 'gone', displayName: '已离职', status: 'disabled' })
    const spaceId = await teamSpace({ [cat.id]: 'viewer', [ben.id]: 'editor', [gone.id]: 'viewer' })
    const byAdmin = await list(amySession, spaceId)
    expect(byAdmin.canManage).toBe(true)
    expect(byAdmin.space).toMatchObject({ id: spaceId, status: 'active', visibleToAll: false })
    expect(byAdmin.items.map(item => [item.user.displayName, item.role, item.status])).toEqual([
      ['艾米', 'admin', 'active'],
      ['本', 'editor', 'active'],
      ['凯特', 'viewer', 'active'],
      ['已离职', 'viewer', 'disabled'],
    ])
    expect((await list(benSession, spaceId)).canManage).toBe(false)
  })
})

describe('US-M2-06 添加成员', () => {
  it('按账户添加：对方随即在导航里看到这个空间；记审计（成员的 id 与角色）', async () => {
    const spaceId = await teamSpace()
    expect(await member(await add(amySession, spaceId, ben.id, 'editor'), 201)).toMatchObject({ user: { id: ben.id, username: 'ben', displayName: '本' }, status: 'active', role: 'editor' })
    const nav = await (await asUser(app.baseUrl, benSession, '/api/spaces')).json() as { items: { id: string, role: string }[] }
    expect(nav.items.find(item => item.id === spaceId)?.role).toBe('editor')
    expect((await auditOf(spaceId)).at(-1)).toEqual({ action: 'spaces.member_added', actor_id: amy.id, details: { userId: ben.id, role: 'editor' } })
  })

  it('已经是成员：409 ALREADY_MEMBER；不存在或已停用的账户：409 ACCOUNT_UNAVAILABLE', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'viewer' })
    const again = await add(amySession, spaceId, ben.id, 'editor')
    expect(again.status).toBe(409)
    expect((await errorOf(again)).code).toBe('ALREADY_MEMBER')
    const disabled = await createPassiveAccount(database, { username: 'disabled-one', status: 'disabled' })
    for (const userId of [disabled.id, randomUUID()]) {
      const response = await add(amySession, spaceId, userId)
      expect(response.status).toBe(409)
      expect((await errorOf(response)).code).toBe('ACCOUNT_UNAVAILABLE')
    }
    expect(await rolesOf(spaceId)).toEqual({ [amy.id]: 'admin', [ben.id]: 'viewer' })
  })

  it('添加时要添加的人正被停用：等停用提交，按停用之后的状态拒绝（409 ACCOUNT_UNAVAILABLE）', async () => {
    const spaceId = await teamSpace()
    const target = await createPassiveAccount(database, { username: 'being-disabled' })
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [target.id]),
      request: async () => add(amySession, spaceId, target.id),
      change: async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [target.id]),
    })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('ACCOUNT_UNAVAILABLE')
  })
})

describe('US-M2-06 调整角色', () => {
  it('调整之后立即按新角色生效；记审计（原角色与新角色）；角色没有变化时不记', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'viewer' })
    expect(await member(await changeRole(amySession, spaceId, ben.id, 'editor'))).toMatchObject({ role: 'editor' })
    const created = await asUser(app.baseUrl, benSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: randomUUID(), spaceId } })
    expect(created.status).toBe(201)
    await member(await changeRole(amySession, spaceId, ben.id, 'editor'))
    expect((await auditOf(spaceId)).filter(event => event.action === 'spaces.member_role_changed')).toEqual([
      { action: 'spaces.member_role_changed', actor_id: amy.id, details: { userId: ben.id, from: 'viewer', to: 'editor' } },
    ])
  })

  it('唯一的空间管理员降低自己：409 LAST_SPACE_ADMIN；有另一个空间管理员时可以，之后自己不能再管理', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'editor' })
    const last = await changeRole(amySession, spaceId, amy.id, 'editor')
    expect(last.status).toBe(409)
    expect((await errorOf(last)).code).toBe('LAST_SPACE_ADMIN')
    await member(await changeRole(amySession, spaceId, ben.id, 'admin'))
    await member(await changeRole(amySession, spaceId, amy.id, 'viewer'))
    const denied = await add(amySession, spaceId, cat.id)
    expect(denied.status).toBe(403)
    expect(await rolesOf(spaceId)).toEqual({ [amy.id]: 'viewer', [ben.id]: 'admin' })
  })

  it('不是成员：404，说明这个人不是空间的成员', async () => {
    const spaceId = await teamSpace()
    const response = await changeRole(amySession, spaceId, cat.id, 'editor')
    expect(response.status).toBe(404)
    expect((await errorOf(response)).message).toBe('这个人不是空间的成员')
  })

  it('两个空间管理员同时降低自己：一个成功，另一个 409 LAST_SPACE_ADMIN，空间仍有一个空间管理员', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'admin' })
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR NO KEY UPDATE', [spaceId]),
      request: async ({ step, waitForWaiting }) => {
        const first = step(changeRole(amySession, spaceId, amy.id, 'editor'))
        await waitForWaiting(1)
        const second = step(changeRole(benSession, spaceId, ben.id, 'editor'))
        return Promise.all([first, second])
      },
      change: async () => undefined,
      waiting: 2,
    })
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect(Object.values(await rolesOf(spaceId)).sort()).toEqual(['admin', 'editor'])
  })

  it('两个空间管理员同时降级对方：锁下再判断，后执行的一方已经不是空间管理员（403），只有一个成功', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'admin' })
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR NO KEY UPDATE', [spaceId]),
      request: async ({ step, waitForWaiting }) => {
        const first = step(changeRole(amySession, spaceId, ben.id, 'viewer'))
        await waitForWaiting(1)
        const second = step(changeRole(benSession, spaceId, amy.id, 'viewer'))
        return Promise.all([first, second])
      },
      change: async () => undefined,
      waiting: 2,
    })
    expect(responses.map(response => response.status).sort()).toEqual([200, 403])
    expect(Object.values(await rolesOf(spaceId)).sort()).toEqual(['admin', 'viewer'])
  })
})

describe('US-M2-06 移出', () => {
  it('移出之后，下一次请求就看不到这个空间与它的文档；记审计（成员的 id 与原角色）', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'editor' })
    const documentId = await createDocument(database, { spaceId, createdBy: ben.id, title: '本的文档' })
    expect((await asUser(app.baseUrl, benSession, `/api/documents/${documentId}`)).status).toBe(200)
    const response = await remove(amySession, spaceId, ben.id)
    expect(response.status).toBe(204)
    for (const path of [`/api/spaces/${spaceId}`, `/api/documents?spaceId=${spaceId}`, `/api/documents/${documentId}`, `/api/documents/${documentId}/content`])
      expect((await asUser(app.baseUrl, benSession, path)).status, path).toBe(404)
    expect((await auditOf(spaceId)).at(-1)).toEqual({ action: 'spaces.member_removed', actor_id: amy.id, details: { userId: ben.id, role: 'editor' } })
  })

  it('移出唯一的空间管理员：409 LAST_SPACE_ADMIN；移出不是成员的人：404', async () => {
    const spaceId = await teamSpace()
    const last = await remove(amySession, spaceId, amy.id)
    expect(last.status).toBe(409)
    expect((await errorOf(last)).code).toBe('LAST_SPACE_ADMIN')
    expect((await remove(amySession, spaceId, cat.id)).status).toBe(404)
  })

  it('移出要等进行中的新建（持着空间行的共享锁）：新建先提交，之后才移出', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'editor' })
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR SHARE', [spaceId]),
      request: async () => remove(amySession, spaceId, ben.id),
      change: async client => client.query(
        'INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version) VALUES ($1, \'sheet\', \'赶在移出之前\', $2, $3, \'sheet@1\', 1, \'1.0.1\')',
        [spaceId, ben.id, randomUUID()],
      ),
    })
    expect(response.status).toBe(204)
    expect(await rolesOf(spaceId)).toEqual({ [amy.id]: 'admin' })
  })
})

describe('US-M2-06 改名与归档', () => {
  it('空间管理员改名：导航里随即是新名称；记审计（原名称与新名称）；名称没有变化时不记；与别的团队空间同名：409', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'viewer' })
    const renamed = await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/name`, { method: 'PUT', body: { name: ' 新名字 ' } })
    expect(parseExact(teamSpaceSchema, await renamed.json())).toMatchObject({ id: spaceId, name: '新名字' })
    const nav = await (await asUser(app.baseUrl, benSession, '/api/spaces')).json() as { items: { id: string, name: string }[] }
    expect(nav.items.find(item => item.id === spaceId)?.name).toBe('新名字')
    await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/name`, { method: 'PUT', body: { name: '新名字' } })
    expect((await auditOf(spaceId)).filter(event => event.action === 'spaces.renamed').map(event => event.details)).toEqual([{ from: expect.stringMatching(/^成员测试/) as unknown, to: '新名字' }])

    const other = await teamSpace()
    const taken = await asUser(app.baseUrl, amySession, `/api/spaces/${other}/name`, { method: 'PUT', body: { name: '新名字' } })
    expect(taken.status).toBe(409)
    expect((await errorOf(taken)).code).toBe('SPACE_NAME_TAKEN')
  })

  it('归档之后：空间管理员不能管理成员与改名（403，说明空间已归档）；系统管理员照样能', async () => {
    const spaceId = await teamSpace()
    await setSpaceState(database, spaceId, { status: 'archived' })
    for (const response of [await add(amySession, spaceId, ben.id), await asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/name`, { method: 'PUT', body: { name: '归档后改名' } })]) {
      expect(response.status).toBe(403)
      expect(await errorOf(response)).toEqual({ code: 'PERMISSION_DENIED', message: '空间已归档，只能查看' })
    }
    expect((await add(rootSession, spaceId, ben.id)).status).toBe(201)
    expect((await list(amySession, spaceId)).canManage).toBe(false)
  })

  it('被取消系统管理员之后，不能再管理没有加入的团队空间（事务里复核系统角色）', async () => {
    const former = await createAccount(database, { username: 'former-admin', systemRole: 'admin' })
    const formerSession = await login(app.baseUrl, 'former-admin', former.password)
    const spaceId = await teamSpace()
    const response = await raceAgainstHeldLock(database, {
      // 持着 system-admins 的排他锁（取消系统管理员时取它）：管理成员的事务第一步复核系统角色，在这里等着
      hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:system-admins\', 0))'),
      request: async () => add(formerSession, spaceId, cat.id),
      change: async client => client.query('UPDATE users SET system_role = \'member\' WHERE id = $1', [former.id]),
    })
    // 复核之后按普通成员判断：他不是这个空间的成员，看不到
    expect(response.status).toBe(404)
    expect(await rolesOf(spaceId)).toEqual({ [amy.id]: 'admin' })
  })
})

// 团队空间（M2-P2 设计 §3.3、§3.9，US-M2-05）：系统管理员创建（连同首个空间管理员）、名称唯一、全员可见、归档与恢复；
// 我能看到的空间（导航）与空间页头；系统管理员没有加入就看不到内容，加入空间记审计；审计查询补上空间的名称；
// 未登录与无权限；归档与进行中的新建互斥（两个连接构造的交错）。逐格的权限见 permissions/management-matrix.test.ts。
import type { AdminSpace, SpaceView } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { adminSpaceListResponseSchema, adminSpaceSchema, auditEventListResponseSchema, CSRF_TOKEN_HEADER, errorResponseSchema, spaceListResponseSchema, spaceViewSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let benSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

async function createSpace(body: Record<string, unknown>, admin: LoggedIn = rootSession): Promise<Response> {
  return asUser(app.baseUrl, admin, '/api/admin/spaces', { method: 'POST', body: { visibleToAll: false, ...body } })
}

async function created(response: Response): Promise<AdminSpace> {
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(adminSpaceSchema, await response.json())
}

async function adminSpace(response: Response): Promise<AdminSpace> {
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(adminSpaceSchema, await response.json())
}

async function navOf(user: LoggedIn): Promise<SpaceView[]> {
  const response = await asUser(app.baseUrl, user, '/api/spaces')
  expect(response.status).toBe(200)
  return parseExact(spaceListResponseSchema, await response.json()).items
}

async function auditOf(spaceId: string) {
  return database.query(async client => (await client.query<{ action: string, actor_id: string | null, details: unknown }>(
    'SELECT action, actor_id, details FROM audit_events WHERE target_type = \'space\' AND target_id = $1 ORDER BY occurred_at, id',
    [spaceId],
  )).rows)
}

describe('US-M2-05 创建团队空间并指定空间管理员', () => {
  it('系统管理员创建：首个空间管理员在导航里看到它（空间管理员），系统管理员自己没有加入；记审计', async () => {
    const space = await created(await createSpace({ name: ' 市场部 ', adminUserId: amy.id }))
    expect(space).toMatchObject({ name: '市场部', status: 'active', visibleToAll: false, memberCount: 1, myRole: null })
    const nav = await navOf(amySession)
    expect(nav.map(item => [item.type, item.name, item.role])).toEqual([['personal', '艾米', 'admin'], ['team', '市场部', 'admin']])
    expect(nav[1]?.permissions).toEqual({ canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: true })
    // 系统管理员没有内容权限：导航里没有它，空间页是 404
    expect((await navOf(rootSession)).map(item => item.id)).not.toContain(space.id)
    expect((await asUser(app.baseUrl, rootSession, `/api/spaces/${space.id}`)).status).toBe(404)
    expect(await auditOf(space.id)).toEqual([{ action: 'spaces.created', actor_id: root.id, details: { adminUserId: amy.id, visibleToAll: false } }])
  })

  it('首个空间管理员的 id 大写也行：审计的明细是小写（M2-P2 审查 A1）', async () => {
    const space = await created(await createSpace({ name: '大写的管理员', adminUserId: amy.id.toUpperCase() }))
    expect(await auditOf(space.id)).toEqual([{ action: 'spaces.created', actor_id: root.id, details: { adminUserId: amy.id, visibleToAll: false } }])
  })

  it('把自己设为首个空间管理员：我的角色是空间管理员', async () => {
    expect(await created(await createSpace({ name: '管理组', adminUserId: root.id }))).toMatchObject({ memberCount: 1, myRole: 'admin' })
  })

  it('名称不区分大小写唯一，已归档的也算：409 SPACE_NAME_TAKEN', async () => {
    await created(await createSpace({ name: 'Design', adminUserId: amy.id }))
    await createTeamSpace(database, { name: 'Legacy', createdBy: root.id, status: 'archived' })
    for (const name of ['design', 'LEGACY']) {
      const response = await createSpace({ name, adminUserId: amy.id })
      expect(response.status, name).toBe(409)
      expect((await errorOf(response)).code).toBe('SPACE_NAME_TAKEN')
    }
  })

  it('首个空间管理员不存在或已停用：409 ACCOUNT_UNAVAILABLE，不建空间', async () => {
    const disabled = await createPassiveAccount(database, { username: 'gone', status: 'disabled' })
    for (const adminUserId of [disabled.id, randomUUID()]) {
      const response = await createSpace({ name: `无人管理 ${adminUserId}`, adminUserId })
      expect(response.status).toBe(409)
      expect((await errorOf(response)).code).toBe('ACCOUNT_UNAVAILABLE')
    }
    expect(await database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM spaces WHERE name LIKE \'无人管理%\'')).rows[0]?.count))).toBe(0)
  })

  it('列表：按创建时间从新到旧，关键词与状态过滤，分页', async () => {
    for (let index = 0; index < 51; index += 1)
      await createTeamSpace(database, { name: `分页 ${String(index).padStart(2, '0')}`, createdBy: root.id, status: index === 0 ? 'archived' : 'active' })
    const first = parseExact(adminSpaceListResponseSchema, await (await asUser(app.baseUrl, rootSession, '/api/admin/spaces?query=分页')).json())
    expect(first.items).toHaveLength(50)
    expect(first.items[0]?.name).toBe('分页 50')
    const second = parseExact(adminSpaceListResponseSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/spaces?query=分页&cursor=${first.nextCursor ?? ''}`)).json())
    expect(second).toEqual({ items: [expect.objectContaining({ name: '分页 00', status: 'archived' })], nextCursor: null })
    const archived = parseExact(adminSpaceListResponseSchema, await (await asUser(app.baseUrl, rootSession, '/api/admin/spaces?query=分页&status=archived')).json())
    expect(archived.items.map(item => item.name)).toEqual(['分页 00'])
    expect((await asUser(app.baseUrl, rootSession, '/api/admin/spaces?cursor=broken')).status).toBe(400)
  })
})

describe('US-M2-05 全员可见', () => {
  it('打开：所有有效账户在导航里以查看者看到它；关上：不是成员的人看不到；没有变化时不记审计', async () => {
    const space = await created(await createSpace({ name: '公告栏', adminUserId: amy.id }))
    expect((await navOf(benSession)).map(item => item.id)).not.toContain(space.id)
    expect(await adminSpace(await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/visibility`, { method: 'PUT', body: { visibleToAll: true } }))).toMatchObject({ visibleToAll: true })
    const seen = (await navOf(benSession)).find(item => item.id === space.id)
    expect(seen).toMatchObject({ role: 'viewer', visibleToAll: true, permissions: { canCreateDocuments: false, canManageMembers: false } })
    // 系统管理员也是有效账户：全员可见的空间他以查看者看得到
    expect((await navOf(rootSession)).find(item => item.id === space.id)?.role).toBe('viewer')

    await adminSpace(await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/visibility`, { method: 'PUT', body: { visibleToAll: true } }))
    await adminSpace(await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/visibility`, { method: 'PUT', body: { visibleToAll: false } }))
    expect((await navOf(benSession)).map(item => item.id)).not.toContain(space.id)
    expect((await auditOf(space.id)).map(event => [event.action, event.details])).toEqual([
      ['spaces.created', { adminUserId: amy.id, visibleToAll: false }],
      ['spaces.visibility_changed', { visibleToAll: true }],
      ['spaces.visibility_changed', { visibleToAll: false }],
    ])
  })
})

describe('US-M2-05 归档与恢复', () => {
  it('归档：成员照样看得到（至多是查看者），不能新建；恢复之后照旧；都记审计', async () => {
    const space = await created(await createSpace({ name: '旧项目', adminUserId: amy.id }))
    expect(await adminSpace(await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/archive`, { method: 'POST' }))).toMatchObject({ status: 'archived' })
    const archived = parseExact(spaceViewSchema, await (await asUser(app.baseUrl, amySession, `/api/spaces/${space.id}`)).json())
    expect(archived).toMatchObject({ status: 'archived', role: 'viewer', permissions: { canCreateDocuments: false, canManageMembers: false, canRename: false } })
    const create = await asUser(app.baseUrl, amySession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: randomUUID(), spaceId: space.id } })
    expect(create.status).toBe(403)

    // 再归档一次没有变化，不记审计；恢复
    await adminSpace(await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/archive`, { method: 'POST' }))
    expect(await adminSpace(await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/restore`, { method: 'POST' }))).toMatchObject({ status: 'active' })
    expect(parseExact(spaceViewSchema, await (await asUser(app.baseUrl, amySession, `/api/spaces/${space.id}`)).json()).role).toBe('admin')
    expect((await auditOf(space.id)).map(event => event.action)).toEqual(['spaces.created', 'spaces.archived', 'spaces.restored'])
  })

  it('归档要等进行中的新建提交（新建持着空间行的共享锁）：新建成功，之后空间是归档的', async () => {
    const space = await created(await createSpace({ name: '赶在归档之前', adminUserId: amy.id }))
    const archived = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR SHARE', [space.id]),
      request: async () => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space.id}/archive`, { method: 'POST' }),
      change: async client => client.query(
        'INSERT INTO documents (space_id, type, title, created_by, unit_id, profile, format_version, sdk_version) VALUES ($1, \'sheet\', \'赶在归档之前\', $2, $3, \'sheet@1\', 1, \'1.0.1\')',
        [space.id, amy.id, randomUUID()],
      ),
    })
    expect(await adminSpace(archived)).toMatchObject({ status: 'archived' })
    expect(await database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM documents WHERE space_id = $1', [space.id])).rows[0]?.count))).toBe(1)
  })
})

describe('US-M2-05 系统管理员要看内容，先把自己加入空间', () => {
  it('加入之后看得到内容；审计记为系统管理员加入空间（带角色）', async () => {
    const space = await created(await createSpace({ name: '财务部', adminUserId: amy.id }))
    const joined = await asUser(app.baseUrl, rootSession, `/api/spaces/${space.id}/members`, { method: 'POST', body: { userId: root.id, role: 'viewer' } })
    expect(joined.status).toBe(201)
    expect(parseExact(spaceViewSchema, await (await asUser(app.baseUrl, rootSession, `/api/spaces/${space.id}`)).json())).toMatchObject({ role: 'viewer' })
    expect((await auditOf(space.id)).at(-1)).toEqual({ action: 'spaces.admin_joined', actor_id: root.id, details: { role: 'viewer' } })
  })

  it('个人空间对系统管理员始终看不到：管理接口与空间接口都是 404', async () => {
    for (const [path, method] of [[`/api/admin/spaces/${amy.personalSpaceId}/archive`, 'POST'], [`/api/spaces/${amy.personalSpaceId}/members`, 'GET'], [`/api/spaces/${amy.personalSpaceId}`, 'GET']] as const) {
      const response = await asUser(app.baseUrl, rootSession, path, { method })
      expect(response.status, path).toBe(404)
    }
  })

  it('个人空间的 id 传给管理接口：不在它的行上取锁（M2-P2 审查 A4），那一行被别人锁着也立即 404', async () => {
    const statuses = await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        // 持着共享锁（例如本人正在个人空间里新建）：管理接口要是去锁这一行，就会等到锁等待的上限（5 秒）之后以 500 结束
        await client.query('SELECT id FROM spaces WHERE id = $1 FOR SHARE', [amy.personalSpaceId])
        const results: number[] = []
        for (const [path, method, body] of [
          [`/api/admin/spaces/${amy.personalSpaceId}/visibility`, 'PUT', { visibleToAll: true }],
          [`/api/admin/spaces/${amy.personalSpaceId}/archive`, 'POST', undefined],
          [`/api/admin/spaces/${amy.personalSpaceId}/restore`, 'POST', undefined],
        ] as const)
          results.push((await asUser(app.baseUrl, rootSession, path, { method, body })).status)
        return results
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
    expect(statuses).toEqual([404, 404, 404])
  })

  it('审计查询：空间的对象带着它当前的名称', async () => {
    const space = await created(await createSpace({ name: '会改名的空间', adminUserId: amy.id }))
    await asUser(app.baseUrl, amySession, `/api/spaces/${space.id}/name`, { method: 'PUT', body: { name: '改过名的空间' } })
    const page = parseExact(auditEventListResponseSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/audit-events?targetType=space&targetId=${space.id}`)).json())
    expect(page.items.map(item => [item.action, item.target?.label])).toEqual([['spaces.renamed', '改过名的空间'], ['spaces.created', '改过名的空间']])
    expect(page.items[0]?.details).toEqual({ from: '会改名的空间', to: '改过名的空间' })
  })
})

describe('US-M2-05 访问控制', () => {
  it('成员访问团队空间的管理接口：403 PERMISSION_DENIED', async () => {
    const space = await createTeamSpace(database, { name: '访问控制', createdBy: root.id, members: { [amy.id]: 'admin' } })
    for (const [path, method, body] of [
      ['/api/admin/spaces', 'GET', undefined],
      ['/api/admin/spaces', 'POST', { name: '越权', adminUserId: amy.id, visibleToAll: false }],
      [`/api/admin/spaces/${space}/visibility`, 'PUT', { visibleToAll: true }],
      [`/api/admin/spaces/${space}/archive`, 'POST', undefined],
      [`/api/admin/spaces/${space}/restore`, 'POST', undefined],
    ] as const) {
      // 空间管理员也不行：这些是系统管理员的操作
      const response = await asUser(app.baseUrl, amySession, path, { method, body })
      expect(response.status, `${method} ${path}`).toBe(403)
      expect((await errorOf(response)).code).toBe('PERMISSION_DENIED')
    }
  })

  it('没有登录：新接口一律 401；状态变更没有 CSRF 令牌：403', async () => {
    const space = randomUUID()
    const endpoints = [
      ['/api/spaces', 'GET'],
      [`/api/spaces/${space}`, 'GET'],
      [`/api/spaces/${space}/name`, 'PUT'],
      [`/api/spaces/${space}/members`, 'GET'],
      [`/api/spaces/${space}/members`, 'POST'],
      [`/api/spaces/${space}/members/${amy.id}`, 'PUT'],
      [`/api/spaces/${space}/members/${amy.id}`, 'DELETE'],
      ['/api/admin/spaces', 'GET'],
      ['/api/admin/spaces', 'POST'],
      [`/api/admin/spaces/${space}/visibility`, 'PUT'],
      [`/api/admin/spaces/${space}/archive`, 'POST'],
      [`/api/admin/spaces/${space}/restore`, 'POST'],
    ] as const
    for (const [path, method] of endpoints) {
      const response = await fetch(`${app.baseUrl}${path}`, { method, headers: { 'origin': TEST_PUBLIC_ORIGIN, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })
      expect(response.status, `${method} ${path}`).toBe(401)
      if (method !== 'GET') {
        const withoutCsrf = await asUser(app.baseUrl, rootSession, path, { method, body: {}, headers: { [CSRF_TOKEN_HEADER]: undefined } })
        expect(withoutCsrf.status, `${method} ${path}`).toBe(403)
        expect((await errorOf(withoutCsrf)).code).toBe('CSRF_TOKEN_INVALID')
      }
    }
  })
})

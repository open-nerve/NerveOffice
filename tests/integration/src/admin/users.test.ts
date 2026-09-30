// 管理界面的账户（M2-P1 设计 §3.5、§3.6，US-M2-04 的停用、启用与系统管理员）：
// 只给系统管理员；停用撤销会话、登录被拒；"至少保留一个有效的系统管理员"（含并发互相取消）；审计；
// 停用与取消系统管理员时作废这个人签发的、还没用的链接（M2-P6 复核 A2）。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { adminUserListResponseSchema, adminUserSchema, errorResponseSchema, issuedInvitationSchema, issuedPasswordResetSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { linkInvalidReasonOf, postPublic, tokenDigest, tokenOf } from '../support/links.ts'
import { requestIdOf } from '../support/request-id.ts'
import { asUser, login, postLogin } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let rootSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  rootSession = await login(app.baseUrl, 'root', root.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

async function asAdmin(path: string, method = 'GET', body?: unknown, admin: LoggedIn = rootSession): Promise<Response> {
  return asUser(app.baseUrl, admin, path, { method, body })
}

async function auditOf(targetId: string) {
  return database.query(async client => (await client.query<{ action: string, actor_id: string | null, details: unknown }>(
    'SELECT action, actor_id, details FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, id',
    [targetId],
  )).rows)
}

describe('US-M2-04 管理界面的账户：访问控制', () => {
  it('成员访问管理接口：403 PERMISSION_DENIED；没有登录：401', async () => {
    const member = await createAccount(database, { username: 'member-1' })
    const session = await login(app.baseUrl, 'member-1', member.password)
    for (const [path, method] of [['/api/admin/users', 'GET'], [`/api/admin/users/${root.id}/disable`, 'POST'], [`/api/admin/users/${member.id}/system-role`, 'PUT']] as const) {
      const response = await asUser(app.baseUrl, session, path, { method, body: method === 'PUT' ? { systemRole: 'admin' } : undefined })
      expect(response.status, path).toBe(403)
      expect(await codeOf(response)).toBe('PERMISSION_DENIED')
    }
    expect((await fetch(`${app.baseUrl}/api/admin/users`)).status).toBe(401)
    // 成员自己没有因此变成管理员
    expect((await asUser(app.baseUrl, session, '/api/auth/session')).status).toBe(200)
  })

  it('账户不存在：404；id 不是 UUID：400', async () => {
    expect(await codeOf(await asAdmin('/api/admin/users/0192f0c8-0000-7000-8000-00000000dead/disable', 'POST'))).toBe('NOT_FOUND')
    expect(await codeOf(await asAdmin('/api/admin/users/not-a-uuid/disable', 'POST'))).toBe('REQUEST_INVALID')
  })

  it('系统角色的请求不合法（未知的角色、缺字段、多余的字段）：400', async () => {
    const target = await createAccount(database, { username: 'role-target' })
    for (const body of [{ systemRole: 'owner' }, {}, { systemRole: 'admin', reason: 'x' }])
      expect(await codeOf(await asAdmin(`/api/admin/users/${target.id}/system-role`, 'PUT', body))).toBe('REQUEST_INVALID')
  })
})

describe('US-M2-04 停用与启用', () => {
  it('停用：会话全部撤销，已打开的页面下一次请求被要求重新登录，登录提示与密码错误相同；再停用不重复记审计', async () => {
    const frank = await createAccount(database, { username: 'frank' })
    const open = await login(app.baseUrl, 'frank', frank.password)

    const response = await asAdmin(`/api/admin/users/${frank.id}/disable`, 'POST')
    expect(response.status).toBe(200)
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ id: frank.id, status: 'disabled' })
    const kicked = await asUser(app.baseUrl, open, '/api/auth/session')
    expect(kicked.status).toBe(401)
    expect(await codeOf(kicked)).toBe('SESSION_EXPIRED')
    const reasons = await database.query(async client => (await client.query<{ revoked_reason: string | null }>('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1', [frank.id])).rows)
    expect(reasons).toEqual([{ revoked_reason: 'disabled' }])
    expect(await codeOf(await postLogin(app.baseUrl, { username: 'frank', password: frank.password }))).toBe('INVALID_CREDENTIALS')

    expect((await asAdmin(`/api/admin/users/${frank.id}/disable`, 'POST')).status).toBe(200)
    expect((await auditOf(frank.id)).filter(event => event.action === 'users.disabled')).toEqual([{ action: 'users.disabled', actor_id: root.id, details: {} }])
  })

  it('启用：恢复登录；记审计', async () => {
    const grace = await createAccount(database, { username: 'grace' })
    await asAdmin(`/api/admin/users/${grace.id}/disable`, 'POST')
    const response = await asAdmin(`/api/admin/users/${grace.id}/enable`, 'POST')
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ status: 'active' })
    expect((await postLogin(app.baseUrl, { username: 'grace', password: grace.password })).status).toBe(200)
    expect((await auditOf(grace.id)).map(event => event.action)).toEqual(expect.arrayContaining(['users.disabled', 'users.enabled']))
  })
})

describe('US-M2-04 系统管理员的授予与取消', () => {
  it('授予后下一次请求就能访问管理接口；取消后下一次请求就被拒绝；审计记下原角色与新角色', async () => {
    const heidi = await createAccount(database, { username: 'heidi' })
    const session = await login(app.baseUrl, 'heidi', heidi.password)
    expect((await asUser(app.baseUrl, session, '/api/admin/users')).status).toBe(403)

    const granted = await asAdmin(`/api/admin/users/${heidi.id}/system-role`, 'PUT', { systemRole: 'admin' })
    expect(parseExact(adminUserSchema, await granted.json())).toMatchObject({ systemRole: 'admin' })
    expect((await asUser(app.baseUrl, session, '/api/admin/users')).status).toBe(200)

    await asAdmin(`/api/admin/users/${heidi.id}/system-role`, 'PUT', { systemRole: 'member' })
    expect((await asUser(app.baseUrl, session, '/api/admin/users')).status).toBe(403)
    const changes = (await auditOf(heidi.id)).filter(event => event.action === 'users.system_role_changed')
    expect(changes).toEqual([
      { action: 'users.system_role_changed', actor_id: root.id, details: { from: 'member', to: 'admin' } },
      { action: 'users.system_role_changed', actor_id: root.id, details: { from: 'admin', to: 'member' } },
    ])
  })

  it('停用的账户不能被授予：409 ACCOUNT_DISABLED', async () => {
    const ivan = await createAccount(database, { username: 'ivan' })
    await asAdmin(`/api/admin/users/${ivan.id}/disable`, 'POST')
    expect(await codeOf(await asAdmin(`/api/admin/users/${ivan.id}/system-role`, 'PUT', { systemRole: 'admin' }))).toBe('ACCOUNT_DISABLED')
  })
})

describe('US-M2-04 至少保留一个有效的系统管理员', () => {
  it('最后一个有效的系统管理员不能被取消或停用（409 LAST_ADMIN）；有别的管理员时可以取消自己', async () => {
    // 这个文件的库里，此刻有效的管理员只有 root（heidi 已被取消）
    expect(await codeOf(await asAdmin(`/api/admin/users/${root.id}/system-role`, 'PUT', { systemRole: 'member' }))).toBe('LAST_ADMIN')
    expect(await codeOf(await asAdmin(`/api/admin/users/${root.id}/disable`, 'POST'))).toBe('LAST_ADMIN')

    const judy = await createAccount(database, { username: 'judy', systemRole: 'admin' })
    const judySession = await login(app.baseUrl, 'judy', judy.password)
    const self = await asAdmin(`/api/admin/users/${judy.id}/system-role`, 'PUT', { systemRole: 'member' }, judySession)
    expect(parseExact(adminUserSchema, await self.json())).toMatchObject({ systemRole: 'member' })
    // 停用的管理员不算有效的管理员
    const kate = await createAccount(database, { username: 'kate', systemRole: 'admin' })
    await asAdmin(`/api/admin/users/${kate.id}/disable`, 'POST')
    expect(await codeOf(await asAdmin(`/api/admin/users/${root.id}/system-role`, 'PUT', { systemRole: 'member' }))).toBe('LAST_ADMIN')
  })

  it('两个管理员同时互相取消（确定的交错，M2-P6 复核 S-5）：只有一个成功，始终剩下一个有效的系统管理员', async () => {
    const leo = await createAccount(database, { username: 'leo', systemRole: 'admin' })
    const leoSession = await login(app.baseUrl, 'leo', leo.password)
    // 此刻有效的管理员是 root 与 leo：同时取消对方。持有 system-admins 的排他锁，等两个请求都过了会话守卫、都在这把锁上等着了再放开：
    // 这把锁要是弱成共享的（或者不取），两边会同时数到"除对方以外还有一个管理员"，一起提交，一个有效的系统管理员都不剩
    const [a, b] = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:system-admins\', 0))'),
      request: async () => Promise.all([
        asAdmin(`/api/admin/users/${leo.id}/system-role`, 'PUT', { systemRole: 'member' }),
        asAdmin(`/api/admin/users/${root.id}/system-role`, 'PUT', { systemRole: 'member' }, leoSession),
      ]),
      waiting: 2,
      change: async () => undefined,
    })
    // 两个请求都过了会话守卫：先拿到锁的一方取消了对方；输的一方拿到锁之后在锁里复核操作者（审查 A12），发现自己已不再是管理员，403
    const [winner, loser] = a.status === 200 ? [a, b] : [b, a]
    expect(winner.status).toBe(200)
    expect(loser.status).toBe(403)
    expect(await codeOf(loser)).toBe('PERMISSION_DENIED')
    const [admins] = await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM users WHERE system_role = \'admin\' AND status = \'active\'')).rows)
    expect(admins).toEqual({ count: 1 })
    // 恢复：保证 root 仍是管理员，后面的用例照常
    if (a.status !== 200)
      await asAdmin(`/api/admin/users/${root.id}/system-role`, 'PUT', { systemRole: 'admin' }, leoSession)
    rootSession = await login(app.baseUrl, 'root', root.password)
  })
})

describe('US-M2-04 停用自己（M2-P1 设计 §3.5）', () => {
  it('有别的有效管理员时可以停用自己：自己的会话随即失效，登录提示与密码错误相同', async () => {
    const mia = await createAccount(database, { username: 'mia', systemRole: 'admin' })
    const miaSession = await login(app.baseUrl, 'mia', mia.password)
    const response = await asAdmin(`/api/admin/users/${mia.id}/disable`, 'POST', undefined, miaSession)
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ status: 'disabled' })
    const next = await asUser(app.baseUrl, miaSession, '/api/admin/users')
    expect(next.status).toBe(401)
    expect(await codeOf(next)).toBe('SESSION_EXPIRED')
    expect(await codeOf(await postLogin(app.baseUrl, { username: 'mia', password: mia.password }))).toBe('INVALID_CREDENTIALS')
  })
})

describe('US-M2-04 账户列表', () => {
  it('含停用的账户，按登录名排序；可按关键词（显示名或登录名）与状态过滤；每页 50 条，游标翻页', async () => {
    for (let index = 0; index < 52; index += 1)
      await createAccount(database, { username: `page-${String(index).padStart(2, '0')}`, displayName: `分页 ${index}` })
    const first = parseExact(adminUserListResponseSchema, await (await asAdmin('/api/admin/users?query=page-')).json())
    expect(first.items).toHaveLength(50)
    expect(first.items[0]?.username).toBe('page-00')
    const second = parseExact(adminUserListResponseSchema, await (await asAdmin(`/api/admin/users?query=page-&cursor=${first.nextCursor ?? ''}`)).json())
    expect(second.items.map(item => item.username)).toEqual(['page-50', 'page-51'])
    expect(second.nextCursor).toBeNull()

    const byDisplayName = parseExact(adminUserListResponseSchema, await (await asAdmin(`/api/admin/users?query=${encodeURIComponent('分页 5')}`)).json())
    expect(byDisplayName.items.map(item => item.username)).toEqual(['page-05', 'page-50', 'page-51'])

    const disabled = parseExact(adminUserListResponseSchema, await (await asAdmin('/api/admin/users?status=disabled')).json())
    expect(disabled.items.every(item => item.status === 'disabled')).toBe(true)
    expect(disabled.items.map(item => item.username)).toEqual(expect.arrayContaining(['frank', 'ivan', 'kate']))

    expect(await codeOf(await asAdmin('/api/admin/users?cursor=broken'))).toBe('REQUEST_INVALID')
  })
})

describe('US-M2-04 签发人离任：他签发的、还没用的链接随即作废（M2-P6 复核 A2）', () => {
  const PASSWORD = 'a good long password'

  async function invite(session: LoggedIn, username: string) {
    const response = await asUser(app.baseUrl, session, '/api/admin/invitations', { method: 'POST', body: { username, displayName: username } })
    expect(response.status, await response.clone().text()).toBe(201)
    const issued = parseExact(issuedInvitationSchema, await response.json())
    return { id: issued.invitation.id, token: tokenOf(issued.url) }
  }

  async function issueReset(session: LoggedIn, account: TestAccount) {
    const response = await asUser(app.baseUrl, session, `/api/admin/users/${account.id}/password-reset`, { method: 'POST' })
    expect(response.status, await response.clone().text()).toBe(201)
    const token = tokenOf(parseExact(issuedPasswordResetSchema, await response.json()).url)
    const [row] = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM auth_password_resets WHERE token_hash = $1', [tokenDigest(token)])).rows)
    if (row === undefined)
      throw new Error('签发之后库里没有这条重置')
    return { id: row.id, token }
  }

  /** 查看与接受（邀请）或查看与完成（重置）的结果：可用时 200，不能用时是原因 */
  async function invitationOutcome(token: string): Promise<[string, string]> {
    const inspect = await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token })
    const accept = await postPublic(app.baseUrl, '/api/auth/invitations/accept', { token, displayName: '受邀的人', password: PASSWORD })
    return [await linkInvalidReasonOf(inspect), await linkInvalidReasonOf(accept)]
  }

  async function resetOutcome(token: string): Promise<[string, string]> {
    const inspect = await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token })
    const complete = await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token, password: PASSWORD })
    return [await linkInvalidReasonOf(inspect), await linkInvalidReasonOf(complete)]
  }

  /** 这个请求记下的审计：动作、操作者、对象与明细，按写入的顺序 */
  async function auditsOf(response: Response) {
    return database.query(async client => (await client.query<{ action: string, actor_id: string | null, target_type: string | null, target_id: string | null, details: unknown }>(
      'SELECT action, actor_id, target_type, target_id, details FROM audit_events WHERE request_id = $1 ORDER BY occurred_at, id',
      [requestIdOf(response)],
    )).rows)
  }

  it('停用签发人：他签发的邀请与重置都不能再用（查看与接受、完成都是 410 revoked），逐条记审计（issuer_disabled）；别人签发的、已经过期的不受影响', async () => {
    const issuer = await createAccount(database, { username: 'issuer-a', systemRole: 'admin' })
    const issuerSession = await login(app.baseUrl, 'issuer-a', issuer.password)
    const target = await createAccount(database, { username: 'reset-target-a' })
    const bystander = await createAccount(database, { username: 'reset-bystander-a' })
    const invitation = await invite(issuerSession, 'invitee-a')
    const expired = await invite(issuerSession, 'invitee-a-expired')
    await database.query(async client => client.query('UPDATE auth_invitations SET created_at = now() - interval \'8 days\', expires_at = now() - interval \'1 day\' WHERE id = $1', [expired.id]))
    const reset = await issueReset(issuerSession, target)
    const othersInvitation = await invite(rootSession, 'invitee-root-a')
    const othersReset = await issueReset(rootSession, bystander)

    const response = await asAdmin(`/api/admin/users/${issuer.id}/disable`, 'POST')
    expect(response.status).toBe(200)

    expect(await invitationOutcome(invitation.token)).toEqual(['revoked', 'revoked'])
    expect(await resetOutcome(reset.token)).toEqual(['revoked', 'revoked'])
    expect(await linkInvalidReasonOf(await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: expired.token }))).toBe('expired')
    expect((await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: othersInvitation.token })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: othersReset.token })).status).toBe(200)
    // 与停用在同一个事务里：同一个请求标识，每作废一条记一条，操作者是执行停用的管理员
    expect(await auditsOf(response)).toEqual([
      { action: 'users.password_reset_revoked', actor_id: root.id, target_type: 'user', target_id: target.id, details: { passwordResetId: reset.id, reason: 'issuer_disabled' } },
      { action: 'users.invitation_revoked', actor_id: root.id, target_type: 'invitation', target_id: invitation.id, details: { reason: 'issuer_disabled' } },
      { action: 'users.disabled', actor_id: root.id, target_type: 'user', target_id: issuer.id, details: {} },
    ])
    const [revokedBy] = await database.query(async client => (await client.query<{ revoked_by: string }>('SELECT revoked_by FROM auth_invitations WHERE id = $1', [invitation.id])).rows)
    expect(revokedBy).toEqual({ revoked_by: root.id })
  })

  it('取消系统管理员：他签发给别人的邀请与重置同样作废（issuer_no_longer_admin）；他给自己签发的重置是他自己账户的，照常可用', async () => {
    const issuer = await createAccount(database, { username: 'issuer-b', systemRole: 'admin' })
    const issuerSession = await login(app.baseUrl, 'issuer-b', issuer.password)
    const target = await createAccount(database, { username: 'reset-target-b' })
    const invitation = await invite(issuerSession, 'invitee-b')
    const reset = await issueReset(issuerSession, target)
    // 给自己签发放在最后：签发时自己的会话随即撤销
    const own = await issueReset(issuerSession, issuer)

    const response = await asAdmin(`/api/admin/users/${issuer.id}/system-role`, 'PUT', { systemRole: 'member' })
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ systemRole: 'member', status: 'active' })

    expect(await invitationOutcome(invitation.token)).toEqual(['revoked', 'revoked'])
    expect(await resetOutcome(reset.token)).toEqual(['revoked', 'revoked'])
    expect(await auditsOf(response)).toEqual([
      { action: 'users.password_reset_revoked', actor_id: root.id, target_type: 'user', target_id: target.id, details: { passwordResetId: reset.id, reason: 'issuer_no_longer_admin' } },
      { action: 'users.invitation_revoked', actor_id: root.id, target_type: 'invitation', target_id: invitation.id, details: { reason: 'issuer_no_longer_admin' } },
      { action: 'users.system_role_changed', actor_id: root.id, target_type: 'user', target_id: issuer.id, details: { from: 'admin', to: 'member' } },
    ])
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: own.token, password: PASSWORD })).status).toBe(200)
    expect((await postLogin(app.baseUrl, { username: 'issuer-b', password: PASSWORD })).status).toBe(200)
  })

  it('授予系统管理员、签发人没有未用的链接：不作废任何东西，不多记审计', async () => {
    const quiet = await createAccount(database, { username: 'issuer-c' })
    const granted = await asAdmin(`/api/admin/users/${quiet.id}/system-role`, 'PUT', { systemRole: 'admin' })
    expect((await auditsOf(granted)).map(event => event.action)).toEqual(['users.system_role_changed'])
    const revoked = await asAdmin(`/api/admin/users/${quiet.id}/system-role`, 'PUT', { systemRole: 'member' })
    expect((await auditsOf(revoked)).map(event => event.action)).toEqual(['users.system_role_changed'])
  })
})

// 邀请注册（M2-P1 设计 §3.4，US-M2-01）：签发、查看、接受（建账户与个人空间、登录）、作废、重发、过期、并发、尝试限流、审计。
import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { errorResponseSchema, inspectLinkResponseSchema, invitationListResponseSchema, invitationSchema, issuedInvitationSchema, issuedPasswordResetSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { linkInvalidReasonOf, postPublic, tokenDigest, tokenOf } from '../support/links.ts'
import { requestIdOf } from '../support/request-id.ts'
import { asUser, cookieValue, login, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let admin: TestAccount
let adminSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  admin = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  adminSession = await login(app.baseUrl, 'root', admin.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

async function invite(username: string, displayName = username) {
  const response = await asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username, displayName } })
  expect(response.status, await response.clone().text()).toBe(201)
  const issued = parseExact(issuedInvitationSchema, await response.json())
  return { ...issued, token: tokenOf(issued.url), requestId: requestIdOf(response) }
}

async function inspect(token: string): Promise<Response> {
  return postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token })
}

async function accept(token: string, displayName = '新同事', password = 'a good long password', headers: Record<string, string> = {}): Promise<Response> {
  return postPublic(app.baseUrl, '/api/auth/invitations/accept', { token, displayName, password }, headers)
}

async function auditRows(where: string, values: unknown[]) {
  return database.query(async client => (await client.query<{ action: string, actor_type: string, actor_id: string | null, target_type: string | null, target_id: string | null, details: Record<string, unknown> }>(
    `SELECT action, actor_type, actor_id, target_type, target_id, details FROM audit_events WHERE ${where} ORDER BY occurred_at, id`,
    values,
  )).rows)
}

describe('US-M2-01 邀请注册：签发与接受', () => {
  it('签发：链接是 <公开地址>/invite#<令牌>，库里只有令牌的摘要；记审计（对象是邀请，details 只有登录名）', async () => {
    const issued = await invite('amy', '艾米')
    expect(issued.url).toBe(`http://127.0.0.1:4100/invite#${issued.token}`)
    expect(issued.token).toMatch(/^[\w-]{43}$/)
    expect(issued.invitation).toMatchObject({ username: 'amy', displayName: '艾米', status: 'pending', createdBy: { id: admin.id, username: 'root' } })
    const [row] = await database.query(async client => (await client.query<{ token_hash: Buffer }>('SELECT token_hash FROM auth_invitations WHERE id = $1', [issued.invitation.id])).rows)
    expect(row?.token_hash.equals(tokenDigest(issued.token))).toBe(true)
    expect(await auditRows('request_id = $1', [issued.requestId])).toEqual([
      { action: 'users.invited', actor_type: 'user', actor_id: admin.id, target_type: 'invitation', target_id: issued.invitation.id, details: { username: 'amy' } },
    ])
  })

  it('7 天内有效（M2 总设计 §2.1 第 2 条，M2-P6 复核 S-2）：签发时到期时间离现在约 168 小时，库里按数据库时间算', async () => {
    const issued = await invite('seven-days')
    const hours = (Date.parse(issued.invitation.expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(167.9)
    expect(hours).toBeLessThanOrEqual(168)
    const [row] = await database.query(async client => (await client.query<{ lifetime: number }>(
      'SELECT extract(epoch from expires_at - created_at)::int AS lifetime FROM auth_invitations WHERE id = $1',
      [issued.invitation.id],
    )).rows)
    expect(row?.lifetime).toBe(7 * 24 * 3600)
  })

  it('查看：只给出登录名、显示名与到期时间；接受：建成员账户与个人空间，改过的显示名生效，已经登录，记审计', async () => {
    const issued = await invite('bea', '贝亚')
    const inspected = await inspect(issued.token)
    expect(inspected.status).toBe(200)
    expect(parseExact(inspectLinkResponseSchema, await inspected.json())).toEqual({ username: 'bea', displayName: '贝亚', expiresAt: issued.invitation.expiresAt })

    const response = await accept(issued.token, '贝亚·新')
    expect(response.status).toBe(200)
    const session = parseExact(sessionResponseSchema, await response.json())
    expect(session.user).toMatchObject({ username: 'bea', displayName: '贝亚·新', systemRole: 'member' })
    const setCookie = sessionSetCookie(response)
    expect(setCookie).toBeDefined()
    const user: LoggedIn = { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie ?? '')}`, session }
    expect((await asUser(app.baseUrl, user, '/api/auth/session')).status).toBe(200)
    expect((await asUser(app.baseUrl, user, '/api/documents')).status).toBe(200)

    const [account] = await database.query(async client => (await client.query<{ status: string, spaces: number }>(
      'SELECT u.status, (SELECT count(*)::int FROM spaces s WHERE s.owner_user_id = u.id AND s.type = \'personal\') AS spaces FROM users u WHERE u.username = \'bea\'',
    )).rows)
    expect(account).toEqual({ status: 'active', spaces: 1 })
    expect(await auditRows('action = \'users.invitation_accepted\' AND actor_id = $1', [session.user.id])).toEqual([
      { action: 'users.invitation_accepted', actor_type: 'user', actor_id: session.user.id, target_type: 'user', target_id: session.user.id, details: { invitationId: issued.invitation.id } },
    ])
  })

  it('接受之后再用这个链接：查看与接受都是 410 LINK_INVALID（used）', async () => {
    const issued = await invite('cai')
    expect((await accept(issued.token)).status).toBe(200)
    expect(await linkInvalidReasonOf(await inspect(issued.token))).toBe('used')
    expect(await linkInvalidReasonOf(await accept(issued.token))).toBe('used')
  })

  it('浏览器原来带着别人的会话：接受之后原来的会话作废（replaced）', async () => {
    const issued = await invite('dan')
    const other = await createAccount(database, { username: 'other-dan' })
    const otherSession = await login(app.baseUrl, 'other-dan', other.password)
    const response = await accept(issued.token, '丹', 'a good long password', { cookie: otherSession.cookie })
    expect(response.status).toBe(200)
    expect((await asUser(app.baseUrl, otherSession, '/api/auth/session')).status).toBe(401)
  })

  it('新密码或显示名不符合规则：400，邀请仍可用', async () => {
    const issued = await invite('eve')
    expect(await codeOf(await accept(issued.token, '伊芙', 'short'))).toBe('REQUEST_INVALID')
    expect(await codeOf(await accept(issued.token, '  ', 'a good long password'))).toBe('REQUEST_INVALID')
    // 受邀人改的显示名同样按名称的共用规则（M2-P6 复核 B2）：只有零宽字符、带行分隔符都拒绝
    expect(await codeOf(await accept(issued.token, String.fromCharCode(0x200B, 0x200D), 'a good long password'))).toBe('REQUEST_INVALID')
    expect(await codeOf(await accept(issued.token, `伊${String.fromCharCode(0x2028)}芙`, 'a good long password'))).toBe('REQUEST_INVALID')
    expect((await inspect(issued.token)).status).toBe(200)
  })
})

describe('US-M2-01 邀请注册：登录名冲突、过期、作废、重发', () => {
  it('登录名已被账户占用，或者已有待接受的邀请：409 USERNAME_TAKEN', async () => {
    await createAccount(database, { username: 'fay' })
    const taken = await asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'FAY', displayName: '菲' } })
    expect(await codeOf(taken)).toBe('USERNAME_TAKEN')
    await invite('gus')
    const pending = await asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'gus', displayName: '格斯' } })
    expect(await codeOf(pending)).toBe('USERNAME_TAKEN')
  })

  it('过期：查看与接受都是 410（expired）；再签发同一个登录名时，过期的旧邀请自动作废', async () => {
    const old = await invite('hal')
    await database.query(async client => client.query('UPDATE auth_invitations SET created_at = now() - interval \'8 days\', expires_at = now() - interval \'1 day\' WHERE id = $1', [old.invitation.id]))
    expect(await linkInvalidReasonOf(await inspect(old.token))).toBe('expired')
    expect(await linkInvalidReasonOf(await accept(old.token))).toBe('expired')

    const fresh = await invite('hal')
    expect(await linkInvalidReasonOf(await inspect(old.token))).toBe('revoked')
    expect((await inspect(fresh.token)).status).toBe(200)
    expect(await auditRows('action = \'users.invitation_revoked\' AND target_id = $1', [old.invitation.id])).toEqual([
      { action: 'users.invitation_revoked', actor_type: 'user', actor_id: admin.id, target_type: 'invitation', target_id: old.invitation.id, details: { expired: true } },
    ])
  })

  it('作废：之后查看是 410（revoked）；再作废原样返回，不重复记审计', async () => {
    const issued = await invite('ida')
    const revoked = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${issued.invitation.id}/revoke`, { method: 'POST' })
    expect(parseExact(invitationSchema, await revoked.json())).toMatchObject({ status: 'revoked' })
    expect(await linkInvalidReasonOf(await inspect(issued.token))).toBe('revoked')
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${issued.invitation.id}/revoke`, { method: 'POST' })).status).toBe(200)
    expect(await auditRows('action = \'users.invitation_revoked\' AND target_id = $1', [issued.invitation.id])).toHaveLength(1)
  })

  it('重发：旧的作废、新的可用，登录名与显示名不变；已接受的不能重发（409 USERNAME_TAKEN）', async () => {
    const first = await invite('jon', '乔恩')
    const response = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${first.invitation.id}/reissue`, { method: 'POST' })
    expect(response.status).toBe(201)
    const second = parseExact(issuedInvitationSchema, await response.json())
    expect(second.invitation).toMatchObject({ username: 'jon', displayName: '乔恩', status: 'pending', superseded: false })
    expect(await linkInvalidReasonOf(await inspect(first.token))).toBe('revoked')
    expect(await auditRows('action = \'users.invited\' AND target_id = $1', [second.invitation.id])).toMatchObject([{ details: { username: 'jon', reissuedFrom: first.invitation.id } }])
    // 列表里旧的一条已被替代（审查 B6）：界面只对最新的一条给出重新生成
    const listed = parseExact(invitationListResponseSchema, await (await asUser(app.baseUrl, adminSession, '/api/admin/invitations')).json())
    expect(listed.items.find(item => item.id === first.invitation.id)).toMatchObject({ status: 'revoked', superseded: true })
    expect(listed.items.find(item => item.id === second.invitation.id)).toMatchObject({ status: 'pending', superseded: false })
    expect((await accept(tokenOf(second.url))).status).toBe(200)
    const again = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${second.invitation.id}/reissue`, { method: 'POST' })
    expect(await codeOf(again)).toBe('USERNAME_TAKEN')
  })

  it('重发已作废或已过期的邀请：签发新的；作废的不再记一次作废，过期的随重发作废', async () => {
    const revoked = await invite('ned')
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${revoked.invitation.id}/revoke`, { method: 'POST' })).status).toBe(200)
    const fromRevoked = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${revoked.invitation.id}/reissue`, { method: 'POST' })
    expect(fromRevoked.status).toBe(201)
    expect((await inspect(tokenOf(parseExact(issuedInvitationSchema, await fromRevoked.json()).url))).status).toBe(200)
    expect(await auditRows('action = \'users.invitation_revoked\' AND target_id = $1', [revoked.invitation.id])).toHaveLength(1)

    const expired = await invite('ola')
    await database.query(async client => client.query('UPDATE auth_invitations SET created_at = now() - interval \'8 days\', expires_at = now() - interval \'1 day\' WHERE id = $1', [expired.invitation.id]))
    const fromExpired = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${expired.invitation.id}/reissue`, { method: 'POST' })
    expect(fromExpired.status).toBe(201)
    expect(await auditRows('action = \'users.invitation_revoked\' AND target_id = $1', [expired.invitation.id])).toMatchObject([{ details: { reissued: true } }])
  })

  it('作废已接受的邀请：原样返回（已接受），不记审计', async () => {
    const issued = await invite('pam')
    expect((await accept(issued.token)).status).toBe(200)
    const response = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${issued.invitation.id}/revoke`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(parseExact(invitationSchema, await response.json())).toMatchObject({ status: 'accepted', revokedAt: null })
    expect(await auditRows('action = \'users.invitation_revoked\' AND target_id = $1', [issued.invitation.id])).toEqual([])
  })

  it('请求不合法：签发时登录名或显示名不符合规则 400；作废与重发的 id 不是 UUID 400、不存在 404', async () => {
    const post = async (path: string, body?: unknown) => asUser(app.baseUrl, adminSession, path, { method: 'POST', body })
    expect(await codeOf(await post('/api/admin/invitations', { username: 'a b', displayName: '名字' }))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations', { username: 'valid-name', displayName: '' }))).toBe('REQUEST_INVALID')
    // 显示名按名称的共用规则（M2-P6 复核 B2）：改变文字方向的字符、只有看不见的字符都拒绝；夹在字中间的零宽空格也拒绝（复验 N6）
    const rightToLeftOverride = String.fromCharCode(0x202E)
    const hangulFiller = String.fromCharCode(0x3164)
    const zeroWidthSpace = String.fromCharCode(0x200B)
    expect(await codeOf(await post('/api/admin/invitations', { username: 'valid-name', displayName: `张${rightToLeftOverride}三` }))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations', { username: 'valid-name', displayName: hangulFiller }))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations', { username: 'valid-name', displayName: `张${zeroWidthSpace}三` }))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations', { username: 'valid-name', displayName: '名字', systemRole: 'admin' }))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations/not-a-uuid/revoke'))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations/not-a-uuid/reissue'))).toBe('REQUEST_INVALID')
    expect(await codeOf(await post('/api/admin/invitations/0192f0c8-0000-7000-8000-00000000dead/revoke'))).toBe('NOT_FOUND')
    expect(await codeOf(await post('/api/admin/invitations/0192f0c8-0000-7000-8000-00000000dead/reissue'))).toBe('NOT_FOUND')
    expect(await codeOf(await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: 'A'.repeat(1_000) }))).toBe('REQUEST_INVALID')
  })

  it('列表按四种状态过滤：待接受、已接受、已过期（到期而没有处理）、已作废，各自只给这一种', async () => {
    const pending = await invite('st-pending')
    const accepted = await invite('st-accepted')
    expect((await accept(accepted.token)).status).toBe(200)
    const expired = await invite('st-expired')
    await database.query(async client => client.query('UPDATE auth_invitations SET created_at = now() - interval \'8 days\', expires_at = now() - interval \'1 day\' WHERE id = $1', [expired.invitation.id]))
    const revoked = await invite('st-revoked')
    await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${revoked.invitation.id}/revoke`, { method: 'POST' })
    const expectations = [['pending', pending], ['accepted', accepted], ['expired', expired], ['revoked', revoked]] as const
    for (const [status, issued] of expectations) {
      const list = parseExact(invitationListResponseSchema, await (await asUser(app.baseUrl, adminSession, `/api/admin/invitations?status=${status}`)).json())
      expect(list.items.every(item => item.status === status), status).toBe(true)
      expect(list.items.map(item => item.id), status).toContain(issued.invitation.id)
      for (const [other, otherIssued] of expectations) {
        if (other !== status)
          expect(list.items.map(item => item.id), `${status} 里不应有 ${other}`).not.toContain(otherIssued.invitation.id)
      }
    }
  })

  it('列表：按签发时间从新到旧，状态按到期与处理结果算出，可按状态过滤；响应里没有令牌', async () => {
    const response = await asUser(app.baseUrl, adminSession, '/api/admin/invitations?status=revoked')
    const text = await response.text()
    const list = parseExact(invitationListResponseSchema, JSON.parse(text))
    expect(list.items.length).toBeGreaterThanOrEqual(3)
    expect(list.items.every(item => item.status === 'revoked')).toBe(true)
    expect(text).not.toMatch(/token/i)
    const all = parseExact(invitationListResponseSchema, await (await asUser(app.baseUrl, adminSession, '/api/admin/invitations')).json())
    const times = all.items.map(item => item.createdAt)
    expect([...times].sort().reverse()).toEqual(times)
  })
})

describe('US-M2-01 邀请注册：并发、无效的令牌、访问控制', () => {
  it('同一个令牌并发接受两次（确定的交错，M2-P6 复核 S-5）：两次都查过令牌、都进了事务，只有一次成功，另一次 410（used），只建了一个账户', async () => {
    const issued = await invite('kim')
    // 持有这条邀请的行锁：先到的一次拿着登录名的锁在行锁上等，后到的一次在登录名的锁上等它。两次都在事务之外查过令牌（都还可用），
    // 放开之后先到的建成账户、提交；后到的在事务里复核，才发现已经用过
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM auth_invitations WHERE id = $1 FOR UPDATE', [issued.invitation.id]),
      request: async () => Promise.all([accept(issued.token, '金'), accept(issued.token, '金')]),
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status).sort()).toEqual([200, 410])
    const loser = responses.find(response => response.status === 410)
    expect(loser === undefined ? undefined : await linkInvalidReasonOf(loser)).toBe('used')
    const [count] = await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM users WHERE username = \'kim\'')).rows)
    expect(count).toEqual({ count: 1 })
  })

  it('同一个登录名并发签发两次（确定的交错，M2-P6 复核 S-4）：按登录名的锁排队，一次 201、另一次 409 USERNAME_TAKEN，不是 500', async () => {
    // 持有签发人账户行的 FOR UPDATE：先到的签发拿着登录名的锁、写邀请时在外键检查上等；后到的在登录名的锁上等它。
    // 没有登录名的锁时，两次都查过"没有待接受的邀请"才写入，后写的一次撞上部分唯一索引，变成 500
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [admin.id]),
      request: async () => Promise.all([
        asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'twin-issue', displayName: '同时签发' } }),
        asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'twin-issue', displayName: '同时签发' } }),
      ]),
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    const taken = responses.find(response => response.status === 409)
    expect(taken === undefined ? undefined : await codeOf(taken)).toBe('USERNAME_TAKEN')
    const [open] = await database.query(async client => (await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM auth_invitations WHERE username = \'twin-issue\' AND accepted_at IS NULL AND revoked_at IS NULL',
    )).rows)
    expect(open).toEqual({ count: 1 })
  })

  it('没有这个令牌、格式不对：410 LINK_INVALID（invalid），记审计（未登录的访问者，没有对象）', async () => {
    const guess = 'A'.repeat(43)
    const response = await inspect(guess)
    expect(response.status).toBe(410)
    expect(await linkInvalidReasonOf(response)).toBe('invalid')
    expect(await linkInvalidReasonOf(await inspect('not-a-token'))).toBe('invalid')
    const rows = await auditRows('action = \'auth.link_rejected\' AND details->>\'reason\' = \'invalid\'', [])
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]).toMatchObject({ actor_type: 'anonymous', actor_id: null, target_type: null, details: { purpose: 'invitation', reason: 'invalid' } })
  })

  it('成员不能签发、查看或作废邀请：403；没有登录：401', async () => {
    const member = await createAccount(database, { username: 'plain-member' })
    const session = await login(app.baseUrl, 'plain-member', member.password)
    expect(await codeOf(await asUser(app.baseUrl, session, '/api/admin/invitations', { method: 'POST', body: { username: 'zed', displayName: '泽德' } }))).toBe('PERMISSION_DENIED')
    expect(await codeOf(await asUser(app.baseUrl, session, '/api/admin/invitations'))).toBe('PERMISSION_DENIED')
    expect((await fetch(`${app.baseUrl}/api/admin/invitations`)).status).toBe(401)
  })

  it('公开接口的状态变更照样检查 Origin：没有或不是本站时 403', async () => {
    const issued = await invite('lou')
    const response = await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: issued.token }, { origin: 'https://evil.example' })
    expect(await codeOf(response)).toBe('ORIGIN_NOT_ALLOWED')
  })
})

describe('US-M2-01、US-M2-03 一次性链接的尝试限流', () => {
  // 按地址 3 次失败就锁定；同一条"找到了但不能用"的链接 6 次锁定（M2-P6）：这个库只给限流的用例用，每个用例开始时清空计数
  let limited: TestDatabase
  let limitedApp: TestApp
  let boss: LoggedIn

  beforeAll(async () => {
    limited = await createTestDatabase()
    limitedApp = await startTestApp({ databaseUrl: limited.url, env: { NERVE_LOGIN_IP_MAX_FAILURES: '3', NERVE_LINK_RECORD_MAX_FAILURES: '6' } })
    const account = await createAccount(limited, { username: 'boss', systemRole: 'admin' })
    boss = await login(limitedApp.baseUrl, 'boss', account.password)
  })

  beforeEach(async () => {
    await limited.query(async client => client.query('DELETE FROM auth_login_throttles'))
  })

  afterAll(async () => {
    await limitedApp.close()
    await limited.drop()
  })

  async function rejectedCount(purpose: string): Promise<number> {
    return limited.query(async client => (await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_events WHERE action = \'auth.link_rejected\' AND details->>\'purpose\' = $1',
      [purpose],
    )).rows[0]?.count ?? 0)
  }

  async function issueInvitation(username: string): Promise<string> {
    const response = await asUser(limitedApp.baseUrl, boss, '/api/admin/invitations', { method: 'POST', body: { username, displayName: username } })
    expect(response.status, await response.clone().text()).toBe(201)
    return tokenOf(parseExact(issuedInvitationSchema, await response.json()).url)
  }

  /** 让这条邀请过期（到期时间改到昨天） */
  async function expire(token: string): Promise<void> {
    await limited.query(async client => client.query('UPDATE auth_invitations SET created_at = now() - interval \'8 days\', expires_at = now() - interval \'1 day\' WHERE token_hash = $1', [tokenDigest(token)]))
  }

  async function issueReset(username: string): Promise<string> {
    const person = await createAccount(limited, { username })
    const response = await asUser(limitedApp.baseUrl, boss, `/api/admin/users/${person.id}/password-reset`, { method: 'POST' })
    expect(response.status, await response.clone().text()).toBe(201)
    return tokenOf(parseExact(issuedPasswordResetSchema, await response.json()).url)
  }

  it('令牌可用就退回名额：同一个地址先查看、接受、完成若干次，再连续用错令牌，仍到第 3 次才锁定（429）；锁定期间不写审计；登录不受影响（计数分开）', async () => {
    const invitation = await issueInvitation('newbie')
    const reset = await issueReset('someone')
    // 可用的尝试：比上限还多，名额都退回了（审查 A5）
    for (let attempt = 0; attempt < 4; attempt += 1)
      expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: invitation })).status).toBe(200)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/accept', { token: invitation, displayName: '新人', password: 'a good long password' })).status).toBe(200)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/complete', { token: reset, password: 'someone new password' })).status).toBe(200)

    const before = await rejectedCount('invitation')
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'B'.repeat(43) })).status).toBe(410)
    const third = await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'B'.repeat(43) })
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).not.toBeNull()
    expect(await rejectedCount('invitation')).toBe(before + 3)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'B'.repeat(43) })).status).toBe(429)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/complete', { token: 'B'.repeat(43), password: 'whatever long password' })).status).toBe(429)
    // 锁定期间只记日志，不写审计（审查 A5）
    expect(await rejectedCount('invitation')).toBe(before + 3)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/login', { username: 'someone', password: 'someone new password' })).status).toBe(200)
  })

  // 四个公开接口各自都经限流（M2-P6 复核 S-1）：没有这个令牌算一次失败，到上限的那一次 429，锁定期间直接 429、不写审计
  it.each([
    ['查看邀请', '/api/auth/invitations/inspect', 'invitation', {}],
    ['接受邀请', '/api/auth/invitations/accept', 'invitation', { displayName: '新人', password: 'a good long password' }],
    ['查看重置链接', '/api/auth/password-resets/inspect', 'password_reset', {}],
    ['完成重置', '/api/auth/password-resets/complete', 'password_reset', { password: 'a good long password' }],
  ] as const)('%s：没有这个令牌的尝试计入失败，第 3 次 429；锁定期间 429 且不写审计', async (_name, path, purpose, body) => {
    const before = await rejectedCount(purpose)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await postPublic(limitedApp.baseUrl, path, { token: 'C'.repeat(43), ...body })
      expect(await linkInvalidReasonOf(response)).toBe('invalid')
    }
    const third = await postPublic(limitedApp.baseUrl, path, { token: 'C'.repeat(43), ...body })
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await rejectedCount(purpose)).toBe(before + 3)

    const locked = await postPublic(limitedApp.baseUrl, path, { token: 'C'.repeat(43), ...body })
    expect(locked.status).toBe(429)
    expect(await rejectedCount(purpose)).toBe(before + 3)
  })

  it('同一个来源反复打开过期的真实邀请链接：一直是 410（expired），不计入按地址的失败，不影响它打开有效的链接（M2-P6 复核 B3）', async () => {
    const stale = await issueInvitation('stale-invite')
    await expire(stale)
    const fresh = await issueInvitation('fresh-invite')
    const before = await rejectedCount('invitation')
    // 比按地址的上限（3）多、比按记录的上限（6）少：查看与接受交替着来
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = attempt % 2 === 0
        ? await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: stale })
        : await postPublic(limitedApp.baseUrl, '/api/auth/invitations/accept', { token: stale, displayName: '旧链接', password: 'a good long password' })
      expect(await linkInvalidReasonOf(response)).toBe('expired')
    }
    // 每一次仍然记审计（找到了记录，没到按记录的上限）
    expect(await rejectedCount('invitation')).toBe(before + 5)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: fresh })).status).toBe(200)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/accept', { token: fresh, displayName: '新链接', password: 'a good long password' })).status).toBe(200)
  })

  it('同一个来源反复打开已经用过的真实重置链接：一直是 410（used），不计入按地址的失败；没有这个令牌的尝试照样计数（M2-P6 复核 B3）', async () => {
    const used = await issueReset('used-reset')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/complete', { token: used, password: 'used reset new password' })).status).toBe(200)
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await linkInvalidReasonOf(await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/inspect', { token: used }))).toBe('used')
    const valid = await issueReset('valid-reset')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/inspect', { token: valid })).status).toBe(200)
    // 猜令牌仍然计数：两次失败之后第 3 次锁定
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await linkInvalidReasonOf(await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/inspect', { token: 'D'.repeat(43) }))).toBe('invalid')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/inspect', { token: 'D'.repeat(43) })).status).toBe(429)
  })

  // 同一条"找到了但不能用"的链接按记录计数（M2-P6）：拿着真实的旧链接反复打开，到上限之后这条链接 429、只记日志，审计表写不爆
  it('同一条过期的邀请链接反复打开：第 6 次 429（照样记审计），之后 429、只记日志、不再增加审计行；同一个来源打开别的链接不受影响', async () => {
    const stale = await issueInvitation('stale-many')
    await expire(stale)
    const otherStale = await issueInvitation('stale-other')
    await expire(otherStale)
    const fresh = await issueInvitation('fresh-many')
    const before = await rejectedCount('invitation')
    for (let attempt = 1; attempt <= 5; attempt += 1)
      expect(await linkInvalidReasonOf(await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: stale })), `第 ${attempt} 次`).toBe('expired')
    const sixth = await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: stale })
    expect(sixth.status).toBe(429)
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await rejectedCount('invitation')).toBe(before + 6)
    const logged = () => limitedApp.logs.entries().filter(entry => entry.msg === '同一条一次性链接反复被打开，这条链接暂时一律拒绝').length
    const loggedBefore = logged()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: stale })).status).toBe(429)
      expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/accept', { token: stale, displayName: '旧链接', password: 'a good long password' })).status).toBe(429)
    }
    expect(await rejectedCount('invitation')).toBe(before + 6)
    expect(logged()).toBe(loggedBefore + 6)
    // 别的链接各算各的：另一条过期的仍是 410 与原因，有效的照常可用；这个来源用错令牌仍按地址计数，没有被连累
    expect(await linkInvalidReasonOf(await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: otherStale }))).toBe('expired')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: fresh })).status).toBe(200)
    expect(await linkInvalidReasonOf(await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'E'.repeat(43) }))).toBe('invalid')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/accept', { token: fresh, displayName: '新链接', password: 'a good long password' })).status).toBe(200)
  })

  it('同一条用过的重置链接反复完成：到上限之后 429、不再写审计；别的重置链接不受影响', async () => {
    const used = await issueReset('used-many')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/complete', { token: used, password: 'used many new password' })).status).toBe(200)
    const before = await rejectedCount('password_reset')
    for (let attempt = 1; attempt <= 5; attempt += 1)
      expect(await linkInvalidReasonOf(await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/complete', { token: used, password: 'whatever long password' }))).toBe('used')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/complete', { token: used, password: 'whatever long password' })).status).toBe(429)
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/inspect', { token: used })).status).toBe(429)
    expect(await rejectedCount('password_reset')).toBe(before + 6)
    const again = await issueReset('used-many-2')
    expect((await postPublic(limitedApp.baseUrl, '/api/auth/password-resets/inspect', { token: again })).status).toBe(200)
  })
})

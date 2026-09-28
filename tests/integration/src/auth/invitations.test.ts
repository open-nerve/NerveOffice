// 邀请注册（M2-P1 设计 §3.4，US-M2-01）：签发、查看、接受（建账户与个人空间、登录）、作废、重发、过期、并发、尝试限流、审计。
import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { errorResponseSchema, inspectLinkResponseSchema, invitationListResponseSchema, invitationSchema, issuedInvitationSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { linkInvalidReasonOf, postPublic, tokenDigest, tokenOf } from '../support/links.ts'
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

async function invite(username: string, displayName = username, requestId?: string) {
  const response = await asUser(app.baseUrl, adminSession, '/api/admin/invitations', {
    method: 'POST',
    body: { username, displayName },
    headers: requestId === undefined ? {} : { 'x-request-id': requestId },
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const issued = parseExact(issuedInvitationSchema, await response.json())
  return { ...issued, token: tokenOf(issued.url) }
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
    const issued = await invite('amy', '艾米', 'invite-amy')
    expect(issued.url).toBe(`http://127.0.0.1:4100/invite#${issued.token}`)
    expect(issued.token).toMatch(/^[\w-]{43}$/)
    expect(issued.invitation).toMatchObject({ username: 'amy', displayName: '艾米', status: 'pending', createdBy: { id: admin.id, username: 'root' } })
    const [row] = await database.query(async client => (await client.query<{ token_hash: Buffer }>('SELECT token_hash FROM auth_invitations WHERE id = $1', [issued.invitation.id])).rows)
    expect(row?.token_hash.equals(tokenDigest(issued.token))).toBe(true)
    expect(await auditRows('request_id = $1', ['invite-amy'])).toEqual([
      { action: 'users.invited', actor_type: 'user', actor_id: admin.id, target_type: 'invitation', target_id: issued.invitation.id, details: { username: 'amy' } },
    ])
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
    expect(second.invitation).toMatchObject({ username: 'jon', displayName: '乔恩', status: 'pending' })
    expect(await linkInvalidReasonOf(await inspect(first.token))).toBe('revoked')
    expect((await accept(tokenOf(second.url))).status).toBe(200)
    const again = await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${second.invitation.id}/reissue`, { method: 'POST' })
    expect(await codeOf(again)).toBe('USERNAME_TAKEN')
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
  it('同一个令牌并发接受两次：只有一次成功，只建了一个账户', async () => {
    const issued = await invite('kim')
    const [a, b] = await Promise.all([accept(issued.token, '金'), accept(issued.token, '金')])
    expect([a.status, b.status].sort()).toEqual([200, 410])
    const [count] = await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM users WHERE username = \'kim\'')).rows)
    expect(count).toEqual({ count: 1 })
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

describe('US-M2-01 一次性链接的尝试限流', () => {
  it('同一个地址连续用错令牌达到上限后被锁定（429）；登录不受影响（计数分开）', async () => {
    const limited = await createTestDatabase()
    const limitedApp = await startTestApp({ databaseUrl: limited.url, env: { NERVE_LOGIN_IP_MAX_FAILURES: '3' } })
    try {
      const person = await createAccount(limited, { username: 'someone' })
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'B'.repeat(43) })).status).toBe(410)
      const third = await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'B'.repeat(43) })
      expect(third.status).toBe(429)
      expect(third.headers.get('retry-after')).not.toBeNull()
      expect((await postPublic(limitedApp.baseUrl, '/api/auth/invitations/inspect', { token: 'B'.repeat(43) })).status).toBe(429)
      expect((await postPublic(limitedApp.baseUrl, '/api/auth/login', { username: 'someone', password: person.password })).status).toBe(200)
    }
    finally {
      await limitedApp.close()
      await limited.drop()
    }
  })
})

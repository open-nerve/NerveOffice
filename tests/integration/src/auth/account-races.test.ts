// 改动账户的并发（M2-P1 审查 A1、A2、A9、A10、A12）：验证在事务之外，事务里先锁账户行再复核；锁的顺序统一，互相等待时不成环。
// 用两个连接构造确定的交错：一个连接持锁，等被测的请求在锁上等着了，再改数据、提交（support/held-lock.ts）。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { errorResponseSchema, issuedInvitationSchema, issuedPasswordResetSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, passwordHashOf } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { linkInvalidReasonOf, postPublic, tokenDigest, tokenOf } from '../support/links.ts'
import { asUser, login, postLogin } from '../support/session-client.ts'

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

async function one<T extends Record<string, unknown>>(query: string, values: unknown[]): Promise<T | undefined> {
  return database.query(async client => (await client.query<T>(query, values)).rows[0])
}

async function count(query: string, values: unknown[]): Promise<number> {
  return (await one<{ count: number }>(query, values))?.count ?? 0
}

async function passwordHashOfAccount(account: TestAccount): Promise<string | undefined> {
  return (await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [account.id]))?.password_hash
}

async function issueReset(account: TestAccount): Promise<Response> {
  return asUser(app.baseUrl, adminSession, `/api/admin/users/${account.id}/password-reset`, { method: 'POST' })
}

async function issuedResetToken(account: TestAccount): Promise<string> {
  const response = await issueReset(account)
  expect(response.status, await response.clone().text()).toBe(201)
  return tokenOf(parseExact(issuedPasswordResetSchema, await response.json()).url)
}

async function completeReset(token: string, headers: Record<string, string> = {}): Promise<Response> {
  return postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token, password: 'the new long password' }, headers)
}

async function invite(username: string): Promise<Response> {
  return asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username, displayName: username } })
}

async function issuedInvitation(username: string) {
  const response = await invite(username)
  expect(response.status, await response.clone().text()).toBe(201)
  const issued = parseExact(issuedInvitationSchema, await response.json())
  return { id: issued.invitation.id, token: tokenOf(issued.url) }
}

/** 持有账户行的锁：与改动账户的事务第一步取的锁相同（FOR NO KEY UPDATE） */
function lockAccountRow(account: TestAccount) {
  return async (client: pg.Client) => client.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [account.id])
}

describe('US-M2-02 登录与修改密码：验证之后、提交之前的变化（审查 A1）', () => {
  it('登录验证过密码之后，别处改了密码：按凭据无效处理，不建会话，记审计', async () => {
    const amy = await createAccount(database, { username: 'amy' })
    const changed = await passwordHashOf('changed elsewhere')
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(amy),
      request: async () => postLogin(app.baseUrl, { username: 'amy', password: amy.password }, { 'x-request-id': 'race-login-amy' }),
      change: async client => client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [changed, amy.id]),
    })
    expect(response.status).toBe(401)
    expect(await codeOf(response)).toBe('INVALID_CREDENTIALS')
    expect(await count('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1', [amy.id])).toBe(0)
    expect(await one('SELECT action, target_id FROM audit_events WHERE request_id = \'race-login-amy\'', [])).toEqual({ action: 'auth.login_failed', target_id: amy.id })
  })

  it('登录验证过密码之后，账户被停用：同样不建会话', async () => {
    const bea = await createAccount(database, { username: 'bea' })
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(bea),
      request: async () => postLogin(app.baseUrl, { username: 'bea', password: bea.password }),
      change: async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [bea.id]),
    })
    expect(await codeOf(response)).toBe('INVALID_CREDENTIALS')
    expect(await count('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1', [bea.id])).toBe(0)
  })

  it('修改密码验证过旧密码之后，别处改了密码（例如签发了重置）：403，不覆盖别处设的密码，记审计', async () => {
    const cid = await createAccount(database, { username: 'cid' })
    const here = await login(app.baseUrl, 'cid', cid.password)
    const changed = await passwordHashOf('changed elsewhere')
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(cid),
      request: async () => asUser(app.baseUrl, here, '/api/auth/password', { method: 'PUT', body: { currentPassword: cid.password, newPassword: 'cid wants this one' } }),
      change: async client => client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [changed, cid.id]),
    })
    expect(response.status).toBe(403)
    expect(await codeOf(response)).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(await passwordHashOfAccount(cid)).toBe(changed)
    expect(await count('SELECT count(*)::int AS count FROM audit_events WHERE action = \'users.password_change_failed\' AND target_id = $1', [cid.id])).toBe(1)
  })
})

describe('US-M2-03 重置密码：锁的顺序与事务里的复核（审查 A2、A10）', () => {
  it('同一个账户并发签发（双击、两个管理员）：在账户行上排队，都成功，只有后签发的一条可用（不再撞唯一索引变成 500）', async () => {
    const dan = await createAccount(database, { username: 'dan' })
    // 两个签发都走到锁上再放开：不锁账户行时，两边各插一条未用的重置，后一个撞上部分唯一索引
    const responses = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(dan),
      request: async () => Promise.all([issueReset(dan), issueReset(dan)]),
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status)).toEqual([201, 201])
    const tokens = await Promise.all(responses.map(async response => tokenOf(parseExact(issuedPasswordResetSchema, await response.json()).url)))
    expect(await count('SELECT count(*)::int AS count FROM auth_password_resets WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [dan.id])).toBe(1)
    const inspected = await Promise.all(tokens.map(async token => (await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token })).status))
    expect(inspected.sort()).toEqual([200, 410])
  })

  it('签发时账户刚被停用：409 ACCOUNT_DISABLED，不留下未用的重置，密码不变', async () => {
    const eve = await createAccount(database, { username: 'eve' })
    const before = await passwordHashOfAccount(eve)
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(eve),
      request: async () => issueReset(eve),
      change: async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [eve.id]),
    })
    expect(await codeOf(response)).toBe('ACCOUNT_DISABLED')
    expect(await count('SELECT count(*)::int AS count FROM auth_password_resets WHERE user_id = $1', [eve.id])).toBe(0)
    expect(await passwordHashOfAccount(eve)).toBe(before)
  })

  it('完成重置时账户刚被停用：410（revoked），不改密码，记审计 auth.link_rejected（对象是这个账户）', async () => {
    const fay = await createAccount(database, { username: 'fay' })
    const token = await issuedResetToken(fay)
    const before = await passwordHashOfAccount(fay)
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(fay),
      request: async () => completeReset(token, { 'x-request-id': 'race-complete-fay' }),
      change: async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [fay.id]),
    })
    expect(await linkInvalidReasonOf(response)).toBe('revoked')
    expect(await passwordHashOfAccount(fay)).toBe(before)
    expect(await one('SELECT action, actor_type, target_type, target_id, details FROM audit_events WHERE request_id = \'race-complete-fay\'', [])).toEqual({
      action: 'auth.link_rejected',
      actor_type: 'anonymous',
      target_type: 'user',
      target_id: fay.id,
      details: { purpose: 'password_reset', reason: 'revoked' },
    })
  })

  it('完成重置时这个链接刚被别处用掉：410（used），记审计', async () => {
    const gil = await createAccount(database, { username: 'gil' })
    const token = await issuedResetToken(gil)
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(gil),
      request: async () => completeReset(token, { 'x-request-id': 'race-complete-gil' }),
      change: async client => client.query('UPDATE auth_password_resets SET used_at = now() WHERE token_hash = $1', [tokenDigest(token)]),
    })
    expect(await linkInvalidReasonOf(response)).toBe('used')
    expect(await one('SELECT details FROM audit_events WHERE request_id = \'race-complete-gil\'', [])).toEqual({ details: { purpose: 'password_reset', reason: 'used' } })
    expect(await count('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1', [gil.id])).toBe(0)
  })
})

describe('US-M2-04 停用与会话、操作者的复核（审查 A1、A2、A12）', () => {
  it('会话守卫发现账户已停用：撤销这条会话（disabled），启用之后它也不能再用', async () => {
    const hal = await createAccount(database, { username: 'hal' })
    const session = await login(app.baseUrl, 'hal', hal.password)
    // 直接改状态、不撤销会话：模拟并发留下的会话
    await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [hal.id]))
    const rejected = await asUser(app.baseUrl, session, '/api/auth/session')
    expect(rejected.status).toBe(401)
    expect(await codeOf(rejected)).toBe('SESSION_EXPIRED')
    expect(await one('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1', [hal.id])).toEqual({ revoked_reason: 'disabled' })
    await database.query(async client => client.query('UPDATE users SET status = \'active\' WHERE id = $1', [hal.id]))
    expect((await asUser(app.baseUrl, session, '/api/auth/session')).status).toBe(401)
  })

  it('操作者在取到锁之前被取消了系统管理员：403，目标账户不变', async () => {
    const boss = await createAccount(database, { username: 'boss', systemRole: 'admin' })
    const bossSession = await login(app.baseUrl, 'boss', boss.password)
    const ivy = await createAccount(database, { username: 'ivy' })
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:system-admins\', 0))'),
      request: async () => asUser(app.baseUrl, bossSession, `/api/admin/users/${ivy.id}/disable`, { method: 'POST' }),
      change: async client => client.query('UPDATE users SET system_role = \'member\' WHERE id = $1', [boss.id]),
    })
    expect(response.status).toBe(403)
    expect(await codeOf(response)).toBe('PERMISSION_DENIED')
    expect(await one('SELECT status FROM users WHERE id = $1', [ivy.id])).toEqual({ status: 'active' })
  })

  it('停用、启用、签发重置与带着这个账户旧 Cookie 的重新登录同时进行：不互相死锁（没有 5xx）', async () => {
    const jon = await createAccount(database, { username: 'jon' })
    const knownHash = await passwordHashOf(jon.password)
    for (let round = 0; round < 6; round += 1) {
      await database.query(async client => client.query('UPDATE users SET status = \'active\', password_hash = $1 WHERE id = $2', [knownHash, jon.id]))
      const previous = await login(app.baseUrl, 'jon', jon.password)
      const statuses = (await Promise.all([
        postLogin(app.baseUrl, { username: 'jon', password: jon.password }, { cookie: previous.cookie }),
        asUser(app.baseUrl, adminSession, `/api/admin/users/${jon.id}/disable`, { method: 'POST' }),
        issueReset(jon),
        asUser(app.baseUrl, adminSession, `/api/admin/users/${jon.id}/enable`, { method: 'POST' }),
      ])).map(response => response.status)
      expect(statuses.every(status => status < 500), `第 ${round + 1} 轮：${statuses.join(', ')}`).toBe(true)
    }
  })
})

describe('US-M2-01 邀请：作废与接受的并发（审查 A9、A10）', () => {
  it('签发时自动作废过期的旧邀请，同时管理员作废了它：只作废一次，签发不再记一次作废', async () => {
    const old = await issuedInvitation('kit')
    await database.query(async client => client.query('UPDATE auth_invitations SET created_at = now() - interval \'8 days\', expires_at = now() - interval \'1 day\' WHERE id = $1', [old.id]))
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM auth_invitations WHERE id = $1 FOR UPDATE', [old.id]),
      request: async () => invite('kit'),
      change: async client => client.query('UPDATE auth_invitations SET revoked_at = now(), revoked_by = $1 WHERE id = $2', [admin.id, old.id]),
    })
    expect(response.status).toBe(201)
    // 持锁的一方（模拟手动作废）没有记审计；签发更新不到行，也不记
    expect(await count('SELECT count(*)::int AS count FROM audit_events WHERE action = \'users.invitation_revoked\' AND target_id = $1', [old.id])).toBe(0)
  })

  it('接受时邀请刚被作废：410（revoked），不建账户，记审计 auth.link_rejected（对象是邀请）', async () => {
    const issued = await issuedInvitation('lea')
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM auth_invitations WHERE id = $1 FOR UPDATE', [issued.id]),
      request: async () => postPublic(app.baseUrl, '/api/auth/invitations/accept', { token: issued.token, displayName: '莉亚', password: 'a good long password' }, { 'x-request-id': 'race-accept-lea' }),
      change: async client => client.query('UPDATE auth_invitations SET revoked_at = now(), revoked_by = $1 WHERE id = $2', [admin.id, issued.id]),
    })
    expect(await linkInvalidReasonOf(response)).toBe('revoked')
    expect(await count('SELECT count(*)::int AS count FROM users WHERE username = \'lea\'', [])).toBe(0)
    expect(await one('SELECT action, target_type, target_id, details FROM audit_events WHERE request_id = \'race-accept-lea\'', [])).toEqual({
      action: 'auth.link_rejected',
      target_type: 'invitation',
      target_id: issued.id,
      details: { purpose: 'invitation', reason: 'revoked' },
    })
  })
})

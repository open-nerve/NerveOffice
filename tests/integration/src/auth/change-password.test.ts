// 修改密码（M2-P1 设计 §3.5，US-M2-02）：旧密码、本人的全部会话撤销而当前页面换上新的会话（M2-P6 复核 B1）、审计（含失败）、
// 与登录共用的限流。验证旧密码之后别处改了密码的并发，见 account-races.test.ts。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { createHash } from 'node:crypto'
import { errorResponseSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { requestIdOf } from '../support/request-id.ts'
import { asUser, cookieValue, login, postLogin, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  // 按用户名与来源 3 次失败就锁定（用例都来自本机）：猜旧密码与猜登录密码按同一套计数；换来源的情形见 login-lockout.test.ts
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_LOGIN_MAX_FAILURES: '3' } })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

async function changePassword(user: LoggedIn, currentPassword: string, newPassword: string): Promise<Response> {
  return asUser(app.baseUrl, user, '/api/auth/password', { method: 'PUT', body: { currentPassword, newPassword } })
}

/** 改密码成功的响应里的新会话：新的 Cookie 与新的 CSRF 令牌（与登录的响应相同） */
async function renewedSession(response: Response): Promise<LoggedIn> {
  const setCookie = sessionSetCookie(response)
  if (setCookie === undefined)
    throw new Error('改密码成功却没有写回会话 Cookie')
  return { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}`, session: parseExact(sessionResponseSchema, await response.json()) }
}

async function sessionsOf(account: TestAccount) {
  return database.query(async client => (await client.query<{ revoked_reason: string | null }>('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1 ORDER BY created_at, id', [account.id])).rows)
}

async function auditOf(response: Response) {
  return database.query(async client => (await client.query<{ action: string, actor_id: string, target_id: string, details: Record<string, unknown> }>(
    'SELECT action, actor_id, target_id, details FROM audit_events WHERE request_id = $1',
    [requestIdOf(response)],
  )).rows)
}

describe('US-M2-02 修改密码', () => {
  it('成功：本人的全部会话撤销（包括当前这个），当前页面换上新的会话、照常可用；新密码能登录、旧密码不能；记审计，不含密码', async () => {
    const alice = await createAccount(database, { username: 'alice' })
    const here = await login(app.baseUrl, 'alice', alice.password)
    const elsewhere = await login(app.baseUrl, 'alice', alice.password)

    const response = await changePassword(here, alice.password, 'a brand new password')
    expect(response.status).toBe(200)
    const renewed = await renewedSession(response)
    // 当前页面：新的 Cookie 与新的 CSRF 令牌，账户不变
    expect(renewed.session.user).toMatchObject({ id: alice.id, username: 'alice' })
    expect(renewed.cookie).not.toBe(here.cookie)
    expect(renewed.session.csrfToken).not.toBe(here.session.csrfToken)
    expect((await asUser(app.baseUrl, renewed, '/api/auth/session')).status).toBe(200)
    // 新会话能做状态变更（新的 CSRF 令牌生效）
    expect((await asUser(app.baseUrl, renewed, '/api/auth/logout', { method: 'POST' })).status).toBe(204)

    // 旧的会话令牌从此无效：当前页面原来的这个，与别处的那个（M2-P6 复核 B1：偷到 Cookie 的人不能接着用）
    for (const old of [here, elsewhere]) {
      const kicked = await asUser(app.baseUrl, old, '/api/auth/session')
      expect(kicked.status).toBe(401)
      expect(await codeOf(kicked)).toBe('SESSION_EXPIRED')
    }
    // 三条会话：原来的两条随改密码撤销，新建的那条（当前页面）随后退出
    expect(await sessionsOf(alice)).toEqual([{ revoked_reason: 'password_changed' }, { revoked_reason: 'password_changed' }, { revoked_reason: 'logout' }])
    // 库里存的是新令牌的摘要
    const digest = createHash('sha256').update(renewed.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
    expect(await database.query(async client => (await client.query('SELECT 1 FROM auth_sessions WHERE token_hash = $1 AND user_id = $2', [digest, alice.id])).rowCount)).toBe(1)

    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(401)
    expect((await postLogin(app.baseUrl, { username: 'alice', password: 'a brand new password' })).status).toBe(200)
    expect(await auditOf(response)).toEqual([{ action: 'users.password_changed', actor_id: alice.id, target_id: alice.id, details: {} }])
  })

  it('旧密码不对：403 CURRENT_PASSWORD_INCORRECT，密码与会话都不变，不换 Cookie；记审计（审查 A6），不含密码', async () => {
    const bob = await createAccount(database, { username: 'bob' })
    const here = await login(app.baseUrl, 'bob', bob.password)
    const elsewhere = await login(app.baseUrl, 'bob', bob.password)
    const response = await changePassword(here, 'not my password', 'another new password')
    expect(response.status).toBe(403)
    expect(sessionSetCookie(response)).toBeUndefined()
    expect(await codeOf(response)).toBe('CURRENT_PASSWORD_INCORRECT')
    expect((await asUser(app.baseUrl, here, '/api/auth/session')).status).toBe(200)
    expect((await asUser(app.baseUrl, elsewhere, '/api/auth/session')).status).toBe(200)
    expect((await postLogin(app.baseUrl, { username: 'bob', password: bob.password })).status).toBe(200)
    expect(await auditOf(response)).toEqual([{ action: 'users.password_change_failed', actor_id: bob.id, target_id: bob.id, details: { reason: 'current_password_incorrect' } }])
  })

  it('新密码不符合规则：400 REQUEST_INVALID', async () => {
    const carol = await createAccount(database, { username: 'carol' })
    const here = await login(app.baseUrl, 'carol', carol.password)
    const response = await changePassword(here, carol.password, 'short')
    expect(response.status).toBe(400)
    expect(await codeOf(response)).toBe('REQUEST_INVALID')
  })

  it('猜旧密码与猜登录密码按同一套计数：同一个来源连续猜错达到上限后，这个来源的修改密码与登录都被锁定', async () => {
    const dave = await createAccount(database, { username: 'dave' })
    const here = await login(app.baseUrl, 'dave', dave.password)
    expect(await codeOf(await changePassword(here, 'guess-1', 'another new password'))).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(await codeOf(await changePassword(here, 'guess-2', 'another new password'))).toBe('CURRENT_PASSWORD_INCORRECT')
    const third = await changePassword(here, 'guess-3', 'another new password')
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).not.toBeNull()
    // 管理员能从审计里查到这个人为什么登录不了：触发锁定的那次失败带着锁定秒数
    const [locking] = await auditOf(third)
    expect(locking?.details.lockedForSeconds).toBeGreaterThan(0)
    expect(await codeOf(await changePassword(here, dave.password, 'another new password'))).toBe('TOO_MANY_ATTEMPTS')
    expect(await codeOf(await postLogin(app.baseUrl, { username: 'dave', password: dave.password }))).toBe('TOO_MANY_ATTEMPTS')
  })

  it('没有登录：401；缺少 CSRF 令牌：403', async () => {
    const erin = await createAccount(database, { username: 'erin' })
    const anonymous = await fetch(`${app.baseUrl}/api/auth/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'origin': 'http://127.0.0.1:4100' },
      body: JSON.stringify({ currentPassword: 'x', newPassword: 'a brand new password' }),
    })
    expect(anonymous.status).toBe(401)
    const here = await login(app.baseUrl, 'erin', erin.password)
    const noToken = await asUser(app.baseUrl, here, '/api/auth/password', { method: 'PUT', body: { currentPassword: erin.password, newPassword: 'a brand new password' }, headers: { 'x-csrf-token': undefined } })
    expect(noToken.status).toBe(403)
    expect(await codeOf(noToken)).toBe('CSRF_TOKEN_INVALID')
  })
})

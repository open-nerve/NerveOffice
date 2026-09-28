// 修改密码（M2-P1 设计 §3.5，US-M2-02）：旧密码、其他会话全部撤销而当前会话保留、审计（含失败）、与登录共用的限流。
// 验证旧密码之后别处改了密码的并发，见 account-races.test.ts。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login, postLogin } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  // 用户名维度 3 次失败就锁定：猜旧密码与猜登录密码按同一个计数
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_LOGIN_MAX_FAILURES: '3' } })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

async function changePassword(user: Awaited<ReturnType<typeof login>>, currentPassword: string, newPassword: string, requestId?: string): Promise<Response> {
  return asUser(app.baseUrl, user, '/api/auth/password', {
    method: 'PUT',
    body: { currentPassword, newPassword },
    headers: requestId === undefined ? {} : { 'x-request-id': requestId },
  })
}

async function sessionsOf(account: TestAccount) {
  return database.query(async client => (await client.query<{ revoked_reason: string | null }>('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1 ORDER BY created_at', [account.id])).rows)
}

describe('US-M2-02 修改密码', () => {
  it('成功：204；本人其他地方的登录全部退出，当前页面保持登录；新密码能登录、旧密码不能；记审计，不含密码', async () => {
    const alice = await createAccount(database, { username: 'alice' })
    const here = await login(app.baseUrl, 'alice', alice.password)
    const elsewhere = await login(app.baseUrl, 'alice', alice.password)

    const response = await changePassword(here, alice.password, 'a brand new password', 'change-1')
    expect(response.status).toBe(204)
    expect((await asUser(app.baseUrl, here, '/api/auth/session')).status).toBe(200)
    const kicked = await asUser(app.baseUrl, elsewhere, '/api/auth/session')
    expect(kicked.status).toBe(401)
    expect(await codeOf(kicked)).toBe('SESSION_EXPIRED')
    expect(await sessionsOf(alice)).toEqual([{ revoked_reason: null }, { revoked_reason: 'password_changed' }])

    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(401)
    expect((await postLogin(app.baseUrl, { username: 'alice', password: 'a brand new password' })).status).toBe(200)

    const events = await database.query(async client => (await client.query<{ action: string, actor_id: string, target_id: string, details: unknown }>(
      'SELECT action, actor_id, target_id, details FROM audit_events WHERE request_id = \'change-1\'',
    )).rows)
    expect(events).toEqual([{ action: 'users.password_changed', actor_id: alice.id, target_id: alice.id, details: {} }])
  })

  it('旧密码不对：403 CURRENT_PASSWORD_INCORRECT，密码与会话都不变；记审计（审查 A6），不含密码', async () => {
    const bob = await createAccount(database, { username: 'bob' })
    const here = await login(app.baseUrl, 'bob', bob.password)
    const elsewhere = await login(app.baseUrl, 'bob', bob.password)
    const response = await changePassword(here, 'not my password', 'another new password', 'change-wrong')
    expect(response.status).toBe(403)
    expect(await codeOf(response)).toBe('CURRENT_PASSWORD_INCORRECT')
    expect((await asUser(app.baseUrl, elsewhere, '/api/auth/session')).status).toBe(200)
    expect((await postLogin(app.baseUrl, { username: 'bob', password: bob.password })).status).toBe(200)
    const events = await database.query(async client => (await client.query<{ action: string, actor_id: string, target_id: string, details: unknown }>(
      'SELECT action, actor_id, target_id, details FROM audit_events WHERE request_id = \'change-wrong\'',
    )).rows)
    expect(events).toEqual([{ action: 'users.password_change_failed', actor_id: bob.id, target_id: bob.id, details: { reason: 'current_password_incorrect' } }])
  })

  it('新密码不符合规则：400 REQUEST_INVALID', async () => {
    const carol = await createAccount(database, { username: 'carol' })
    const here = await login(app.baseUrl, 'carol', carol.password)
    const response = await changePassword(here, carol.password, 'short')
    expect(response.status).toBe(400)
    expect(await codeOf(response)).toBe('REQUEST_INVALID')
  })

  it('猜旧密码与猜登录密码按同一个计数：连续猜错达到上限后，修改密码与登录都被锁定', async () => {
    const dave = await createAccount(database, { username: 'dave' })
    const here = await login(app.baseUrl, 'dave', dave.password)
    expect(await codeOf(await changePassword(here, 'guess-1', 'another new password'))).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(await codeOf(await changePassword(here, 'guess-2', 'another new password'))).toBe('CURRENT_PASSWORD_INCORRECT')
    const third = await changePassword(here, 'guess-3', 'another new password', 'change-locking')
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).not.toBeNull()
    // 管理员能从审计里查到这个人为什么登录不了：触发锁定的那次失败带着锁定秒数
    const [locking] = await database.query(async client => (await client.query<{ details: { lockedForSeconds?: number } }>(
      'SELECT details FROM audit_events WHERE request_id = \'change-locking\'',
    )).rows)
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

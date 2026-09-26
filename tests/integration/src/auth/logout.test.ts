import type { TestAccount } from '../support/accounts.ts'
// 退出（P3 设计 §3.5，US-M1-02）：撤销会话、清除 Cookie、审计；CSRF 令牌与 Origin 检查。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash } from 'node:crypto'
import { CSRF_TOKEN_HEADER, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'alice' })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

describe('US-M1-02 退出', () => {
  it('成功：204，清除 Cookie，会话撤销（logout），记审计；之后这个会话不能再用', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    const response = await asUser(app.baseUrl, user, '/api/auth/logout', { method: 'POST', headers: { 'x-request-id': 'logout-1' } })
    expect(response.status).toBe(204)
    expect(sessionSetCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970/)

    const digest = createHash('sha256').update(user.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
    const [session] = await database.query(async client => (await client.query<{ revoked_reason: string, revoked: boolean }>('SELECT revoked_reason, revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE token_hash = $1', [digest])).rows)
    expect(session).toEqual({ revoked_reason: 'logout', revoked: true })
    const [audit] = await database.query(async client => (await client.query<{ action: string, actor_type: string, actor_id: string }>('SELECT action, actor_type, actor_id FROM audit_events WHERE request_id = \'logout-1\'')).rows)
    expect(audit).toEqual({ action: 'auth.logout', actor_type: 'user', actor_id: alice.id })

    const after = await asUser(app.baseUrl, user, '/api/auth/session')
    expect(after.status).toBe(401)
    expect(await codeOf(after)).toBe('SESSION_EXPIRED')
  })

  it('没有登录：401 UNAUTHENTICATED', async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/logout`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4100' } })
    expect(response.status).toBe(401)
    expect(await codeOf(response)).toBe('UNAUTHENTICATED')
  })

  it('缺少或带错了 CSRF 令牌：403 CSRF_TOKEN_INVALID，会话不受影响', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    const other = await login(app.baseUrl, 'alice', alice.password)
    for (const token of [undefined, 'wrong', other.session.csrfToken]) {
      const response = await asUser(app.baseUrl, user, '/api/auth/logout', { method: 'POST', headers: { [CSRF_TOKEN_HEADER]: token } })
      expect(response.status, String(token)).toBe(403)
      expect(await codeOf(response)).toBe('CSRF_TOKEN_INVALID')
    }
    expect((await asUser(app.baseUrl, user, '/api/auth/session')).status).toBe(200)
  })

  it('Origin 缺少或不是本站：403 ORIGIN_NOT_ALLOWED，即使 CSRF 令牌正确', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    for (const origin of [undefined, 'https://evil.example']) {
      const response = await asUser(app.baseUrl, user, '/api/auth/logout', { method: 'POST', headers: { origin } })
      expect(response.status, String(origin)).toBe(403)
      expect(await codeOf(response)).toBe('ORIGIN_NOT_ALLOWED')
    }
    expect((await asUser(app.baseUrl, user, '/api/auth/session')).status).toBe(200)
  })
})

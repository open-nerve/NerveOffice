import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { createHash } from 'node:crypto'
import { errorResponseSchema, sessionExpiredDetailsSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login, postLogin, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'expiration-alice' })
})

afterAll(async () => {
  try {
    await app?.close()
  }
  finally {
    await database?.drop()
  }
})

function digestOf(session: LoggedIn) {
  return createHash('sha256').update(session.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
}

async function expiredDetails(response: Response) {
  expect(response.status).toBe(401)
  const { error } = parseExact(errorResponseSchema, await response.json())
  expect(error.code).toBe('SESSION_EXPIRED')
  expect(error.details, '会话失效应带分类；缺少详情不能视为已实现').toBeDefined()
  return parseExact(sessionExpiredDetailsSchema, error.details)
}

describe('US-M4-09 会话失效原因只给持有该登录的请求', () => {
  it.each([
    ['disabled', 'account_disabled'],
    ['password_reset', 'password_reset'],
    ['password_changed', 'password_changed'],
    ['replaced', 'replaced'],
    ['logout', 'logout'],
  ] as const)('最初撤销原因 %s → %s，并绑定原会话用户', async (stored, reason) => {
    const session = await login(app.baseUrl, alice.username, alice.password)
    const changed = await database.query(async client => client.query('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2, idle_expires_at = least(idle_expires_at, now()) WHERE token_hash = $1', [digestOf(session), stored]))
    expect(changed.rowCount).toBe(1)
    const response = await asUser(app.baseUrl, session, '/api/auth/session')
    expect(await expiredDetails(response)).toEqual({ reason, userId: alice.id })
    if (reason === 'replaced')
      expect(sessionSetCookie(response)).toBeUndefined()
    else
      expect(sessionSetCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970/)
  })

  it.each(['idle', 'absolute'] as const)('%s 自然到期带已识别的用户，不推测成停用', async (expiry) => {
    const session = await login(app.baseUrl, alice.username, alice.password)
    await database.query(async (client) => {
      if (expiry === 'idle')
        await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [digestOf(session)])
      else
        await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\', absolute_expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [digestOf(session)])
    })
    expect(await expiredDetails(await asUser(app.baseUrl, session, '/api/auth/session'))).toEqual({ reason: 'expired', userId: alice.id })
  })

  it('未知、畸形和无法解码的令牌不带任何用户事实', async () => {
    for (const token of ['a'.repeat(43), 'not-a-token', '%broken']) {
      const response = await fetch(`${app.baseUrl}/api/auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } })
      expect(await expiredDetails(response)).toEqual({ reason: 'expired' })
    }
  })

  it('记录已清理的旧令牌不再推测原用户', async () => {
    const session = await login(app.baseUrl, alice.username, alice.password)
    await database.query(async client => client.query('DELETE FROM auth_sessions WHERE token_hash = $1', [digestOf(session)]))
    expect(await expiredDetails(await asUser(app.baseUrl, session, '/api/auth/session'))).toEqual({ reason: 'expired' })
  })

  it('守卫发现账户已停用时撤销仍活着的会话，启用后旧会话也不能恢复', async () => {
    const disabled = await createAccount(database, { username: 'expiration-disabled' })
    const session = await login(app.baseUrl, disabled.username, disabled.password)
    await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [disabled.id]))
    expect(await expiredDetails(await asUser(app.baseUrl, session, '/api/auth/session'))).toEqual({ reason: 'account_disabled', userId: disabled.id })
    await database.query(async client => client.query('UPDATE users SET status = \'active\' WHERE id = $1', [disabled.id]))
    expect(await expiredDetails(await asUser(app.baseUrl, session, '/api/auth/session'))).toEqual({ reason: 'account_disabled', userId: disabled.id })
  })

  it('没有 Cookie 与停用账户的登录失败仍不暴露失效原因或用户', async () => {
    const absent = await fetch(`${app.baseUrl}/api/auth/session`)
    expect(absent.status).toBe(401)
    expect(parseExact(errorResponseSchema, await absent.json()).error).toMatchObject({ code: 'UNAUTHENTICATED' })
    const disabled = await createAccount(database, { username: 'expiration-no-disclosure' })
    await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [disabled.id]))
    const response = await postLogin(app.baseUrl, { username: disabled.username, password: disabled.password })
    expect(response.status).toBe(401)
    const { error } = parseExact(errorResponseSchema, await response.json())
    expect(error.code).toBe('INVALID_CREDENTIALS')
    expect(error.details).toBeUndefined()
  })
})

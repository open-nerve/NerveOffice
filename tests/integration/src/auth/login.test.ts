// 登录（P3 设计 §3.5，US-M1-02）：会话 Cookie 的属性、统一的错误提示、限流、Origin 检查与审计。
import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash } from 'node:crypto'
import { errorResponseSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, cookieValue, login, postLogin, sessionSetCookie } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount

beforeAll(async () => {
  database = await createTestDatabase()
  // 按用户名 3 次锁定，按地址 20 次锁定：用例里好触发
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_LOGIN_MAX_FAILURES: '3', NERVE_LOGIN_IP_MAX_FAILURES: '20' } })
  alice = await createAccount(database, { username: 'alice', displayName: '爱丽丝' })
})

beforeEach(async () => {
  // 每个用例从零计数
  await database.query(async client => client.query('DELETE FROM auth_login_throttles'))
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function rows<T extends Record<string, unknown>>(query: string, values: unknown[] = []): Promise<T[]> {
  return database.query(async client => (await client.query<T>(query, values)).rows)
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

describe('US-M1-02 登录', () => {
  it('成功：返回账户、个人空间与 CSRF 令牌；下发 HttpOnly、SameSite=Lax 的会话 Cookie；库里只存令牌的摘要；记审计', async () => {
    const response = await postLogin(app.baseUrl, { username: 'alice', password: alice.password }, { 'x-request-id': 'login-ok-1' })
    expect(response.status).toBe(200)
    const session = parseExact(sessionResponseSchema, await response.json())
    expect(session.user).toEqual({ id: alice.id, username: 'alice', displayName: '爱丽丝', systemRole: 'member' })
    expect(session.personalSpace).toEqual({ id: alice.personalSpaceId, name: '爱丽丝' })

    const setCookie = sessionSetCookie(response) ?? ''
    expect(setCookie).toMatch(/; Max-Age=604800;/)
    expect(setCookie).toMatch(/; Path=\//)
    expect(setCookie).toMatch(/; HttpOnly/)
    expect(setCookie).toMatch(/; SameSite=Lax/)
    // 公开地址是本机的 HTTP：不带 Secure（生产必须是 HTTPS，见配置的校验）
    expect(setCookie).not.toMatch(/Secure/)

    const token = cookieValue(setCookie)
    const digest = createHash('sha256').update(token).digest()
    const [stored] = await rows<{ user_id: string, token_hash: Buffer }>('SELECT user_id, token_hash FROM auth_sessions WHERE token_hash = $1', [digest])
    expect(stored?.user_id).toBe(alice.id)
    expect(JSON.stringify(await rows('SELECT * FROM auth_sessions'))).not.toContain(token)

    const [audit] = await rows('SELECT action, actor_type, actor_id, target_id, source, request_id, client_ip FROM audit_events WHERE request_id = \'login-ok-1\'')
    expect(audit).toEqual({ action: 'auth.login_succeeded', actor_type: 'user', actor_id: alice.id, target_id: alice.id, source: 'http', request_id: 'login-ok-1', client_ip: '127.0.0.1' })
  })

  it('用户名不区分大小写，首尾空白不算', async () => {
    expect((await postLogin(app.baseUrl, { username: ' ALICE ', password: alice.password })).status).toBe(200)
  })

  it('密码错误与用户不存在：同一个错误码与说明，不暴露账户是否存在；都记审计', async () => {
    const wrongPassword = await postLogin(app.baseUrl, { username: 'alice', password: 'wrong password' }, { 'x-request-id': 'login-bad-1' })
    const unknownUser = await postLogin(app.baseUrl, { username: 'nobody', password: 'wrong password' }, { 'x-request-id': 'login-bad-2' })
    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    const [first, second] = [await errorOf(wrongPassword), await errorOf(unknownUser)]
    expect(first).toEqual({ code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    expect(second).toEqual(first)
    expect(sessionSetCookie(wrongPassword)).toBeUndefined()

    const audits = await rows('SELECT request_id, action, actor_type, target_id, details FROM audit_events WHERE request_id IN (\'login-bad-1\', \'login-bad-2\') ORDER BY request_id')
    expect(audits).toEqual([
      { request_id: 'login-bad-1', action: 'auth.login_failed', actor_type: 'anonymous', target_id: alice.id, details: { reason: 'invalid_credentials' } },
      { request_id: 'login-bad-2', action: 'auth.login_failed', actor_type: 'anonymous', target_id: null, details: { reason: 'invalid_credentials' } },
    ])
  })

  it('请求不合法（缺字段、超长、多余的字段）：400 REQUEST_INVALID，不计入限流', async () => {
    for (const body of [{ username: 'alice' }, { username: 'alice', password: 'x'.repeat(1025) }, { username: 'alice', password: 'x', extra: 1 }]) {
      const response = await postLogin(app.baseUrl, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(response)).code).toBe('REQUEST_INVALID')
    }
    expect(await rows('SELECT 1 FROM auth_login_throttles')).toEqual([])
  })

  it('Origin 缺少或不是本站：403 ORIGIN_NOT_ALLOWED，不验证密码', async () => {
    for (const origin of [undefined, 'https://evil.example', 'http://127.0.0.1:9999']) {
      const response = await fetch(`${app.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) },
        body: JSON.stringify({ username: 'alice', password: alice.password }),
      })
      expect(response.status, String(origin)).toBe(403)
      expect((await errorOf(response)).code).toBe('ORIGIN_NOT_ALLOWED')
    }
  })

  it('哈希的参数过时：登录成功后用当前参数重新哈希，之后照常登录', async () => {
    const carol = await createAccount(database, { username: 'carol', argon2: { memoryCost: 12_288, timeCost: 3, parallelism: 1 } })
    const hashOf = async () => (await rows<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [carol.id]))[0]?.password_hash
    expect(await hashOf()).toMatch(/^\$argon2id\$v=19\$m=12288,t=3,p=1\$/)
    expect((await postLogin(app.baseUrl, { username: 'carol', password: carol.password })).status).toBe(200)
    expect(await hashOf()).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect((await postLogin(app.baseUrl, { username: 'carol', password: carol.password })).status).toBe(200)
    expect((await postLogin(app.baseUrl, { username: 'carol', password: 'wrong' })).status).toBe(401)
  })

  it('同一个浏览器重新登录：换新的令牌，原来的会话作废（replaced）', async () => {
    const first = await login(app.baseUrl, 'alice', alice.password)
    const again = await postLogin(app.baseUrl, { username: 'alice', password: alice.password }, { cookie: first.cookie })
    expect(again.status).toBe(200)
    expect(cookieValue(sessionSetCookie(again) ?? '')).not.toBe(first.cookie.split('=')[1])
    expect((await asUser(app.baseUrl, first, '/api/auth/session')).status).toBe(401)
    const digest = createHash('sha256').update(first.cookie.split('=')[1] ?? '').digest()
    expect(await rows('SELECT revoked_reason FROM auth_sessions WHERE token_hash = $1', [digest])).toEqual([{ revoked_reason: 'replaced' }])
  })
})

describe('US-M1-02 登录限流', () => {
  it('按用户名：窗口内失败达到上限时锁定（429，带 Retry-After）；锁定期间正确的密码也被拒绝；锁定结束后恢复', async () => {
    for (let attempt = 1; attempt <= 2; attempt++)
      expect((await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' }, { 'x-request-id': `lock-${attempt}` })).status).toBe(401)
    // 第 3 次失败触发锁定，这一次就返回 429
    const third = await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' }, { 'x-request-id': 'lock-3' })
    expect(third.status).toBe(429)
    expect((await errorOf(third)).code).toBe('TOO_MANY_ATTEMPTS')
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(14 * 60)

    const correct = await postLogin(app.baseUrl, { username: 'alice', password: alice.password }, { 'x-request-id': 'lock-4' })
    expect(correct.status).toBe(429)
    expect(Number(correct.headers.get('retry-after'))).toBeGreaterThan(0)
    // 锁定期间被拒绝的请求不写审计（只记日志）；触发锁定的那一次记下锁定的时长
    const audits = await rows<{ request_id: string, details: { lockedForSeconds?: number } }>('SELECT request_id, details FROM audit_events WHERE request_id LIKE \'lock-%\' ORDER BY request_id')
    expect(audits.map(audit => audit.request_id)).toEqual(['lock-1', 'lock-2', 'lock-3'])
    expect(audits[2]?.details.lockedForSeconds).toBeGreaterThan(14 * 60)

    // 锁定结束：从 1 重新计数，正确的密码能登录
    await database.query(async client => client.query('UPDATE auth_login_throttles SET locked_until = now() - interval \'1 second\''))
    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(200)
  })

  it('用户名的写法不同也算同一个账户（规范化之后计数）', async () => {
    for (const username of ['alice', 'ALICE', ' Alice'])
      await postLogin(app.baseUrl, { username, password: 'wrong' })
    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(429)
  })

  it('不存在的用户名同样计数与锁定：不能借此判断账户是否存在', async () => {
    const statuses: number[] = []
    for (let attempt = 1; attempt <= 4; attempt++)
      statuses.push((await postLogin(app.baseUrl, { username: 'ghost', password: 'wrong' })).status)
    expect(statuses).toEqual([401, 401, 429, 429])
  })

  it('成功登录清除这个用户名的计数', async () => {
    await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(200)
    // 计数清零：再错两次也不锁定
    await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    expect((await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })).status).toBe(401)
  })

  it('窗口过后从 1 重新计数', async () => {
    await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    await database.query(async client => client.query('UPDATE auth_login_throttles SET window_started_at = now() - interval \'16 minutes\''))
    expect((await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })).status).toBe(401)
    expect((await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })).status).toBe(401)
  })

  it('计数的键只存摘要，不存用户名与地址的原文', async () => {
    await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    const stored = JSON.stringify(await rows('SELECT encode(key_hash, \'escape\') AS key FROM auth_login_throttles'))
    expect(stored).not.toContain('alice')
    expect(stored).not.toContain('127.0.0.1')
  })
})

describe('US-M1-02 按客户端地址限流', () => {
  let ipApp: TestApp

  beforeAll(async () => {
    ipApp = await startTestApp({ databaseUrl: database.url, env: { NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '3' } })
  })

  afterAll(async () => {
    await ipApp.close()
  })

  it('同一个地址换着用户名尝试：达到上限后锁定这个地址，别的用户名也被拒绝', async () => {
    const statuses: number[] = []
    for (const username of ['u1', 'u2', 'u3', 'u4'])
      statuses.push((await postLogin(ipApp.baseUrl, { username, password: 'wrong' })).status)
    expect(statuses).toEqual([401, 401, 429, 429])
    expect((await postLogin(ipApp.baseUrl, { username: 'alice', password: alice.password })).status).toBe(429)
  })
})

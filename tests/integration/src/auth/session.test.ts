import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
// 当前会话与认证（P3 设计 §3.5，US-M1-02、US-M1-08）：默认拒绝、过期与撤销、活动顺延、日志带用户。
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
let alice: TestAccount

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  alice = await createAccount(database, { username: 'alice', displayName: '爱丽丝' })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function digestOf(user: LoggedIn): Buffer {
  return createHash('sha256').update(user.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
}

async function updateSession(user: LoggedIn, assignments: string): Promise<void> {
  await database.query(async client => client.query(`UPDATE auth_sessions SET ${assignments} WHERE token_hash = $1`, [digestOf(user)]))
}

async function expectSessionExpired(response: Response): Promise<void> {
  expect(response.status).toBe(401)
  expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('SESSION_EXPIRED')
  // 同时清除浏览器里的 Cookie
  expect(sessionSetCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970/)
}

describe('US-M1-02 当前会话', () => {
  it('登录之后：返回账户、个人空间与同一个 CSRF 令牌', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    const response = await asUser(app.baseUrl, user, '/api/auth/session')
    expect(response.status).toBe(200)
    expect(parseExact(sessionResponseSchema, await response.json())).toEqual(user.session)
  })

  it('空闲过期：SESSION_EXPIRED，并清除 Cookie', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    await updateSession(user, 'idle_expires_at = now() - interval \'1 second\'')
    await expectSessionExpired(await asUser(app.baseUrl, user, '/api/auth/session'))
  })

  it('绝对过期：即使一直在活动也失效', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    await updateSession(user, 'idle_expires_at = now() - interval \'1 second\', absolute_expires_at = now() - interval \'1 second\'')
    await expectSessionExpired(await asUser(app.baseUrl, user, '/api/auth/session'))
  })

  it('已撤销的会话失效', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    await updateSession(user, 'revoked_at = now(), revoked_reason = \'logout\'')
    await expectSessionExpired(await asUser(app.baseUrl, user, '/api/auth/session'))
  })

  it('不认识的令牌、格式不对的令牌：SESSION_EXPIRED', async () => {
    for (const cookie of [`${SESSION_COOKIE}=${'a'.repeat(43)}`, `${SESSION_COOKIE}=garbage`]) {
      const response = await fetch(`${app.baseUrl}/api/auth/session`, { headers: { cookie } })
      await expectSessionExpired(response)
    }
  })

  it('活动顺延：距上次记录超过 1 分钟才更新，空闲过期随之顺延但不超过绝对过期', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    interface Times { last_seen_at: Date, idle_expires_at: Date, absolute_expires_at: Date }
    const read = async (): Promise<Times | undefined> => database.query(async client =>
      (await client.query<Times>('SELECT last_seen_at, idle_expires_at, absolute_expires_at FROM auth_sessions WHERE token_hash = $1', [digestOf(user)])).rows[0])
    const initial = await read()
    await asUser(app.baseUrl, user, '/api/auth/session')
    expect(await read()).toEqual(initial)

    await updateSession(user, 'last_seen_at = now() - interval \'2 minutes\', absolute_expires_at = now() + interval \'1 hour\', idle_expires_at = now() + interval \'10 minutes\'')
    await asUser(app.baseUrl, user, '/api/auth/session')
    const touched = await read()
    expect(touched?.last_seen_at.getTime()).toBeGreaterThan(Date.now() - 60_000)
    // 默认空闲 12 小时，但绝对过期只剩 1 小时：顺延到绝对过期为止
    expect(touched?.idle_expires_at).toEqual(touched?.absolute_expires_at)
  })

  it('认证通过的请求，请求日志带上 userId；日志里没有会话令牌与 CSRF 令牌', async () => {
    const user = await login(app.baseUrl, 'alice', alice.password)
    const response = await asUser(app.baseUrl, user, '/api/auth/session')
    expect(response.status).toBe(200)
    const entry = app.logs.entries().find(log => log.requestId === requestIdOf(response) && log.msg === '请求完成')
    expect(entry).toMatchObject({ userId: alice.id, route: '/api/auth/session', statusCode: 200 })
    const text = app.logs.text()
    expect(text).not.toContain(user.cookie.slice(`${SESSION_COOKIE}=`.length))
    expect(text).not.toContain(user.session.csrfToken)
  })
})

describe('US-M2-02 换令牌之后还带着旧 Cookie 的请求（复验 N3）：仍是 SESSION_EXPIRED，但不清除 Cookie；其他原因照旧清除（M2-P6 复验 一般-3）', () => {
  /** 401 SESSION_EXPIRED，响应里没有会话 Cookie 的 Set-Cookie：浏览器里已经换上的新 Cookie 不会被它删掉 */
  async function expectSessionExpiredKeepingCookie(response: Response): Promise<void> {
    expect(response.status).toBe(401)
    expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('SESSION_EXPIRED')
    expect(sessionSetCookie(response)).toBeUndefined()
  }

  /** 在 user 的这个浏览器里修改密码：返回修改密码换上的新会话（新的 Cookie 与新的 CSRF 令牌） */
  async function changePassword(user: LoggedIn, currentPassword: string): Promise<LoggedIn> {
    const changed = await asUser(app.baseUrl, user, '/api/auth/password', { method: 'PUT', body: { currentPassword, newPassword: 'a brand new long password' } })
    expect(changed.status).toBe(200)
    const renewed = sessionSetCookie(changed)
    if (renewed === undefined)
      throw new Error('改密码成功却没有写回会话 Cookie')
    return { cookie: `${SESSION_COOKIE}=${cookieValue(renewed)}`, session: parseExact(sessionResponseSchema, await changed.json()) }
  }

  it('修改密码之后：本页原来的 Cookie（同一个浏览器的其他标签页用的也是它）发来的请求不清除 Cookie；别的设备上的 Cookie 清除；带着新 Cookie 的请求照常', async () => {
    const amy = await createAccount(database, { username: 'amy-rotate' })
    const here = await login(app.baseUrl, 'amy-rotate', amy.password)
    const elsewhere = await login(app.baseUrl, 'amy-rotate', amy.password)
    const current = await changePassword(here, amy.password)
    // 修改密码之前发出、之后才处理的请求（本页或同一个浏览器的其他标签页）：浏览器里已是新的 Cookie，不能删掉它
    await expectSessionExpiredKeepingCookie(await asUser(app.baseUrl, here, '/api/auth/session'))
    // 别的设备不会有新的 Cookie：照常清除，免得它在 Cookie 到期之前每次打开都提示"登录已过期"（M2-P6 复验 一般-3）
    await expectSessionExpired(await asUser(app.baseUrl, elsewhere, '/api/auth/session'))
    expect((await asUser(app.baseUrl, current, '/api/auth/session')).status).toBe(200)
  })

  it('修改密码之后很久（撤销 20 天、会话行还没清理）：仍按撤销的原因，不看时间——本页原来的 Cookie 不清除，别的设备上的清除', async () => {
    const bea = await createAccount(database, { username: 'bea-rotate' })
    const here = await login(app.baseUrl, 'bea-rotate', bea.password)
    const elsewhere = await login(app.baseUrl, 'bea-rotate', bea.password)
    await changePassword(here, bea.password)
    for (const old of [here, elsewhere])
      await updateSession(old, 'revoked_at = now() - interval \'20 days\', idle_expires_at = now() - interval \'20 days\'')
    await expectSessionExpiredKeepingCookie(await asUser(app.baseUrl, here, '/api/auth/session'))
    await expectSessionExpired(await asUser(app.baseUrl, elsewhere, '/api/auth/session'))
  })

  it('修改密码之后账户又被停用：撤销的原因停在当初的那个——本页原来的 Cookie 不清除，别的设备上的清除；修改密码换上的新会话按停用清除', async () => {
    const admin = await createAccount(database, { username: 'root-rotate-2', systemRole: 'admin' })
    const adminSession = await login(app.baseUrl, 'root-rotate-2', admin.password)
    const cal = await createAccount(database, { username: 'cal-rotate' })
    const here = await login(app.baseUrl, 'cal-rotate', cal.password)
    const elsewhere = await login(app.baseUrl, 'cal-rotate', cal.password)
    const current = await changePassword(here, cal.password)
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/users/${cal.id}/disable`, { method: 'POST' })).status).toBe(200)
    await expectSessionExpiredKeepingCookie(await asUser(app.baseUrl, here, '/api/auth/session'))
    await expectSessionExpired(await asUser(app.baseUrl, elsewhere, '/api/auth/session'))
    await expectSessionExpired(await asUser(app.baseUrl, current, '/api/auth/session'))
  })

  it('会话行被清理之后（撤销超过 30 天）：本页原来的 Cookie 也改为清除（查不到撤销的原因）', async () => {
    const dee = await createAccount(database, { username: 'dee-rotate' })
    const here = await login(app.baseUrl, 'dee-rotate', dee.password)
    await changePassword(here, dee.password)
    await database.query(async client => client.query('DELETE FROM auth_sessions WHERE token_hash = $1', [digestOf(here)]))
    await expectSessionExpired(await asUser(app.baseUrl, here, '/api/auth/session'))
  })

  it('同一个浏览器里修改密码与退出同时发生、退出晚于修改密码处理（带着旧 Cookie）：退出回"登录已过期"、不清除 Cookie，修改密码换上的新会话仍然有效；带着新 Cookie 与新的 CSRF 令牌再退出一次才结束它（M2-P6 复验 一般-4）', async () => {
    const eve = await createAccount(database, { username: 'eve-rotate' })
    const old = await login(app.baseUrl, 'eve-rotate', eve.password)
    const current = await changePassword(old, eve.password)
    const late = await asUser(app.baseUrl, old, '/api/auth/logout', { method: 'POST' })
    await expectSessionExpiredKeepingCookie(late)
    // 浏览器里留着的是新 Cookie：它对应的会话没有被这次退出结束。前端据此先确认、再带新的令牌退出一次（features/auth 的 logout）
    const confirmed = await asUser(app.baseUrl, current, '/api/auth/session')
    expect(confirmed.status).toBe(200)
    const again = await asUser(app.baseUrl, { ...current, session: parseExact(sessionResponseSchema, await confirmed.json()) }, '/api/auth/logout', { method: 'POST' })
    expect(again.status).toBe(204)
    expect(sessionSetCookie(again)).toMatch(/Expires=Thu, 01 Jan 1970/)
    expect((await asUser(app.baseUrl, current, '/api/auth/session')).status).toBe(401)
    expect(await database.query(async client => (await client.query<{ revoked_reason: string | null }>('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1 ORDER BY created_at, id', [eve.id])).rows)).toEqual([{ revoked_reason: 'replaced' }, { revoked_reason: 'logout' }])
  })

  it('同一个浏览器重新登录（原来的会话换掉，replaced）之后：带着原来 Cookie 的请求不清除 Cookie', async () => {
    const bob = await createAccount(database, { username: 'bob-rotate' })
    const first = await login(app.baseUrl, 'bob-rotate', bob.password)
    const again = await postLogin(app.baseUrl, { username: 'bob-rotate', password: bob.password }, { cookie: first.cookie })
    expect(again.status).toBe(200)
    await expectSessionExpiredKeepingCookie(await asUser(app.baseUrl, first, '/api/auth/session'))
  })

  it('退出、停用、签发重置之后：带着旧 Cookie 的请求照旧清除 Cookie（不会有新的 Cookie）', async () => {
    const admin = await createAccount(database, { username: 'root-rotate', systemRole: 'admin' })
    const adminSession = await login(app.baseUrl, 'root-rotate', admin.password)
    const cid = await createAccount(database, { username: 'cid-rotate' })

    const loggedOut = await login(app.baseUrl, 'cid-rotate', cid.password)
    expect((await asUser(app.baseUrl, loggedOut, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    await expectSessionExpired(await asUser(app.baseUrl, loggedOut, '/api/auth/session'))

    const beforeReset = await login(app.baseUrl, 'cid-rotate', cid.password)
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/users/${cid.id}/password-reset`, { method: 'POST' })).status).toBe(201)
    await expectSessionExpired(await asUser(app.baseUrl, beforeReset, '/api/auth/session'))

    const dan = await createAccount(database, { username: 'dan-rotate' })
    const beforeDisable = await login(app.baseUrl, 'dan-rotate', dan.password)
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/users/${dan.id}/disable`, { method: 'POST' })).status).toBe(200)
    await expectSessionExpired(await asUser(app.baseUrl, beforeDisable, '/api/auth/session'))
  })

  it('按撤销的原因：只有 replaced 不清除；logout、disabled、password_reset、password_changed 清除（M2-P6 复验 一般-3）', async () => {
    const reasons = { logout: true, disabled: true, password_reset: true, password_changed: true, replaced: false } as const
    for (const [reason, clears] of Object.entries(reasons)) {
      const user = await login(app.baseUrl, 'alice', alice.password)
      await updateSession(user, `revoked_at = now(), revoked_reason = '${reason}', idle_expires_at = now()`)
      const response = await asUser(app.baseUrl, user, '/api/auth/session')
      if (clears)
        await expectSessionExpired(response)
      else
        await expectSessionExpiredKeepingCookie(response)
    }
  })
})

describe('US-M1-08 未登录时一律要求先登录', () => {
  it('没有会话 Cookie：401 UNAUTHENTICATED，不是 SESSION_EXPIRED', async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/session`)
    expect(response.status).toBe(401)
    expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it('探针不需要登录', async () => {
    expect((await fetch(`${app.baseUrl}/api/health/live`)).status).toBe(200)
  })

  it('不存在的接口：404 NOT_FOUND（没有匹配的路由时不经过守卫；项目开源，接口有哪些本来就不是秘密）', async () => {
    const response = await fetch(`${app.baseUrl}/api/no-such-endpoint`)
    expect(response.status).toBe(404)
    expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('NOT_FOUND')
  })
})

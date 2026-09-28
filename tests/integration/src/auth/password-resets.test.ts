// 重置密码（M2-P1 设计 §3.4，US-M2-03）：签发（旧密码失效、撤销全部会话、作废旧的）、查看、完成（新密码、其他会话撤销、登录）、
// 再用、过期、停用账户、并发、访问控制；运维命令（§3.9）。锁的顺序与事务里的复核另见 account-races.test.ts。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { AppError, issueResetLink, loadConfig } from '@nerve-office/api'
import { errorResponseSchema, inspectLinkResponseSchema, issuedPasswordResetSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { linkInvalidReasonOf, postPublic, tokenOf } from '../support/links.ts'
import { captureLogs } from '../support/log-capture.ts'
import { asUser, login, postLogin, SESSION_COOKIE } from '../support/session-client.ts'

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

async function issueFor(account: TestAccount, requestId?: string) {
  const response = await asUser(app.baseUrl, adminSession, `/api/admin/users/${account.id}/password-reset`, {
    method: 'POST',
    headers: requestId === undefined ? {} : { 'x-request-id': requestId },
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const issued = parseExact(issuedPasswordResetSchema, await response.json())
  return { ...issued, token: tokenOf(issued.url) }
}

async function complete(token: string, password = 'the new long password', headers: Record<string, string> = {}): Promise<Response> {
  return postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token, password }, headers)
}

async function reasonsOf(account: TestAccount) {
  return database.query(async client => (await client.query<{ revoked_reason: string | null }>('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1 ORDER BY created_at, id', [account.id])).rows.map(row => row.revoked_reason))
}

describe('US-M2-03 重置密码', () => {
  it('签发：链接是 <公开地址>/reset-password#<令牌>，24 小时内有效；旧密码立即失效，这个人的全部会话立即撤销；记审计', async () => {
    const amy = await createAccount(database, { username: 'amy' })
    const open = await login(app.baseUrl, 'amy', amy.password)
    const issued = await issueFor(amy, 'reset-amy')
    expect(issued.url).toBe(`http://127.0.0.1:4100/reset-password#${issued.token}`)
    const hours = (Date.parse(issued.expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(23.9)
    expect(hours).toBeLessThanOrEqual(24)
    expect((await asUser(app.baseUrl, open, '/api/auth/session')).status).toBe(401)
    expect(await reasonsOf(amy)).toEqual(['password_reset'])
    // 旧密码随签发失效（审查 A7）：账户被盗时，签发即切断旧密码，不用等本人完成重置
    expect((await postLogin(app.baseUrl, { username: 'amy', password: amy.password })).status).toBe(401)
    const [event] = await database.query(async client => (await client.query<{ action: string, actor_id: string, target_id: string }>('SELECT action, actor_id, target_id FROM audit_events WHERE request_id = \'reset-amy\'')).rows)
    expect(event).toEqual({ action: 'users.password_reset_issued', actor_id: admin.id, target_id: amy.id })
  })

  it('查看只给出登录名与显示名；设置新密码之后已登录，新密码能登录、旧密码不能；记审计', async () => {
    const bob = await createAccount(database, { username: 'bob', displayName: '鲍勃' })
    const issued = await issueFor(bob)
    const inspected = await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: issued.token })
    expect(parseExact(inspectLinkResponseSchema, await inspected.json())).toEqual({ username: 'bob', displayName: '鲍勃', expiresAt: issued.expiresAt })

    const response = await complete(issued.token)
    expect(response.status).toBe(200)
    expect(parseExact(sessionResponseSchema, await response.json()).user.username).toBe('bob')
    expect((await postLogin(app.baseUrl, { username: 'bob', password: bob.password })).status).toBe(401)
    expect((await postLogin(app.baseUrl, { username: 'bob', password: 'the new long password' })).status).toBe(200)
    const actions = await database.query(async client => (await client.query<{ action: string }>('SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE \'users.password_reset%\' ORDER BY occurred_at', [bob.id])).rows.map(row => row.action))
    expect(actions).toEqual(['users.password_reset_issued', 'users.password_reset_completed'])
  })

  it('签发之后、完成之前旧密码登录不了；完成时浏览器原来带着的会话作废（replaced），其他会话撤销', async () => {
    const cid = await createAccount(database, { username: 'cid' })
    const bystander = await createAccount(database, { username: 'cid-colleague' })
    const issued = await issueFor(cid)
    expect((await postLogin(app.baseUrl, { username: 'cid', password: cid.password })).status).toBe(401)
    // 这台电脑上原来登录着别人：完成之后原来的会话作废，同登录
    const shared = await login(app.baseUrl, 'cid-colleague', bystander.password)
    const response = await complete(issued.token, 'the new long password', { cookie: shared.cookie })
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie().some(value => value.startsWith(`${SESSION_COOKIE}=`))).toBe(true)
    expect((await asUser(app.baseUrl, shared, '/api/auth/session')).status).toBe(401)
    expect(await reasonsOf(bystander)).toEqual(['replaced'])
  })

  it('同一个令牌并发完成两次：只有一次成功，另一次 410（used），并记审计', async () => {
    const hub = await createAccount(database, { username: 'hub' })
    const issued = await issueFor(hub)
    const responses = await Promise.all([complete(issued.token, 'first new password'), complete(issued.token, 'second new password')])
    expect(responses.map(response => response.status).sort()).toEqual([200, 410])
    const loser = responses.find(response => response.status === 410)
    expect(loser === undefined ? undefined : await linkInvalidReasonOf(loser)).toBe('used')
    const rejected = await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_events WHERE action = \'auth.link_rejected\' AND target_id = $1', [hub.id])).rows[0])
    expect(rejected).toEqual({ count: 1 })
    expect(await reasonsOf(hub)).toEqual([null])
  })

  it('再用这个链接：410（used）；签发新的之后旧的：410（revoked）；过期：410（expired）', async () => {
    const dee = await createAccount(database, { username: 'dee' })
    const first = await issueFor(dee)
    const second = await issueFor(dee)
    expect(await linkInvalidReasonOf(await complete(first.token))).toBe('revoked')
    expect((await complete(second.token)).status).toBe(200)
    expect(await linkInvalidReasonOf(await complete(second.token))).toBe('used')

    const third = await issueFor(dee)
    await database.query(async client => client.query('UPDATE auth_password_resets SET created_at = now() - interval \'2 days\', expires_at = now() - interval \'1 day\' WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [dee.id]))
    expect(await linkInvalidReasonOf(await complete(third.token))).toBe('expired')
  })

  it('停用账户：未用的重置一并作废，启用之后旧链接仍是 410（revoked）；对停用的账户签发：409 ACCOUNT_DISABLED', async () => {
    const eve = await createAccount(database, { username: 'eve' })
    const issued = await issueFor(eve)
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/users/${eve.id}/disable`, { method: 'POST' })).status).toBe(200)
    expect(await linkInvalidReasonOf(await complete(issued.token))).toBe('revoked')
    const again = await asUser(app.baseUrl, adminSession, `/api/admin/users/${eve.id}/password-reset`, { method: 'POST' })
    expect(await codeOf(again)).toBe('ACCOUNT_DISABLED')
    // 启用之后账户有效：旧链接仍不能用，说明停用时确实作废了它，而不只是因为账户停用才拒绝（审查 A5）
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/users/${eve.id}/enable`, { method: 'POST' })).status).toBe(200)
    expect(await linkInvalidReasonOf(await complete(issued.token))).toBe('revoked')
  })

  it('管理员给自己签发：自己的会话随即撤销（管理界面随后要求重新登录），用链接设置新密码之后照常登录', async () => {
    const self = await createAccount(database, { username: 'self-admin', systemRole: 'admin' })
    const session = await login(app.baseUrl, 'self-admin', self.password)
    const response = await asUser(app.baseUrl, session, `/api/admin/users/${self.id}/password-reset`, { method: 'POST' })
    expect(response.status).toBe(201)
    const issued = parseExact(issuedPasswordResetSchema, await response.json())
    expect((await asUser(app.baseUrl, session, '/api/auth/session')).status).toBe(401)
    expect((await complete(tokenOf(issued.url), 'self admin new password')).status).toBe(200)
    expect((await postLogin(app.baseUrl, { username: 'self-admin', password: 'self admin new password' })).status).toBe(200)
  })

  it('账户不存在：404；成员不能签发：403', async () => {
    expect(await codeOf(await asUser(app.baseUrl, adminSession, '/api/admin/users/0192f0c8-0000-7000-8000-00000000dead/password-reset', { method: 'POST' }))).toBe('NOT_FOUND')
    const fay = await createAccount(database, { username: 'fay' })
    const session = await login(app.baseUrl, 'fay', fay.password)
    expect(await codeOf(await asUser(app.baseUrl, session, `/api/admin/users/${fay.id}/password-reset`, { method: 'POST' }))).toBe('PERMISSION_DENIED')
  })

  it('新密码不符合规则：400，链接仍可用', async () => {
    const gil = await createAccount(database, { username: 'gil' })
    const issued = await issueFor(gil)
    expect(await codeOf(await complete(issued.token, 'short'))).toBe('REQUEST_INVALID')
    expect((await complete(issued.token)).status).toBe(200)
  })

  it('请求不合法（令牌超长、缺字段、多余的字段）：400，不当作链接失效', async () => {
    const tooLong = await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: 'A'.repeat(1_000) })
    expect(await codeOf(tooLong)).toBe('REQUEST_INVALID')
    expect(await codeOf(await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: 'A'.repeat(43) }))).toBe('REQUEST_INVALID')
    expect(await codeOf(await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: 'A'.repeat(43), extra: true }))).toBe('REQUEST_INVALID')
  })
})

describe('US-M2-03 运维命令：签发重置链接', () => {
  it('唯一的管理员忘记密码：命令按登录名签发，标准输出只有链接，日志写标准错误、只有账户与到期时间；审计的操作者是系统，来源是命令行', async () => {
    const command = startApiProcess(testEnvironment(database.url), 'reset-link', { args: ['--username', 'ROOT'] })
    expect((await command.exited).code).toBe(0)
    expect(command.stdout()).toMatch(/^http:\/\/127\.0\.0\.1:4100\/reset-password#[\w-]{43}\n$/)
    const url = command.stdout().trim()
    const logLine = command.output().split('\n').find(line => line.includes('已签发重置链接')) ?? ''
    expect(logLine).toContain(admin.id)
    expect(logLine).not.toContain(tokenOf(url))
    const [event] = await database.query(async client => (await client.query<{ actor_type: string, source: string, target_id: string }>(
      'SELECT actor_type, source, target_id FROM audit_events WHERE action = \'users.password_reset_issued\' AND source = \'cli\'',
    )).rows)
    expect(event).toEqual({ actor_type: 'system', source: 'cli', target_id: admin.id })
    // 管理员原来的会话随签发撤销；用链接设置新密码之后照常登录
    expect((await asUser(app.baseUrl, adminSession, '/api/auth/session')).status).toBe(401)
    expect((await complete(tokenOf(url), 'recovered admin password')).status).toBe(200)
    adminSession = await login(app.baseUrl, 'root', 'recovered admin password')
  })

  it('命令的内核（issueResetLink，在测试进程里调用）：按登录名签发，操作者是系统；日志里没有令牌；停用的账户 409、没有这个账户 404', async () => {
    const kai = await createAccount(database, { username: 'kai' })
    const config = loadConfig(testEnvironment(database.url))
    const logs = captureLogs()
    const issued = await issueResetLink(config, ' KAI ', { logDestination: logs.destination })
    expect(issued.userId).toBe(kai.id)
    expect(issued.url).toMatch(/^http:\/\/127\.0\.0\.1:4100\/reset-password#[\w-]{43}$/)
    expect(logs.text()).not.toContain(tokenOf(issued.url))
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: tokenOf(issued.url) })).status).toBe(200)

    await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [kai.id]))
    const disabled = await issueResetLink(config, 'kai', { logDestination: captureLogs().destination }).catch((error: unknown) => error)
    expect(disabled).toBeInstanceOf(AppError)
    expect((disabled as AppError).code).toBe('ACCOUNT_DISABLED')
    const missing = await issueResetLink(config, 'nobody-here', { logDestination: captureLogs().destination }).catch((error: unknown) => error)
    expect((missing as AppError).code).toBe('NOT_FOUND')
  })

  it('没有这个账户：退出码 1；缺少参数：退出码 2，打印用法', async () => {
    const missing = startApiProcess(testEnvironment(database.url), 'reset-link', { args: ['--username', 'nobody'] })
    expect((await missing.exited).code).toBe(1)
    expect(missing.output()).toContain('没有这个账户')
    const usage = startApiProcess(testEnvironment(database.url), 'reset-link', { args: [] })
    expect((await usage.exited).code).toBe(2)
    expect(usage.output()).toContain('用法：reset-link --username')
  })
})

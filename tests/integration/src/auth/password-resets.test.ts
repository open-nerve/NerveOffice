// 重置密码（M2-P1 设计 §3.4，US-M2-03）：签发（撤销全部会话、作废旧的）、查看、完成（新密码、其他会话撤销、登录）、
// 再用、过期、停用账户、访问控制；运维命令（§3.9）。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { errorResponseSchema, inspectLinkResponseSchema, issuedPasswordResetSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { linkInvalidReasonOf, postPublic, tokenOf } from '../support/links.ts'
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

async function issueFor(account: TestAccount, requestId?: string) {
  const response = await asUser(app.baseUrl, adminSession, `/api/admin/users/${account.id}/password-reset`, {
    method: 'POST',
    headers: requestId === undefined ? {} : { 'x-request-id': requestId },
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const issued = parseExact(issuedPasswordResetSchema, await response.json())
  return { ...issued, token: tokenOf(issued.url) }
}

async function complete(token: string, password = 'the new long password'): Promise<Response> {
  return postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token, password })
}

async function reasonsOf(account: TestAccount) {
  return database.query(async client => (await client.query<{ revoked_reason: string | null }>('SELECT revoked_reason FROM auth_sessions WHERE user_id = $1 ORDER BY created_at, id', [account.id])).rows.map(row => row.revoked_reason))
}

describe('US-M2-03 重置密码', () => {
  it('签发：链接是 <公开地址>/reset-password#<令牌>，24 小时内有效；这个人的全部会话立即撤销；记审计', async () => {
    const amy = await createAccount(database, { username: 'amy' })
    const open = await login(app.baseUrl, 'amy', amy.password)
    const issued = await issueFor(amy, 'reset-amy')
    expect(issued.url).toBe(`http://127.0.0.1:4100/reset-password#${issued.token}`)
    const hours = (Date.parse(issued.expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(23.9)
    expect(hours).toBeLessThanOrEqual(24)
    expect((await asUser(app.baseUrl, open, '/api/auth/session')).status).toBe(401)
    expect(await reasonsOf(amy)).toEqual(['password_reset'])
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

  it('签发之后、完成之前又用旧密码登录的会话：完成时一并撤销', async () => {
    const cid = await createAccount(database, { username: 'cid' })
    const issued = await issueFor(cid)
    const sneaky = await login(app.baseUrl, 'cid', cid.password)
    expect((await complete(issued.token)).status).toBe(200)
    expect((await asUser(app.baseUrl, sneaky, '/api/auth/session')).status).toBe(401)
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

  it('停用账户：未用的重置一并作废（410 revoked）；对停用的账户签发：409 ACCOUNT_DISABLED', async () => {
    const eve = await createAccount(database, { username: 'eve' })
    const issued = await issueFor(eve)
    expect((await asUser(app.baseUrl, adminSession, `/api/admin/users/${eve.id}/disable`, { method: 'POST' })).status).toBe(200)
    expect(await linkInvalidReasonOf(await complete(issued.token))).toBe('revoked')
    const again = await asUser(app.baseUrl, adminSession, `/api/admin/users/${eve.id}/password-reset`, { method: 'POST' })
    expect(await codeOf(again)).toBe('ACCOUNT_DISABLED')
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
})

describe('US-M2-03 运维命令：签发重置链接', () => {
  it('唯一的管理员忘记密码：命令按登录名签发，链接只写到标准输出，日志里只有账户与到期时间；审计的操作者是系统，来源是命令行', async () => {
    const command = startApiProcess(testEnvironment(database.url), 'reset-link', { args: ['--username', 'ROOT'] })
    expect((await command.exited).code).toBe(0)
    const output = command.output()
    const url = /^http:\/\/127\.0\.0\.1:4100\/reset-password#[\w-]{43}$/m.exec(output)?.[0]
    expect(url).toBeDefined()
    const logLine = output.split('\n').find(line => line.includes('已签发重置链接')) ?? ''
    expect(logLine).toContain(admin.id)
    expect(logLine).not.toContain(tokenOf(url ?? ''))
    const [event] = await database.query(async client => (await client.query<{ actor_type: string, source: string, target_id: string }>(
      'SELECT actor_type, source, target_id FROM audit_events WHERE action = \'users.password_reset_issued\' AND source = \'cli\'',
    )).rows)
    expect(event).toEqual({ actor_type: 'system', source: 'cli', target_id: admin.id })
    // 管理员原来的会话随签发撤销；用链接设置新密码之后照常登录
    expect((await asUser(app.baseUrl, adminSession, '/api/auth/session')).status).toBe(401)
    expect((await complete(tokenOf(url ?? ''), 'recovered admin password')).status).toBe(200)
    adminSession = await login(app.baseUrl, 'root', 'recovered admin password')
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

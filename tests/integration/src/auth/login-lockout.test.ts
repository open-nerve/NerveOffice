// 登录的锁定按"用户名 + 来源"计数（M2-P6 复核 A1，ADR-007）：一个来源连错只锁这个来源，本人从别处照常登录；
// 另有宽得多的"只按用户名"的上限，从很多来源累计到上限时这个账户被锁；修改密码共用这些计数；完成重置、接受邀请清掉这个账户的计数；
// 系统管理员能看到锁定并解除（记审计）；成功时按固定的顺序锁三行计数。
// 来源由反向代理识别（trust proxy 只信任本机）：测试里每个来源用一个文档专用的地址，经 X-Forwarded-For 带给应用。
// 用例都是确定的少量请求：上限调小（每个来源 2 次、账户 5 次），几个来源就能到上限。
import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { createHash } from 'node:crypto'
import { adminUserListResponseSchema, adminUserSchema, errorResponseSchema, issuedInvitationSchema, issuedPasswordResetSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { postPublic, tokenOf } from '../support/links.ts'
import { requestIdOf } from '../support/request-id.ts'
import { asUser, login, postLogin } from '../support/session-client.ts'

let database: TestDatabase
/** 默认的上限：按用户名与来源 5 次、只按用户名 50 次 */
let app: TestApp
/** 小的上限：按用户名与来源 2 次、只按用户名 5 次 */
let tight: TestApp
let root: TestAccount
let rootSession: LoggedIn

/** 文档专用的地址（RFC 5737）：各代表一个来源 */
const HOME = '198.51.100.10'
const SOURCES = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'] as const
const [S1, S2, S3, S4] = SOURCES
const NEW_PASSWORD = 'the new long password'

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_TRUST_PROXY: 'loopback' } })
  tight = await startTestApp({ databaseUrl: database.url, env: { NERVE_TRUST_PROXY: 'loopback', NERVE_LOGIN_MAX_FAILURES: '2', NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '5' } })
  root = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  rootSession = await login(app.baseUrl, 'root', root.password)
})

beforeEach(async () => {
  await database.query(async client => client.query('DELETE FROM auth_login_throttles'))
})

afterAll(async () => {
  await tight.close()
  await app.close()
  await database.drop()
})

/** 从某个来源登录 */
async function loginFrom(target: TestApp, source: string, username: string, password: string): Promise<Response> {
  return postLogin(target.baseUrl, { username, password }, { 'x-forwarded-for': source })
}

async function statusFrom(target: TestApp, source: string, username: string, password: string): Promise<number> {
  return (await loginFrom(target, source, username, password)).status
}

async function codeOf(response: Response): Promise<string> {
  return parseExact(errorResponseSchema, await response.json()).error.code
}

function digest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

/** 这个账户的计数行（所属账户是它的）有几行 */
async function accountRows(username: string): Promise<number> {
  const [row] = await database.query(async client => (await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM auth_login_throttles WHERE account_hash = $1',
    [digest(`account:${username}`)],
  )).rows)
  return row?.count ?? 0
}

/** 小的上限下，从 S1、S2 各连错 2 次（这两个来源被锁）、S3 错 1 次：累计 5 次，账户被锁（第 5 次就是 429） */
async function lockAccountFromManySources(username: string): Promise<void> {
  expect([
    await statusFrom(tight, S1, username, 'wrong-1'),
    await statusFrom(tight, S1, username, 'wrong-2'),
    await statusFrom(tight, S2, username, 'wrong-3'),
    await statusFrom(tight, S2, username, 'wrong-4'),
    await statusFrom(tight, S3, username, 'wrong-5'),
  ]).toEqual([401, 429, 401, 429, 429])
}

async function adminView(username: string) {
  const response = await asUser(app.baseUrl, rootSession, `/api/admin/users?query=${username}`)
  const [account] = parseExact(adminUserListResponseSchema, await response.json()).items.filter(item => item.username === username)
  if (account === undefined)
    throw new Error(`账户列表里没有 ${username}`)
  return account
}

describe('US-M1-02 登录的锁定按用户名与来源计数（M2-P6 复核 A1）', () => {
  it('同一个来源连错 5 次：只锁这个来源（第 5 次 429），这个来源用正确的密码也被拒绝；本人从另一个来源用正确的密码照常登录', async () => {
    const amy = await createAccount(database, { username: 'amy' })
    for (let attempt = 1; attempt <= 4; attempt += 1)
      expect(await statusFrom(app, S1, 'amy', `wrong ${attempt}`)).toBe(401)
    const fifth = await loginFrom(app, S1, 'amy', 'wrong 5')
    expect(fifth.status).toBe(429)
    expect(Number(fifth.headers.get('retry-after'))).toBeGreaterThan(14 * 60)
    expect(await statusFrom(app, S1, 'amy', amy.password)).toBe(429)
    expect(await statusFrom(app, HOME, 'amy', amy.password)).toBe(200)
    // 本人登录成功之后，那个来源仍然被锁：成功只清除本人这个来源的计数与账户的计数
    expect(await statusFrom(app, S1, 'amy', amy.password)).toBe(429)
    // 管理界面说明只锁了部分来源：本人从别处照常登录
    expect((await adminView('amy')).loginLock).toMatchObject({ allSources: false })
  })

  it('很多来源累计到只按用户名的上限：这个账户在所有来源上都被锁定，包括从没失败过的来源；别的账户、那些来源上的别人不受影响', async () => {
    const bea = await createAccount(database, { username: 'bea' })
    const cal = await createAccount(database, { username: 'cal' })
    await lockAccountFromManySources('bea')
    const fresh = await loginFrom(tight, S4, 'bea', bea.password)
    expect(fresh.status).toBe(429)
    expect(await codeOf(fresh)).toBe('TOO_MANY_ATTEMPTS')
    expect(await statusFrom(tight, HOME, 'bea', bea.password)).toBe(429)
    expect(await statusFrom(tight, S1, 'cal', cal.password)).toBe(200)
    // 管理界面看得到锁到什么时候（这个账户各计数行里最晚的锁定），而且是全部来源
    const lock = (await adminView('bea')).loginLock
    expect(lock?.allSources).toBe(true)
    expect(Date.parse(lock?.until ?? '') - Date.now()).toBeGreaterThan(14 * 60_000)
    expect((await adminView('cal')).loginLock).toBeNull()
  })

  it('修改密码与登录共用这些计数（用当前请求的来源）：一个来源上猜错旧密码锁住这个来源的登录，别的来源照常；累计起来同样锁住账户', async () => {
    const dan = await createAccount(database, { username: 'dan' })
    const session = await login(tight.baseUrl, 'dan', dan.password)
    const changeFrom = async (source: string, currentPassword: string) => asUser(tight.baseUrl, session, '/api/auth/password', {
      method: 'PUT',
      body: { currentPassword, newPassword: 'another long password' },
      headers: { 'x-forwarded-for': source },
    })
    expect(await codeOf(await changeFrom(S1, 'guess-1'))).toBe('CURRENT_PASSWORD_INCORRECT')
    expect((await changeFrom(S1, 'guess-2')).status).toBe(429)
    expect(await statusFrom(tight, S1, 'dan', dan.password)).toBe(429)
    expect((await changeFrom(S1, dan.password)).status).toBe(429)
    // 账户的计数此刻是 2；S2 上登录错 2 次（锁住 S2）、S3 上改密码再错 1 次，累计到 5：账户被锁
    expect(await statusFrom(tight, S2, 'dan', 'wrong-3')).toBe(401)
    expect(await statusFrom(tight, S2, 'dan', 'wrong-4')).toBe(429)
    expect((await changeFrom(S3, 'guess-5')).status).toBe(429)
    expect(await statusFrom(tight, S4, 'dan', dan.password)).toBe(429)
  })

  it('修改密码成功：清掉账户与这个来源的计数，别的来源上的锁定照旧', async () => {
    const eli = await createAccount(database, { username: 'eli' })
    const session = await login(tight.baseUrl, 'eli', eli.password)
    expect(await statusFrom(tight, S1, 'eli', 'wrong-1')).toBe(401)
    expect(await statusFrom(tight, S1, 'eli', 'wrong-2')).toBe(429)
    expect(await statusFrom(tight, S2, 'eli', 'wrong-3')).toBe(401)
    const changed = await asUser(tight.baseUrl, session, '/api/auth/password', { method: 'PUT', body: { currentPassword: eli.password, newPassword: NEW_PASSWORD }, headers: { 'x-forwarded-for': S2 } })
    expect(changed.status).toBe(200)
    // S2 的计数清零（再错 1 次不锁）；S1 上的锁定是别的来源留下的，照旧
    expect(await statusFrom(tight, S2, 'eli', 'wrong-4')).toBe(401)
    expect(await statusFrom(tight, S1, 'eli', NEW_PASSWORD)).toBe(429)
    expect(await statusFrom(tight, S3, 'eli', NEW_PASSWORD)).toBe(200)
  })
})

describe('US-M2-03 完成重置、US-M2-01 接受邀请：清掉这个账户在所有来源上的计数（M2-P6 复核 A1）', () => {
  it('账户被锁定时签发重置：本人完成之后，立即能用新密码登录，包括原来被锁的来源', async () => {
    const fay = await createAccount(database, { username: 'fay' })
    await lockAccountFromManySources('fay')
    const issued = await asUser(app.baseUrl, rootSession, `/api/admin/users/${fay.id}/password-reset`, { method: 'POST' })
    expect(issued.status).toBe(201)
    const token = tokenOf(parseExact(issuedPasswordResetSchema, await issued.json()).url)
    expect(await accountRows('fay')).toBeGreaterThan(0)
    const completed = await postPublic(tight.baseUrl, '/api/auth/password-resets/complete', { token, password: NEW_PASSWORD }, { 'x-forwarded-for': S1 })
    expect(completed.status).toBe(200)
    expect(await accountRows('fay')).toBe(0)
    expect(await statusFrom(tight, S1, 'fay', NEW_PASSWORD)).toBe(200)
    expect(await statusFrom(tight, S4, 'fay', NEW_PASSWORD)).toBe(200)
  })

  it('账户建成之前，别人用这个登录名从很多来源试过：受邀人接受之后照样能用自己的密码登录', async () => {
    await lockAccountFromManySources('gus')
    const invited = await asUser(app.baseUrl, rootSession, '/api/admin/invitations', { method: 'POST', body: { username: 'gus', displayName: '格斯' } })
    expect(invited.status).toBe(201)
    const token = tokenOf(parseExact(issuedInvitationSchema, await invited.json()).url)
    const accepted = await postPublic(tight.baseUrl, '/api/auth/invitations/accept', { token, displayName: '格斯', password: NEW_PASSWORD })
    expect(accepted.status).toBe(200)
    expect(await accountRows('gus')).toBe(0)
    expect(await statusFrom(tight, S1, 'gus', NEW_PASSWORD)).toBe(200)
  })
})

describe('US-M2-04 系统管理员解除登录锁定（M2-P6 复核 A1）', () => {
  it('账户页显示锁定；成员调解除的接口被拒（403），锁定照旧；系统管理员解除之后本人立即能登录，记审计，账户页不再显示锁定', async () => {
    const hal = await createAccount(database, { username: 'hal' })
    const member = await createAccount(database, { username: 'plain-member' })
    const memberSession = await login(app.baseUrl, 'plain-member', member.password)
    await lockAccountFromManySources('hal')
    expect((await adminView('hal')).loginLock?.allSources).toBe(true)

    const denied = await asUser(app.baseUrl, memberSession, `/api/admin/users/${hal.id}/unlock-login`, { method: 'POST' })
    expect(denied.status).toBe(403)
    expect(await codeOf(denied)).toBe('PERMISSION_DENIED')
    expect(await statusFrom(tight, S4, 'hal', hal.password)).toBe(429)

    const response = await asUser(app.baseUrl, rootSession, `/api/admin/users/${hal.id}/unlock-login`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ id: hal.id, loginLock: null })
    expect(await accountRows('hal')).toBe(0)
    expect((await adminView('hal')).loginLock).toBeNull()
    // 原来被锁的来源也能登录：清掉的是这个账户在所有来源上的计数
    expect(await statusFrom(tight, S1, 'hal', hal.password)).toBe(200)
    const audits = await database.query(async client => (await client.query<{ action: string, actor_id: string, target_id: string, details: unknown }>(
      'SELECT action, actor_id, target_id, details FROM audit_events WHERE request_id = $1',
      [requestIdOf(response)],
    )).rows)
    expect(audits).toEqual([{ action: 'users.login_unlocked', actor_id: root.id, target_id: hal.id, details: {} }])
  })

  it('没有可清的计数时：原样返回，不记审计；账户不存在：404', async () => {
    const ivy = await createAccount(database, { username: 'ivy' })
    const response = await asUser(app.baseUrl, rootSession, `/api/admin/users/${ivy.id}/unlock-login`, { method: 'POST' })
    expect(parseExact(adminUserSchema, await response.json())).toMatchObject({ id: ivy.id, loginLock: null })
    const [count] = await database.query(async client => (await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_events WHERE action = \'users.login_unlocked\' AND target_id = $1',
      [ivy.id],
    )).rows)
    expect(count).toEqual({ count: 0 })
    expect(await codeOf(await asUser(app.baseUrl, rootSession, '/api/admin/users/0192f0c8-0000-7000-8000-00000000dead/unlock-login', { method: 'POST' }))).toBe('NOT_FOUND')
  })

  it('只按来源的计数不属于任何账户：解除锁定不动它', async () => {
    const jon = await createAccount(database, { username: 'jon' })
    expect(await statusFrom(tight, S1, 'jon', 'wrong')).toBe(401)
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${jon.id}/unlock-login`, { method: 'POST' })).status).toBe(200)
    const [address] = await database.query(async client => (await client.query<{ failures: number }>(
      'SELECT failures FROM auth_login_throttles WHERE key_hash = $1',
      [digest(`ip:${S1}`)],
    )).rows)
    expect(address).toEqual({ failures: 1 })
  })
})

describe('成功时锁三行计数的顺序（M2-P6 复核 A1）：账户 → 账户与地址 → 地址', () => {
  /** 另开一个连接试着立即锁住这一行（NOWAIT）：被别的事务锁着时返回假；试完就回滚 */
  async function canLockNow(key: Buffer): Promise<boolean> {
    return database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT 1 FROM auth_login_throttles WHERE key_hash = $1 FOR UPDATE NOWAIT', [key])
        return true
      }
      catch (error) {
        if ((error as { code?: string }).code === '55P03')
          return false
        throw error
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  }

  it('成功的登录卡在"账户与地址"那一行时：账户那一行已经被它锁着，地址那一行还没有碰', async () => {
    const kim = await createAccount(database, { username: 'kim' })
    // 先失败一次：三个维度的计数都有了行
    expect(await statusFrom(app, S1, 'kim', 'wrong')).toBe(401)
    const account = digest('account:kim')
    const accountAddress = digest(`account-address:kim|ip:${S1}`)
    const address = digest(`ip:${S1}`)
    const probes: { account?: boolean, address?: boolean } = {}
    // 持有"账户与地址"那一行的 KEY SHARE：占名额（只改非键列）不受影响，成功时的事务删除这一行要等它
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM auth_login_throttles WHERE key_hash = $1 FOR KEY SHARE', [accountAddress]),
      request: async () => loginFrom(app, S1, 'kim', kim.password),
      change: async () => {
        probes.account = await canLockNow(account)
        probes.address = await canLockNow(address)
      },
    })
    expect(response.status).toBe(200)
    expect(probes).toEqual({ account: false, address: true })
  })

  it('同一个账户在同一个来源上两次成功的登录同时卡在计数行上：放开之后都成功，没有互相等待成环；计数随之清除与退回', async () => {
    const lea = await createAccount(database, { username: 'lea' })
    expect(await statusFrom(app, S2, 'lea', 'wrong')).toBe(401)
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM auth_login_throttles WHERE key_hash = $1 FOR KEY SHARE', [digest('account:lea')]),
      request: async () => Promise.all([loginFrom(app, S2, 'lea', lea.password), loginFrom(app, S2, 'lea', lea.password)]),
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(await accountRows('lea')).toBe(0)
    // 地址维度只退回两次成功各自占的名额：之前那次失败照算
    const [address] = await database.query(async client => (await client.query<{ failures: number }>(
      'SELECT failures FROM auth_login_throttles WHERE key_hash = $1',
      [digest(`ip:${S2}`)],
    )).rows)
    expect(address).toEqual({ failures: 1 })
  })
})

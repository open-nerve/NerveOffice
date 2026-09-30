// 改动账户的并发（M2-P1 审查 A1、A2、A9、A10、A12，复验 N1–N3）：验证在事务之外，事务里先锁账户行再复核；锁的顺序统一，
// 互相等待时不成环；管理操作在锁里复核操作者。
// 用两个连接构造确定的交错：一个连接持锁，等被测的请求在锁上等着了，再改数据、提交（support/held-lock.ts）。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomBytes } from 'node:crypto'
import { errorResponseSchema, issuedInvitationSchema, issuedPasswordResetSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, passwordHashOf } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { linkInvalidReasonOf, postPublic, tokenDigest, tokenOf } from '../support/links.ts'
import { requestIdOf } from '../support/request-id.ts'
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

/** 哈希参数比应用的配置旧的账户：登录成功时按当前参数重新哈希 */
const OLD_ARGON2 = { memoryCost: 12_288, timeCost: 3, parallelism: 1 }

/** 别处改了密码（修改、签发或完成重置）：与应用相同，换哈希的同时凭据的版本加一 */
const CHANGE_PASSWORD_ELSEWHERE = 'UPDATE users SET password_hash = $1, password_version = password_version + 1 WHERE id = $2'

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
      request: async () => postLogin(app.baseUrl, { username: 'amy', password: amy.password }),
      change: async client => client.query(CHANGE_PASSWORD_ELSEWHERE, [changed, amy.id]),
    })
    expect(response.status).toBe(401)
    expect(await codeOf(response)).toBe('INVALID_CREDENTIALS')
    expect(await count('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1', [amy.id])).toBe(0)
    expect(await one('SELECT action, target_id FROM audit_events WHERE request_id = $1', [requestIdOf(response)])).toEqual({ action: 'auth.login_failed', target_id: amy.id })
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

  it('登录按新参数重新哈希时，别处刚改了密码：不覆盖回去（条件更新，审查 A3），这次登录按凭据无效处理', async () => {
    const old = await createAccount(database, { username: 'oldparams', argon2: OLD_ARGON2 })
    const changed = await passwordHashOf('changed elsewhere')
    // 重新哈希是事务之外的一条更新，在持锁的连接上等着；放开之前把密码改掉
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(old),
      request: async () => postLogin(app.baseUrl, { username: 'oldparams', password: old.password }),
      change: async client => client.query(CHANGE_PASSWORD_ELSEWHERE, [changed, old.id]),
    })
    expect(response.status).toBe(401)
    expect(await passwordHashOfAccount(old)).toBe(changed)
    expect((await postLogin(app.baseUrl, { username: 'oldparams', password: 'changed elsewhere' })).status).toBe(200)
  })

  it('同一个人（哈希的参数过时）两次正确的登录同时进行：都成功，不把后一次当成密码错误（复验 N1）', async () => {
    const twin = await createAccount(database, { username: 'twin', argon2: OLD_ARGON2 })
    // 两次登录都对旧哈希验证通过、都要重新哈希：两次条件更新都成立（版本没变，写的都是同一个密码的编码），两次复核按版本都通过
    const responses = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(twin),
      request: async () => Promise.all([
        postLogin(app.baseUrl, { username: 'twin', password: twin.password }),
        postLogin(app.baseUrl, { username: 'twin', password: twin.password }),
      ]),
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(await count('SELECT count(*)::int AS count FROM audit_events WHERE action = \'auth.login_failed\' AND target_id = $1', [twin.id])).toBe(0)
  })

  it('凭据的版本：修改密码、签发与完成重置时经应用加一；登录时按新参数重新哈希只换编码，版本不变（复验 X1、X2）', async () => {
    const eli = await createAccount(database, { username: 'eli', argon2: OLD_ARGON2 })
    const versionOf = async () => one<{ password_version: number, password_hash: string }>('SELECT password_version, password_hash FROM users WHERE id = $1', [eli.id])
    const before = await versionOf()
    const here = await login(app.baseUrl, 'eli', eli.password)
    const rehashed = await versionOf()
    expect(rehashed?.password_hash).not.toBe(before?.password_hash)
    expect(rehashed?.password_version).toBe(before?.password_version)
    expect((await asUser(app.baseUrl, here, '/api/auth/password', { method: 'PUT', body: { currentPassword: eli.password, newPassword: 'eli second password' } })).status).toBe(200)
    expect((await versionOf())?.password_version).toBe((before?.password_version ?? 0) + 1)
    const token = await issuedResetToken(eli)
    expect((await versionOf())?.password_version).toBe((before?.password_version ?? 0) + 2)
    expect((await completeReset(token)).status).toBe(200)
    expect((await versionOf())?.password_version).toBe((before?.password_version ?? 0) + 3)
  })

  it('修改密码验证过旧密码之后，同一个人的另一次登录按新参数重新哈希了（密码没变）：照常修改（按凭据的版本复核，复验 X2）', async () => {
    const dot = await createAccount(database, { username: 'dot', argon2: OLD_ARGON2 })
    // 修改密码要先登录：登录会顺带重新哈希，之后把哈希换回旧参数（同一个密码、版本不变），下一次登录又会重新哈希
    const here = await login(app.baseUrl, 'dot', dot.password)
    await database.query(async client => client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await passwordHashOf(dot.password, OLD_ARGON2), dot.id]))
    const [relogin, change] = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(dot),
      request: async ({ step, waitForWaiting }) => {
        // 先让登录的重新哈希在账户行上等着，再发修改密码（它验证旧密码时哈希还是旧的）
        const loginAgain = step(postLogin(app.baseUrl, { username: 'dot', password: dot.password }))
        await waitForWaiting(1)
        const change = step(asUser(app.baseUrl, here, '/api/auth/password', { method: 'PUT', body: { currentPassword: dot.password, newPassword: 'dot wants this new one' } }))
        return Promise.all([loginAgain, change])
      },
      waiting: 2,
      change: async () => undefined,
    })
    // 重新哈希只换编码、版本不变：修改密码照常成功。那次登录排在修改之后提交，这时密码已经改了，按凭据变了拒绝
    expect(change.status).toBe(200)
    expect(relogin.status).toBe(401)
    expect((await postLogin(app.baseUrl, { username: 'dot', password: 'dot wants this new one' })).status).toBe(200)
  })

  it('修改密码验证过旧密码之后，别处改了密码（例如签发了重置）：403，不覆盖别处设的密码，记审计', async () => {
    const cid = await createAccount(database, { username: 'cid' })
    const here = await login(app.baseUrl, 'cid', cid.password)
    const changed = await passwordHashOf('changed elsewhere')
    const response = await raceAgainstHeldLock(database, {
      hold: lockAccountRow(cid),
      request: async () => asUser(app.baseUrl, here, '/api/auth/password', { method: 'PUT', body: { currentPassword: cid.password, newPassword: 'cid wants this one' } }),
      change: async client => client.query(CHANGE_PASSWORD_ELSEWHERE, [changed, cid.id]),
    })
    expect(response.status).toBe(403)
    expect(await codeOf(response)).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(await passwordHashOfAccount(cid)).toBe(changed)
    // 审计的原因与"旧密码不对"分开：管理员查得到是别处改了密码（复验 N6）
    expect(await one('SELECT details FROM audit_events WHERE action = \'users.password_change_failed\' AND target_id = $1', [cid.id])).toEqual({ details: { reason: 'credentials_changed' } })
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

  it('别的事务持有账户行的 FOR KEY SHARE（例如插入引用它的行时的外键检查）：签发重置不等它（账户行用 FOR NO KEY UPDATE）', async () => {
    const kim = await createAccount(database, { username: 'kim' })
    // 用 FOR UPDATE 时会等到应用的锁等待上限（5 秒）之后 500；两个管理员同时互相签发时还会死锁
    const status = await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT 1 FROM users WHERE id = $1 FOR KEY SHARE', [kim.id])
        return (await issueReset(kim)).status
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
    expect(status).toBe(201)
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
      request: async () => completeReset(token),
      change: async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [fay.id]),
    })
    expect(await linkInvalidReasonOf(response)).toBe('revoked')
    expect(await passwordHashOfAccount(fay)).toBe(before)
    expect(await one('SELECT action, actor_type, target_type, target_id, details FROM audit_events WHERE request_id = $1', [requestIdOf(response)])).toEqual({
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
      request: async () => completeReset(token),
      change: async client => client.query('UPDATE auth_password_resets SET used_at = now() WHERE token_hash = $1', [tokenDigest(token)]),
    })
    expect(await linkInvalidReasonOf(response)).toBe('used')
    expect(await one('SELECT details FROM audit_events WHERE request_id = $1', [requestIdOf(response)])).toEqual({ details: { purpose: 'password_reset', reason: 'used' } })
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

  it('操作者在取到锁之前被取消了系统管理员：各管理操作都 403，不留下任何变化（审查 A12，复验 N3）', async () => {
    const ivy = await createAccount(database, { username: 'ivy' })
    const gone = await createAccount(database, { username: 'gone' })
    await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [gone.id]))
    const pending = await issuedInvitation('pending-inv')
    // ivy 留下登录失败的计数：解除登录锁定（M2-P6 复核 A1）被拒之后，计数应当还在
    expect((await postLogin(app.baseUrl, { username: 'ivy', password: 'wrong password' })).status).toBe(401)
    const ivyCounters = async () => count('SELECT count(*)::int AS count FROM auth_login_throttles WHERE account_hash = sha256(convert_to(\'account:ivy\', \'UTF8\'))', [])
    expect(await ivyCounters()).toBe(2)
    const operations: [string, (session: LoggedIn) => Promise<Response>][] = [
      ['停用', async session => asUser(app.baseUrl, session, `/api/admin/users/${ivy.id}/disable`, { method: 'POST' })],
      ['启用', async session => asUser(app.baseUrl, session, `/api/admin/users/${gone.id}/enable`, { method: 'POST' })],
      ['设为系统管理员', async session => asUser(app.baseUrl, session, `/api/admin/users/${ivy.id}/system-role`, { method: 'PUT', body: { systemRole: 'admin' } })],
      ['签发重置', async session => asUser(app.baseUrl, session, `/api/admin/users/${ivy.id}/password-reset`, { method: 'POST' })],
      ['签发邀请', async session => asUser(app.baseUrl, session, '/api/admin/invitations', { method: 'POST', body: { username: 'never-invited', displayName: '不会被邀请' } })],
      ['作废邀请', async session => asUser(app.baseUrl, session, `/api/admin/invitations/${pending.id}/revoke`, { method: 'POST' })],
      ['重发邀请', async session => asUser(app.baseUrl, session, `/api/admin/invitations/${pending.id}/reissue`, { method: 'POST' })],
      ['解除登录锁定', async session => asUser(app.baseUrl, session, `/api/admin/users/${ivy.id}/unlock-login`, { method: 'POST' })],
    ]
    for (const [index, [name, operate]] of operations.entries()) {
      const boss = await createAccount(database, { username: `boss-${index}`, systemRole: 'admin' })
      const bossSession = await login(app.baseUrl, `boss-${index}`, boss.password)
      // 持有 system-admins 的排他锁（取消、停用系统管理员取的就是它）：管理操作在它上面等着；放开之前取消这位操作者
      const response = await raceAgainstHeldLock(database, {
        hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:system-admins\', 0))'),
        request: async () => operate(bossSession),
        change: async client => client.query('UPDATE users SET system_role = \'member\' WHERE id = $1', [boss.id]),
      })
      expect(response.status, name).toBe(403)
      expect(await codeOf(response), name).toBe('PERMISSION_DENIED')
    }
    expect(await one('SELECT status, system_role FROM users WHERE id = $1', [ivy.id])).toEqual({ status: 'active', system_role: 'member' })
    expect(await one('SELECT status FROM users WHERE id = $1', [gone.id])).toEqual({ status: 'disabled' })
    expect(await count('SELECT count(*)::int AS count FROM auth_password_resets WHERE user_id = $1', [ivy.id])).toBe(0)
    expect(await count('SELECT count(*)::int AS count FROM auth_invitations WHERE username = $1', ['never-invited'])).toBe(0)
    expect(await one('SELECT revoked_at FROM auth_invitations WHERE id = $1', [pending.id])).toEqual({ revoked_at: null })
    expect(await ivyCounters()).toBe(2)
  })

  it('停用已锁住账户行、在重置行上等着时，带这个账户旧 Cookie 的登录进来：登录排在停用后面（先要账户行），复核不通过，没有死锁', async () => {
    const jon = await createAccount(database, { username: 'jon' })
    const previous = await login(app.baseUrl, 'jon', jon.password)
    // 未用的重置直接写进库里：经接口签发会让密码失效，登录就走不到事务里了
    await database.query(async client => client.query(
      'INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'1 day\')',
      [jon.id, tokenDigest(randomBytes(32).toString('base64url'))],
    ))
    // 锁的顺序不统一时（账户行用 FOR UPDATE、登录不先锁账户行），登录先占了旧会话的行、再等账户行，
    // 停用拿着账户行、随后要撤销那条会话，两边互相等待，一方 500
    const responses = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT 1 FROM auth_password_resets WHERE user_id = $1 FOR UPDATE', [jon.id]),
      request: async ({ step, waitForWaiting }) => {
        const disable = step(asUser(app.baseUrl, adminSession, `/api/admin/users/${jon.id}/disable`, { method: 'POST' }))
        await waitForWaiting(1)
        const relogin = step(postLogin(app.baseUrl, { username: 'jon', password: jon.password }, { cookie: previous.cookie }))
        return Promise.all([disable, relogin])
      },
      waiting: 2,
      change: async () => undefined,
    })
    expect(responses.map(response => response.status)).toEqual([200, 401])
    expect(await count('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [jon.id])).toBe(0)
  })
})

describe('US-M2-04 管理员给自己签发了重置，同时有人停用他（M2-P6 复核 A2：锁的顺序是账户行在前、链接行在后）', () => {
  /** 一位管理员给自己签发重置：自己的会话随即撤销，旧密码失效；返回令牌与这条重置的 id */
  async function selfIssuedReset(username: string) {
    const self = await createAccount(database, { username, systemRole: 'admin' })
    const session = await login(app.baseUrl, username, self.password)
    const response = await asUser(app.baseUrl, session, `/api/admin/users/${self.id}/password-reset`, { method: 'POST' })
    expect(response.status, await response.clone().text()).toBe(201)
    const token = tokenOf(parseExact(issuedPasswordResetSchema, await response.json()).url)
    const row = await one<{ id: string }>('SELECT id FROM auth_password_resets WHERE token_hash = $1', [tokenDigest(token)])
    if (row === undefined)
      throw new Error('签发之后库里没有这条重置')
    return { self, token, resetId: row.id }
  }

  function lockResetRow(resetId: string) {
    return async (client: pg.Client) => client.query('SELECT 1 FROM auth_password_resets WHERE id = $1 FOR UPDATE', [resetId])
  }

  async function disable(account: TestAccount): Promise<Response> {
    return asUser(app.baseUrl, adminSession, `/api/admin/users/${account.id}/disable`, { method: 'POST' })
  }

  it('完成重置先锁住账户行、在重置行上等着，停用在账户行上等它：放开之后两边都成功，没有互相等待；刚得到的会话随停用撤销', async () => {
    const { self, token, resetId } = await selfIssuedReset('self-race-1')
    // 完成重置要是先锁重置行、再锁账户行，这里就成环：它拿着重置行等账户行，停用拿着账户行等重置行，一方 500
    const [completed, disabled] = await raceAgainstHeldLock(database, {
      hold: lockResetRow(resetId),
      request: async ({ step, waitForWaiting }) => {
        const complete = step(completeReset(token))
        await waitForWaiting(1)
        const disabling = step(disable(self))
        return Promise.all([complete, disabling])
      },
      waiting: 2,
      change: async () => undefined,
    })
    expect([completed.status, disabled.status]).toEqual([200, 200])
    expect(await one('SELECT status FROM users WHERE id = $1', [self.id])).toEqual({ status: 'disabled' })
    expect(await one('SELECT used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM auth_password_resets WHERE id = $1', [resetId])).toEqual({ used: true, revoked: false })
    expect(await count('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [self.id])).toBe(0)
  })

  it('停用先锁住账户行、作废他的重置时在重置行上等着，完成重置在账户行上等它：放开之后重置已作废，完成是 410（revoked），密码不变', async () => {
    const { self, token, resetId } = await selfIssuedReset('self-race-2')
    const before = await passwordHashOfAccount(self)
    const [disabled, completed] = await raceAgainstHeldLock(database, {
      hold: lockResetRow(resetId),
      request: async ({ step, waitForWaiting }) => {
        const disabling = step(disable(self))
        await waitForWaiting(1)
        const complete = step(completeReset(token))
        return Promise.all([disabling, complete])
      },
      waiting: 2,
      change: async () => undefined,
    })
    expect(disabled.status).toBe(200)
    expect(await linkInvalidReasonOf(completed)).toBe('revoked')
    expect(await passwordHashOfAccount(self)).toBe(before)
    expect(await one('SELECT used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM auth_password_resets WHERE id = $1', [resetId])).toEqual({ used: false, revoked: true })
    // 给自己签发的是这个账户的重置：随停用按 account_disabled 作废，只记一次
    expect(await one('SELECT details FROM audit_events WHERE action = \'users.password_reset_revoked\' AND request_id = $1', [requestIdOf(disabled)])).toEqual({ details: { passwordResetId: resetId, reason: 'account_disabled' } })
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
      request: async () => postPublic(app.baseUrl, '/api/auth/invitations/accept', { token: issued.token, displayName: '莉亚', password: 'a good long password' }),
      change: async client => client.query('UPDATE auth_invitations SET revoked_at = now(), revoked_by = $1 WHERE id = $2', [admin.id, issued.id]),
    })
    expect(await linkInvalidReasonOf(response)).toBe('revoked')
    expect(await count('SELECT count(*)::int AS count FROM users WHERE username = \'lea\'', [])).toBe(0)
    expect(await one('SELECT action, target_type, target_id, details FROM audit_events WHERE request_id = $1', [requestIdOf(response)])).toEqual({
      action: 'auth.link_rejected',
      target_type: 'invitation',
      target_id: issued.id,
      details: { purpose: 'invitation', reason: 'revoked' },
    })
  })
})

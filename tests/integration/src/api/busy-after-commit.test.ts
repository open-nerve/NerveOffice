// 数据库繁忙回 503 的意思是"这个请求的写入确定没有生效"（ADR-006）。M2-P6 第 3 片复验发现几个写接口在业务事务提交之后
// 还在连接池上读库拼响应，那一步遇到繁忙也回 503，而写入其实已经生效。这里核对两件事：
// 1. 结构性的保证：同一个请求里事务提交之后再遇到数据库繁忙，异常过滤器按这个请求的记录（CommitLedger）回 500（结果未知）。
//    生产代码里已经没有这样的写接口，用只在测试里存在的接口走真实的请求链路（JSON 请求体、守卫、拦截器、异常过滤器）；
// 2. 拼响应用的读挪进了业务事务：那一步遇到繁忙时整个事务回滚，回 503，什么都没改（密码没换、没有新会话、没有 Set-Cookie……）。
//    业务事务在那之前已经碰过那张表时，表锁挡不住它自己（它再要锁时排到等锁的人前面），改为核对"提交之后不再碰那张表"：
//    事务停在最后一步之前，给那张表排一把锁，再放它走——请求照常成功；读挪回提交之后的话，那一步等锁超时，回 500。
// 构造都是确定的：应用等锁 300 毫秒就放弃；测试的连接持着锁直到被测的请求结束，或者让请求停在另一把锁上，不靠等待时长。
import type { Transaction } from '@nerve-office/api'
import type { Database } from '@nerve-office/api/testing'
import type { Buffer } from 'node:buffer'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { TableLock } from '../support/held-lock.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { createHash } from 'node:crypto'
import { DatabaseModule, Public, TransactionRunner } from '@nerve-office/api'
import { DATABASE } from '@nerve-office/api/testing'
import { REQUEST_ID_HEADER } from '@nerve-office/contracts'
import { Controller, HttpCode, Inject, Module, Post } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { completesWithoutWaiting, lockTable, raceAgainstHeldLock, requestTableLock, whileHolding } from '../support/held-lock.ts'
import { postPublic, tokenOf } from '../support/links.ts'
import { asUser, login, postLogin, sessionSetCookie } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

/**
 * 只在测试里存在的接口：after-commit 先提交一个写了一行的事务，再在连接池上读一张表；before-commit 在同一个事务里写一行、再读那张表。
 * 测试锁住那张表时，前者的繁忙出现在提交之后，后者出现在提交之前
 */
@Public()
@Controller('__test/commits')
class CommitProbeController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly transactions: TransactionRunner,
  ) {}

  @Post('after-commit')
  @HttpCode(204)
  async afterCommit(): Promise<void> {
    await this.transactions.run(async transaction => executorOf(transaction).execute(sql`INSERT INTO commit_probe DEFAULT VALUES`))
    await this.db.execute(sql`SELECT count(*) FROM probe_locked`)
  }

  @Post('before-commit')
  @HttpCode(204)
  async beforeCommit(): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await executorOf(transaction).execute(sql`INSERT INTO commit_probe DEFAULT VALUES`)
      await executorOf(transaction).execute(sql`SELECT count(*) FROM probe_locked`)
    })
  }
}

/** 测试接口在事务里执行语句：事务对象本身就是 Drizzle 的执行器（生产代码里只有仓储能这样做） */
function executorOf(transaction: Transaction): Database {
  return transaction as unknown as Database
}

@Module({ imports: [DatabaseModule], controllers: [CommitProbeController] })
class CommitProbeModule {}

/** 只在这个库里：探针用的两张表；审计的闸门——按动作取 advisory 共享锁，测试持有同一个键的排他锁时，写这条审计的事务停在这里 */
const TEST_DDL = `
CREATE TABLE commit_probe (id serial PRIMARY KEY);
CREATE TABLE probe_locked (id integer);
CREATE FUNCTION audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('audit-gate:' || NEW.action, 0));
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_gate();
`

/** 数据库繁忙时的 Retry-After（apps/api 的 DATABASE_BUSY_RETRY_AFTER_SECONDS） */
const RETRY_AFTER = '5'
const NEW_PASSWORD = 'a brand new long password'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let rootSession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(TEST_DDL))
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_LOCK_TIMEOUT_MS: '300' }, additionalModules: [CommitProbeModule] })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  rootSession = await login(app.baseUrl, 'root', root.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function count(query: string, values: unknown[] = []): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

/** 限流计数的键的摘要（与 auth 的 throttle-keys 一致） */
function digest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

/** 这个账户相关的两个维度上记着的失败次数（只按用户名、按用户名与来源） */
async function accountFailures(username: string): Promise<number> {
  return count('SELECT coalesce(sum(failures), 0) AS count FROM auth_login_throttles WHERE account_hash = $1', [digest(`account:${username}`)])
}

/** 一次性链接按地址记着的失败次数（测试都从本机发出） */
async function linkFailures(): Promise<number> {
  return count('SELECT coalesce(sum(failures), 0) AS count FROM auth_login_throttles WHERE key_hash = $1', [digest('link:ip:127.0.0.1')])
}

interface AccountState { readonly password_hash: string, readonly password_version: number, readonly status: string, readonly system_role: string }

/** 账户的凭据、状态与系统角色：核对"什么都没改" */
async function credentialsOf(userId: string): Promise<AccountState | undefined> {
  return database.query(async client => (await client.query<AccountState>('SELECT password_hash, password_version, status, system_role FROM users WHERE id = $1', [userId])).rows[0])
}

/** 503 带 Retry-After，没有下发会话的 Cookie */
async function expectBusy(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(503)
  expect(response.headers.get('retry-after')).toBe(RETRY_AFTER)
  expect(sessionSetCookie(response)).toBeUndefined()
}

async function invite(username: string): Promise<{ readonly id: string, readonly token: string }> {
  const response = await asUser(app.baseUrl, rootSession, '/api/admin/invitations', { method: 'POST', body: { username, displayName: username } })
  expect(response.status, await response.clone().text()).toBe(201)
  const issued = (await response.json()) as { invitation: { id: string }, url: string }
  return { id: issued.invitation.id, token: tokenOf(issued.url) }
}

/** 在持锁的事务里关上这个审计动作的闸门 */
function holdGate(action: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}`])
}

/**
 * 业务事务停在 pause 上（它已经碰过 table）：给 table 排一把锁，确认它排在业务事务后面，再放开 pause（之前先执行 beforeRelease）。
 * 返回被测请求的响应；锁随后放开
 */
async function queuedBehind<T>(options: {
  readonly pause: (client: pg.Client) => Promise<unknown>
  readonly table: string
  readonly request: () => Promise<T>
  readonly beforeRelease?: (client: pg.Client) => Promise<unknown>
}): Promise<T> {
  let lock: TableLock | undefined
  try {
    return await raceAgainstHeldLock(database, {
      hold: options.pause,
      request: async () => options.request(),
      change: async (client) => {
        lock = await requestTableLock(database, options.table)
        // 排着：业务事务持有这张表上的锁（它还停在 pause 上），所以有两个连接在等
        expect(await completesWithoutWaiting(database, lock.granted, 2)).toBe(false)
        await options.beforeRelease?.(client)
      },
    })
  }
  finally {
    await lock?.release()
  }
}

describe('同一个请求里事务提交之后遇到数据库繁忙：按意外错误回 500（结果未知），不回 503（CommitLedger）', () => {
  it('提交之后在连接池上读一张被锁住的表：500 INTERNAL_ERROR、不带 Retry-After，写入已经生效；日志记 error，写明是提交之后的繁忙与原因', async () => {
    const before = await count('SELECT count(*) FROM commit_probe')
    const response = await whileHolding(database, lockTable('probe_locked'), async () => postPublic(app.baseUrl, '/api/__test/commits/after-commit', {}))
    expect(response.status).toBe(500)
    expect(response.headers.get('retry-after')).toBeNull()
    const requestId = response.headers.get(REQUEST_ID_HEADER)
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试', requestId } })
    expect(await count('SELECT count(*) FROM commit_probe')).toBe(before + 1)
    const lines = app.logs.entries().filter(line => line.requestId === requestId)
    expect(lines.find(line => line.reason === 'lock_timeout')).toMatchObject({ level: 'error', msg: expect.stringContaining('事务提交之后遇到数据库繁忙') as unknown })
    expect(lines.find(line => line.statusCode === 500)).toMatchObject({ level: 'error' })
    expect(lines.filter(line => line.level === 'warn')).toEqual([])
  })

  it('同样的繁忙出现在提交之前（事务里）：503 带 Retry-After，事务回滚、什么也没写；记录按请求分开，前一个请求提交过不算', async () => {
    expect((await postPublic(app.baseUrl, '/api/__test/commits/after-commit', {})).status).toBe(204)
    const before = await count('SELECT count(*) FROM commit_probe')
    const response = await whileHolding(database, lockTable('probe_locked'), async () => postPublic(app.baseUrl, '/api/__test/commits/before-commit', {}))
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe(RETRY_AFTER)
    expect(await count('SELECT count(*) FROM commit_probe')).toBe(before)
    // 放开之后照常
    expect((await postPublic(app.baseUrl, '/api/__test/commits/before-commit', {})).status).toBe(204)
  })
})

describe('拼响应的读在业务事务里：那一步遇到数据库繁忙，整个事务回滚，回 503，什么都没改（M2-P6 第 3 片复验）', () => {
  it('登录：拼响应时读个人空间等锁超时——没有新会话、没有登录成功的审计，占的名额退回（密码已经确认是对的）', async () => {
    const amy = await createAccount(database, { username: 'login-amy' })
    const response = await whileHolding(database, lockTable('spaces'), async () => postLogin(app.baseUrl, { username: 'login-amy', password: amy.password }))
    await expectBusy(response)
    expect(await count('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [amy.id])).toBe(0)
    expect(await count('SELECT count(*) FROM audit_events WHERE action = \'auth.login_succeeded\' AND actor_id = $1', [amy.id])).toBe(0)
    expect(await accountFailures('login-amy')).toBe(0)
    // 放开之后重试成功
    expect((await postLogin(app.baseUrl, { username: 'login-amy', password: amy.password })).status).toBe(200)
  })

  it('修改密码：拼响应时读个人空间等锁超时——密码没换、原来的会话照样能用、没有新会话，占的名额退回', async () => {
    const amy = await createAccount(database, { username: 'password-amy' })
    const session = await login(app.baseUrl, 'password-amy', amy.password)
    const before = await credentialsOf(amy.id)
    const change = async (): Promise<Response> => asUser(app.baseUrl, session, '/api/auth/password', { method: 'PUT', body: { currentPassword: amy.password, newPassword: NEW_PASSWORD } })
    await expectBusy(await whileHolding(database, lockTable('spaces'), change))
    expect(await credentialsOf(amy.id)).toEqual(before)
    expect(await count('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [amy.id])).toBe(1)
    expect((await asUser(app.baseUrl, session, '/api/auth/session')).status).toBe(200)
    expect(await accountFailures('password-amy')).toBe(0)
    expect((await change()).status).toBe(200)
  })

  it('完成重置：拼响应时读个人空间等锁超时——重置没有用掉、密码没换、没有新会话，链接的名额退回', async () => {
    const amy = await createAccount(database, { username: 'reset-amy' })
    const issued = await asUser(app.baseUrl, rootSession, `/api/admin/users/${amy.id}/password-reset`, { method: 'POST' })
    expect(issued.status).toBe(201)
    const token = tokenOf(((await issued.json()) as { url: string }).url)
    const before = await credentialsOf(amy.id)
    const linkFailuresBefore = await linkFailures()
    const complete = async (): Promise<Response> => postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token, password: NEW_PASSWORD })
    await expectBusy(await whileHolding(database, lockTable('spaces'), complete))
    expect(await credentialsOf(amy.id)).toEqual(before)
    expect(await count('SELECT count(*) FROM auth_password_resets WHERE user_id = $1 AND used_at IS NOT NULL', [amy.id])).toBe(0)
    expect(await count('SELECT count(*) FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [amy.id])).toBe(0)
    expect(await linkFailures()).toBe(linkFailuresBefore)
    const retried = await complete()
    expect(retried.status).toBe(200)
    expect(sessionSetCookie(retried)).toBeDefined()
  })

  it('接受邀请：事务里建个人空间时等锁超时——没有 Set-Cookie，账户没建、邀请没接受，链接的名额退回', async () => {
    const { token } = await invite('accept-busy')
    const linkFailuresBefore = await linkFailures()
    const accept = async (): Promise<Response> => postPublic(app.baseUrl, '/api/auth/invitations/accept', { token, displayName: '新同事', password: NEW_PASSWORD })
    await expectBusy(await whileHolding(database, lockTable('spaces'), accept))
    expect(await count('SELECT count(*) FROM users WHERE username = \'accept-busy\'')).toBe(0)
    expect(await count('SELECT count(*) FROM auth_invitations WHERE username = \'accept-busy\' AND accepted_at IS NOT NULL')).toBe(0)
    expect(await linkFailures()).toBe(linkFailuresBefore)
    expect((await accept()).status).toBe(200)
  })

  it.each([
    ['停用', 'disable', 'POST', undefined, { status: 'disabled' }],
    ['启用', 'enable', 'POST', undefined, { status: 'active' }],
    ['改系统角色', 'system-role', 'PUT', { systemRole: 'admin' }, { system_role: 'admin' }],
  ] as const)('管理员%s账户：拼响应时读登录锁定等锁超时——账户没改、没有审计', async (_name, path, method, body, changed) => {
    const target = await createAccount(database, { username: `admin-${path}` })
    if (path === 'enable')
      await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [target.id]))
    const before = await credentialsOf(target.id)
    const run = async (): Promise<Response> => asUser(app.baseUrl, rootSession, `/api/admin/users/${target.id}/${path}`, body === undefined ? { method } : { method, body })
    await expectBusy(await whileHolding(database, lockTable('auth_login_throttles'), run))
    expect(await credentialsOf(target.id)).toEqual(before)
    expect(await count('SELECT count(*) FROM audit_events WHERE target_id = $1', [target.id])).toBe(0)
    expect((await run()).status).toBe(200)
    expect(await credentialsOf(target.id)).toMatchObject(changed)
  })

  it('调整成员角色：拼响应时补名字等锁超时——角色没变、没有审计', async () => {
    const amy = await createAccount(database, { username: 'members-amy' })
    const ben = await createAccount(database, { username: 'members-ben' })
    const spaceId = await createTeamSpace(database, { name: '成员繁忙', createdBy: root.id, members: { [amy.id]: 'admin', [ben.id]: 'editor' } })
    const amySession = await login(app.baseUrl, 'members-amy', amy.password)
    const change = async (): Promise<Response> => asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'PUT', body: { role: 'viewer' } })
    let usersLock: TableLock | undefined
    try {
      // 请求停在锁空间行上（测试的连接持着这一行）：这时它的事务还没碰过账户表，给账户表加上锁，再放开空间行
      const response = await raceAgainstHeldLock(database, {
        hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR UPDATE', [spaceId]),
        request: change,
        change: async () => {
          usersLock = await requestTableLock(database, 'users')
          await usersLock.granted
        },
      })
      await expectBusy(response)
    }
    finally {
      await usersLock?.release()
    }
    expect(await count('SELECT count(*) FROM space_members WHERE space_id = $1 AND user_id = $2 AND role = \'editor\'', [spaceId, ben.id])).toBe(1)
    expect(await count('SELECT count(*) FROM audit_events WHERE action = \'spaces.member_role_changed\' AND target_id = $1', [spaceId])).toBe(0)
    expect((await change()).status).toBe(200)
  })
})

describe('事务里复核不通过时回滚，不留下一次提交：之后写失败的审计遇到数据库繁忙，回答的仍是确定的 503（M2-P6 第 3 片复验）', () => {
  it('登录：验证之后别处改了密码（复核不通过）、写失败的审计时繁忙——503，不是 500；没有新会话，这次按一次失败计', async () => {
    const amy = await createAccount(database, { username: 'changed-amy' })
    const response = await whileHolding(database, lockTable('audit_events'), async () => raceAgainstHeldLock(database, {
      // 登录的事务复核凭据时停在账户行上
      hold: async client => client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [amy.id]),
      request: async () => postLogin(app.baseUrl, { username: 'changed-amy', password: amy.password }),
      change: async client => client.query('UPDATE users SET password_version = password_version + 1 WHERE id = $1', [amy.id]),
    }))
    await expectBusy(response)
    expect(await count('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [amy.id])).toBe(0)
    expect(await accountFailures('changed-amy')).toBe(2)
  })

  it('接受邀请：查令牌之后邀请被作废（事务里复核不通过）、写拒绝的审计时繁忙——503，不是 500；账户没建', async () => {
    const { id, token } = await invite('revoked-later')
    const response = await whileHolding(database, lockTable('audit_events'), async () => raceAgainstHeldLock(database, {
      // 接受的事务锁邀请行时停在这里
      hold: async client => client.query('SELECT id FROM auth_invitations WHERE id = $1 FOR UPDATE', [id]),
      request: async () => postPublic(app.baseUrl, '/api/auth/invitations/accept', { token, displayName: '新同事', password: NEW_PASSWORD }),
      change: async client => client.query('UPDATE auth_invitations SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [id, root.id]),
    }))
    await expectBusy(response)
    expect(await count('SELECT count(*) FROM users WHERE username = \'revoked-later\'')).toBe(0)
  })
})

describe('提交之后不再访问数据库：业务事务已经碰过拼响应要读的那张表时，在它提交之前给那张表排一把锁，请求照常成功（M2-P6 第 3 片复验）', () => {
  it('接受邀请（个人空间是这个事务建的）：200，带着新会话的 Set-Cookie，账户建成', async () => {
    const { token } = await invite('accept-queued')
    const response = await queuedBehind({
      pause: holdGate('users.invitation_accepted'),
      table: 'spaces',
      request: async () => postPublic(app.baseUrl, '/api/auth/invitations/accept', { token, displayName: '新同事', password: NEW_PASSWORD }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(sessionSetCookie(response)).toBeDefined()
    expect(await count('SELECT count(*) FROM users WHERE username = \'accept-queued\'')).toBe(1)
  })

  it('解除登录锁定（这个事务清掉了计数）：200，响应里没有锁定', async () => {
    const dave = await createAccount(database, { username: 'unlock-dave' })
    expect((await postLogin(app.baseUrl, { username: 'unlock-dave', password: 'not the password' })).status).toBe(401)
    expect(await accountFailures('unlock-dave')).toBeGreaterThan(0)
    const response = await queuedBehind({
      pause: holdGate('users.login_unlocked'),
      table: 'auth_login_throttles',
      request: async () => asUser(app.baseUrl, rootSession, `/api/admin/users/${dave.id}/unlock-login`, { method: 'POST' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ id: dave.id, loginLock: null })
    expect(await accountFailures('unlock-dave')).toBe(0)
  })

  it('作废邀请（这个事务复核操作者时读过账户表）：200，响应里是作废之后的邀请与签发人', async () => {
    const { id } = await invite('revoke-queued')
    const response = await queuedBehind({
      pause: async client => client.query('SELECT id FROM auth_invitations WHERE id = $1 FOR UPDATE', [id]),
      table: 'users',
      request: async () => asUser(app.baseUrl, rootSession, `/api/admin/invitations/${id}/revoke`, { method: 'POST' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ id, status: 'revoked', createdBy: { id: root.id, username: 'root' } })
  })

  it('退出时会话已经被同一个浏览器换掉（这个事务撤销会话时碰过会话表）：按"换了令牌"回答 401，不清除 Cookie', async () => {
    const amy = await createAccount(database, { username: 'logout-amy' })
    const session = await login(app.baseUrl, 'logout-amy', amy.password)
    const sessionId = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM auth_sessions WHERE user_id = $1', [amy.id])).rows[0]?.id)
    const response = await queuedBehind({
      // 退出的事务撤销这条会话时停在它的行锁上
      pause: async client => client.query('SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE', [sessionId]),
      table: 'auth_sessions',
      request: async () => asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' }),
      // 同一个浏览器刚重新登录：这条会话换成了新的
      beforeRelease: async client => client.query('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = \'replaced\', idle_expires_at = least(idle_expires_at, now()) WHERE id = $1', [sessionId]),
    })
    expect(response.status, await response.clone().text()).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SESSION_EXPIRED')
    expect(sessionSetCookie(response)).toBeUndefined()
  })
})

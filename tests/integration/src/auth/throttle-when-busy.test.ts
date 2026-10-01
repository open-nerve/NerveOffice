// 数据库繁忙时的限流名额（M2-P6 第 3 片复验 建议 1）：登录、修改密码、一次性链接先在连接池上占名额，再验证。
// 这次尝试还没有得出"对不对"的结论（占名额占到一半、读凭据、读链接记录时繁忙），或者已经确认是对的（成功的那个事务里繁忙），
// 名额尽力退回——否则持续繁忙时，拿着正确密码重试的人会被自己的重试锁在门外；已经判定为猜错的（密码不对、令牌不存在），
// 之后写审计时繁忙照样计数，谁也不能借繁忙多猜一次。构造是确定的：应用等锁 300 毫秒就放弃，测试的连接持着锁直到请求结束。
import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { lockTable, whileHolding } from '../support/held-lock.ts'
import { postPublic } from '../support/links.ts'
import { postLogin } from '../support/session-client.ts'

/** 按用户名与来源的上限：重试这么多次就会锁定 */
const MAX_FAILURES = 3

let database: TestDatabase
let app: TestApp
let alice: TestAccount

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({
    databaseUrl: database.url,
    env: { NERVE_DATABASE_LOCK_TIMEOUT_MS: '300', NERVE_LOGIN_MAX_FAILURES: String(MAX_FAILURES), NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '30', NERVE_LOGIN_IP_MAX_FAILURES: '30' },
  })
  alice = await createAccount(database, { username: 'alice' })
})

beforeEach(async () => {
  await database.query(async client => client.query('DELETE FROM auth_login_throttles'))
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 限流计数的键的摘要（与 auth 的 throttle-keys 一致；测试都从本机发出） */
function digest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

const KEYS = {
  account: digest('account:alice'),
  accountAddress: digest('account-address:alice|ip:127.0.0.1'),
  address: digest('ip:127.0.0.1'),
  link: digest('link:ip:127.0.0.1'),
}

/** 各个键上记着的失败次数（没有这一行时为 0） */
async function failures(): Promise<Record<keyof typeof KEYS, number>> {
  const rows = await database.query(async client => (await client.query<{ key_hash: Buffer, failures: number }>('SELECT key_hash, failures FROM auth_login_throttles')).rows)
  const of = (key: Buffer): number => rows.find(row => row.key_hash.equals(key))?.failures ?? 0
  return { account: of(KEYS.account), accountAddress: of(KEYS.accountAddress), address: of(KEYS.address), link: of(KEYS.link) }
}

async function expectBusy(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(503)
  expect(response.headers.get('retry-after')).toBe('5')
}

async function count(query: string, values: unknown[] = []): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

describe('登录：还没有比对、或者已经确认是对的时候繁忙，名额退回', () => {
  it(`读凭据时繁忙（还没有比对密码）：连着 ${MAX_FAILURES + 1} 次都退回名额，之后用正确的密码照常登录，不会被自己的重试锁住`, async () => {
    await whileHolding(database, lockTable('users'), async () => {
      for (let attempt = 0; attempt <= MAX_FAILURES; attempt++)
        await expectBusy(await postLogin(app.baseUrl, { username: 'alice', password: alice.password }))
    })
    expect(await failures()).toEqual({ account: 0, accountAddress: 0, address: 0, link: 0 })
    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(200)
  })

  it('成功的那个事务里繁忙（密码已经确认是对的，新建会话时等锁超时）：名额退回，没有新会话', async () => {
    const sessions = await count('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [alice.id])
    await expectBusy(await whileHolding(database, lockTable('auth_sessions'), async () => postLogin(app.baseUrl, { username: 'alice', password: alice.password })))
    expect(await failures()).toEqual({ account: 0, accountAddress: 0, address: 0, link: 0 })
    expect(await count('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [alice.id])).toBe(sessions)
  })

  it('占名额占到一半繁忙（按用户名与来源的那一行被别的事务锁着）：已经占到的账户名额退回，地址的名额没有占', async () => {
    // 先失败一次：三个维度的计数都有了行，各记 1
    expect((await postLogin(app.baseUrl, { username: 'alice', password: 'not the password' })).status).toBe(401)
    expect(await failures()).toEqual({ account: 1, accountAddress: 1, address: 1, link: 0 })
    const response = await whileHolding(
      database,
      async client => client.query('SELECT 1 FROM auth_login_throttles WHERE key_hash = $1 FOR UPDATE', [KEYS.accountAddress]),
      async () => postLogin(app.baseUrl, { username: 'alice', password: alice.password }),
    )
    await expectBusy(response)
    expect(await failures()).toEqual({ account: 1, accountAddress: 1, address: 1, link: 0 })
  })
})

describe('登录：已经判定为猜错之后繁忙，照样计数', () => {
  it('密码不对之后写失败的审计时繁忙：三个维度都记一次失败（不退回），谁也不能借繁忙多猜一次', async () => {
    await expectBusy(await whileHolding(database, lockTable('audit_events'), async () => postLogin(app.baseUrl, { username: 'alice', password: 'not the password' })))
    expect(await failures()).toEqual({ account: 1, accountAddress: 1, address: 1, link: 0 })
  })
})

describe('一次性链接：读链接记录时繁忙退回名额；令牌不存在之后写审计时繁忙照样计数', () => {
  const token = (): string => randomBytes(32).toString('base64url')

  it('查令牌时繁忙（还不知道令牌对不对）：按地址的名额退回', async () => {
    await expectBusy(await whileHolding(database, lockTable('auth_invitations'), async () => postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: token() })))
    await expectBusy(await whileHolding(database, lockTable('auth_password_resets'), async () => postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: token(), password: 'a brand new long password' })))
    expect((await failures()).link).toBe(0)
  })

  it('没有这个令牌，之后写审计时繁忙：按地址记一次失败（不退回）', async () => {
    await expectBusy(await whileHolding(database, lockTable('audit_events'), async () => postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: token() })))
    expect((await failures()).link).toBe(1)
  })
})

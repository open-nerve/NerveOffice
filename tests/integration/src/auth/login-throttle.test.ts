// 登录限流在并发与各种来源下的行为（P3 设计 §3.5，P3 审查 A1、A2、A9、A10）：
// 先占用名额再验证，并发的请求不能都在锁定之前通过；清理在事务之外，并发时不死锁；
// 地址维度：成功登录只退回自己的名额；IPv6 按 /64；取不到合法地址时归到同一个键。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { performance } from 'node:perf_hooks'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { postLogin } from '../support/session-client.ts'

let database: TestDatabase
let alice: TestAccount
const apps: TestApp[] = []

beforeAll(async () => {
  database = await createTestDatabase()
  alice = await createAccount(database, { username: 'alice' })
})

beforeEach(async () => {
  await database.query(async client => client.query('DELETE FROM auth_login_throttles'))
})

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

afterAll(async () => {
  await database.drop()
})

async function start(env: Record<string, string>): Promise<TestApp> {
  const app = await startTestApp({ databaseUrl: database.url, env })
  apps.push(app)
  return app
}

async function rows<T extends Record<string, unknown>>(query: string, values: unknown[] = []): Promise<T[]> {
  return database.query(async client => (await client.query<T>(query, values)).rows)
}

/** 这批请求里真正验证过密码的次数：只有验证过的失败才写审计 */
async function failedAudits(prefix: string): Promise<number> {
  const [row] = await rows<{ count: string }>('SELECT count(*) AS count FROM audit_events WHERE action = \'auth.login_failed\' AND request_id LIKE $1', [`${prefix}%`])
  return Number(row?.count)
}

function tally(statuses: number[]): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const status of statuses)
    counts[status] = (counts[status] ?? 0) + 1
  return counts
}

describe('并发：先占用名额，再验证', () => {
  it('同一个用户名的一波并发错误密码：只验证上限那么多次，其余直接 429', async () => {
    const app = await start({ NERVE_LOGIN_MAX_FAILURES: '3', NERVE_LOGIN_IP_MAX_FAILURES: '1000' })
    const statuses = await Promise.all(Array.from({ length: 30 }, async (_unused, index) =>
      (await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' }, { 'x-request-id': `burst-user-${index}` })).status))
    // 第 3 次失败触发锁定，那一次也是 429
    expect(tally(statuses)).toEqual({ 401: 2, 429: 28 })
    expect(await failedAudits('burst-user-')).toBe(3)
    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(429)
  })

  it('锁定之后，并发里混着正确的密码也进不来，也不再验证', async () => {
    const app = await start({ NERVE_LOGIN_MAX_FAILURES: '3', NERVE_LOGIN_IP_MAX_FAILURES: '1000' })
    for (let attempt = 0; attempt < 3; attempt++)
      await postLogin(app.baseUrl, { username: 'alice', password: 'wrong' })
    const statuses = await Promise.all(Array.from({ length: 10 }, async (_unused, index) =>
      (await postLogin(app.baseUrl, { username: 'alice', password: index % 2 === 0 ? alice.password : 'wrong' }, { 'x-request-id': `locked-${index}` })).status))
    expect(statuses).toEqual(Array.from({ length: 10 }).fill(429))
    expect(await failedAudits('locked-')).toBe(0)
  })

  it('同一个地址换着用户名并发尝试：只验证地址的上限那么多次；被地址拒绝的请求退回用户名的名额', async () => {
    const app = await start({ NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '3' })
    const statuses = await Promise.all(Array.from({ length: 20 }, async (_unused, index) =>
      (await postLogin(app.baseUrl, { username: `user${index}`, password: 'wrong' }, { 'x-request-id': `burst-ip-${index}` })).status))
    expect(tally(statuses)).toEqual({ 401: 2, 429: 18 })
    expect(await failedAudits('burst-ip-')).toBe(3)
    // 只有验证过的 3 个用户名留下计数：其余的要么在预检时就被拒绝，要么占到的名额已经退回
    const counted = await rows('SELECT failures FROM auth_login_throttles WHERE failures > 0')
    expect(counted).toHaveLength(3 + 1)
  })

  it('一波并发的失败，连同清理过期计数与会话：没有死锁，没有 5xx；过期的记录被清掉', async () => {
    const app = await start({ NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '100000' })
    await database.query(async (client) => {
      await client.query(`
        INSERT INTO auth_login_throttles (key_hash, failures, window_started_at)
        SELECT sha256(convert_to('expired:' || n, 'UTF8')), 1, now() - interval '1 day' FROM generate_series(1, 300) AS n`)
      await client.query(`
        INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at, created_at, last_seen_at)
        SELECT $1, sha256(convert_to('old-session:' || n, 'UTF8')), now() - interval '40 days', now() - interval '40 days', now() - interval '47 days', now() - interval '40 days'
        FROM generate_series(1, 150) AS n`, [alice.id])
    })
    const statuses = await Promise.all(Array.from({ length: 60 }, async (_unused, index) =>
      (await postLogin(app.baseUrl, { username: `flood${index % 20}`, password: 'wrong' })).status))
    expect(statuses.filter(status => status >= 500)).toEqual([])
    expect(tally(statuses)).toEqual({ 401: 60 })
    // 每次验证过密码之后顺带清理一批（每次最多 100 条）：60 次足够清完
    const [left] = await rows<{ throttles: string, sessions: string }>(`
      SELECT (SELECT count(*) FROM auth_login_throttles WHERE window_started_at < now() - interval '1 hour') AS throttles,
             (SELECT count(*) FROM auth_sessions WHERE idle_expires_at < now() - interval '30 days') AS sessions`)
    expect(left).toEqual({ throttles: '0', sessions: '0' })
  })
})

describe('清理不等待别人正锁着的行', () => {
  it('过期的计数与会话被别的事务锁着：登录照常返回，清理跳过它们，不等锁超时', async () => {
    const app = await start({ NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '100000', NERVE_DATABASE_LOCK_TIMEOUT_MS: '1000' })
    await database.query(async (client) => {
      await client.query(`
        INSERT INTO auth_login_throttles (key_hash, failures, window_started_at)
        SELECT sha256(convert_to('stale:' || n, 'UTF8')), 1, now() - interval '1 day' FROM generate_series(1, 5) AS n`)
      await client.query(`
        INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at)
        SELECT $1, sha256(convert_to('stale-session:' || n, 'UTF8')), now() - interval '40 days', now() - interval '40 days' FROM generate_series(1, 5) AS n`, [alice.id])
    })
    const held = await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT 1 FROM auth_login_throttles WHERE key_hash = sha256(convert_to(\'stale:1\', \'UTF8\')) FOR UPDATE')
        await client.query('SELECT 1 FROM auth_sessions WHERE token_hash = sha256(convert_to(\'stale-session:1\', \'UTF8\')) FOR UPDATE')
        const started = performance.now()
        const failed = await postLogin(app.baseUrl, { username: 'nobody', password: 'wrong' })
        const succeeded = await postLogin(app.baseUrl, { username: 'alice', password: alice.password })
        return { statuses: [failed.status, succeeded.status], elapsed: performance.now() - started }
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
    expect(held.statuses).toEqual([401, 200])
    // 等锁的话至少要 1 秒（锁超时）；跳过时两次登录只花验证密码的时间
    expect(held.elapsed).toBeLessThan(900)
    const [left] = await rows<{ throttles: string, sessions: string }>(`
      SELECT (SELECT count(*) FROM auth_login_throttles WHERE window_started_at < now() - interval '1 hour') AS throttles,
             (SELECT count(*) FROM auth_sessions WHERE idle_expires_at < now() - interval '30 days') AS sessions`)
    expect(left).toEqual({ throttles: '1', sessions: '1' })
  })
})

describe('地址维度', () => {
  it('成功登录不清除地址的计数，只退回自己占的名额', async () => {
    const app = await start({ NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '3' })
    const statuses: number[] = []
    for (const [username, password] of [['u1', 'wrong'], ['alice', alice.password], ['u2', 'wrong'], ['u3', 'wrong']] as const)
      statuses.push((await postLogin(app.baseUrl, { username, password })).status)
    // 成功的那次不算失败（否则 u2 就会触发锁定）；之前的失败照算（否则 u3 不会触发锁定）
    expect(statuses).toEqual([401, 200, 401, 429])
  })

  describe('经反向代理（trust proxy）识别的客户端地址', () => {
    let proxied: TestApp

    beforeEach(async () => {
      proxied = await start({ NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '3', NERVE_TRUST_PROXY: 'loopback' })
    })

    async function failFrom(forwardedFor: string, username: string): Promise<number> {
      return (await postLogin(proxied.baseUrl, { username, password: 'wrong' }, { 'x-forwarded-for': forwardedFor })).status
    }

    it('IPv6 按 /64 计数：同一个 /64 里换地址绕不过去，别的 /64 不受影响', async () => {
      expect(await failFrom('2001:db8:1:2::1', 'v1')).toBe(401)
      expect(await failFrom('2001:db8:1:2::abcd', 'v2')).toBe(401)
      expect(await failFrom('2001:db8:1:2:ffff:ffff:ffff:ffff', 'v3')).toBe(429)
      expect(await failFrom('2001:db8:1:3::1', 'v4')).toBe(401)
    })

    it('IPv4 按单个地址；IPv4 映射的 IPv6 与它是同一个地址', async () => {
      expect(await failFrom('198.51.100.7', 'w1')).toBe(401)
      expect(await failFrom('::ffff:198.51.100.7', 'w2')).toBe(401)
      expect(await failFrom('198.51.100.7', 'w3')).toBe(429)
      expect(await failFrom('198.51.100.8', 'w4')).toBe(401)
    })

    it('转发来的地址不合法：归到同一个键一起限流，不跳过地址维度', async () => {
      expect(await failFrom('not-an-ip', 'x1')).toBe(401)
      expect(await failFrom('also bad', 'x2')).toBe(401)
      expect(await failFrom('999.1.1.1', 'x3')).toBe(429)
    })
  })
})

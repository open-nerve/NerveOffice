// 登录洪水（P5 设计 §3.5，DEF-015）：等待密码哈希的请求有上限，超出的立即返回 503 与 Retry-After，不无限排队；
// 没有验证的请求退回限流的名额、不写审计；洪水过后照常登录。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { postLogin } from '../support/session-client.ts'

/** 一次哈希足够慢（迭代 20 次，约百毫秒）：一波并发的请求一定撞上正在算的那一个 */
const SLOW_ARGON2 = { memoryCost: 19_456, timeCost: 20, parallelism: 1 }

let database: TestDatabase
let alice: TestAccount
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  // 与应用的参数相同，登录成功时不重新哈希
  alice = await createAccount(database, { username: 'alice', argon2: SLOW_ARGON2 })
  app = await startTestApp({
    databaseUrl: database.url,
    env: {
      // 一次只算一个、不排队：同时到的请求里只有一个能验证
      NERVE_PASSWORD_HASH_CONCURRENCY: '1',
      NERVE_PASSWORD_HASH_QUEUE_MAX: '0',
      NERVE_PASSWORD_HASH_QUEUE_TIMEOUT_MS: '2100',
      NERVE_PASSWORD_ARGON2_ITERATIONS: String(SLOW_ARGON2.timeCost),
      NERVE_LOGIN_MAX_FAILURES: '100',
      NERVE_LOGIN_IP_MAX_FAILURES: '1000',
    },
  })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function rows<T extends Record<string, unknown>>(query: string, values: unknown[] = []): Promise<T[]> {
  return database.query(async client => (await client.query<T>(query, values)).rows)
}

describe('等待密码哈希的请求有上限', () => {
  it('超出的立即 503 与 Retry-After：不验证、不写审计，限流的名额退回；洪水过后照常登录', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, async (_unused, index) =>
      postLogin(app.baseUrl, { username: `flood${index}`, password: 'wrong' }, { 'x-request-id': `flood-${index}` })))
    const statuses = responses.map(response => response.status)
    const verified = statuses.filter(status => status === 401).length
    const busy = responses.filter(response => response.status === 503)
    expect(verified + busy.length, statuses.join(',')).toBe(8)
    expect(verified).toBeGreaterThan(0)
    expect(busy.length).toBeGreaterThan(0)
    for (const response of busy) {
      // 建议的重试时间是等待时限（2.1 秒）向上取整
      expect(response.headers.get('retry-after')).toBe('3')
      expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
    }

    // 只有验证过的请求写审计、留下计数：地址维度的计数就是验证过的次数
    const [audits] = await rows<{ count: string }>('SELECT count(*) AS count FROM audit_events WHERE action = \'auth.login_failed\' AND request_id LIKE \'flood-%\'')
    expect(Number(audits?.count)).toBe(verified)
    const addressKey = createHash('sha256').update('ip:127.0.0.1', 'utf8').digest()
    const [address] = await rows<{ failures: number }>('SELECT failures FROM auth_login_throttles WHERE key_hash = $1', [addressKey])
    expect(address?.failures).toBe(verified)
    const [counted] = await rows<{ count: string }>('SELECT count(*) AS count FROM auth_login_throttles WHERE failures > 0')
    // 验证过的用户名各一行，加上地址那一行
    expect(Number(counted?.count)).toBe(verified + 1)

    expect(app.logs.entries().filter(entry => entry.msg === '等待密码哈希的请求太多，拒绝这次登录')).toHaveLength(busy.length)
    expect((await postLogin(app.baseUrl, { username: 'alice', password: alice.password })).status).toBe(200)
  })
})

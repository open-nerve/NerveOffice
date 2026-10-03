// 库里现存哈希的参数组读不出来时，不进入密码验证（M2 Codex 评审 CX2，ADR-007）：失败的验证与"用户名不存在"做同样的计算，
// 前提是哈希器知道库里现存的全部参数组（第一次验证之前读出）。原来读失败被吞掉、照常验证：旧参数的账户比对自己那组，
// 不存在的用户名只算已知的几组，两条路径算的组不同，失败的耗时暴露账户是否存在。现在读不出来时这次验证抛出、一次哈希也没算，
// 数据库繁忙按现有做法回 503、退回限流的名额；下一次验证再读。
// 构造是确定的（与 Codex 的探针同一个做法）：测试的连接锁住整张 users 表（ACCESS EXCLUSIVE），刚启动的应用读参数组停在锁上，
// 测试取消这条语句（pg_cancel_backend，SQLSTATE 57014：数据库繁忙）——启动照常、只记警告；登录时再读一次、又停在锁上，再取消。
// 然后才放锁：原来吞掉失败的写法这时接着读凭据（等这把锁），放锁之后带着不全的参数组验证、回 401；现在这次验证在取消时就抛出了。
// 算了哪几组：把 @node-rs/argon2 换成记下参数、再调用原实现的包装（与 password-hasher.test.ts 同一个做法），核对计算本身，不比耗时。
// 集成测试的准备文件（setup/database.ts）经 @nerve-office/api 已经加载过整个应用，那一份拿的是原实现：应用要在换上包装之后
// 重新加载（vi.resetModules，再动态引用 support/api-app.ts），才用得上包装
import type { Buffer } from 'node:buffer'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { createTestDatabase } from '../support/database.ts'
import { postLogin } from '../support/session-client.ts'

/** 应用（与测试在同一个进程里）每次调用 Argon2 算的参数组：陪算记参数，比对记 PHC 字符串里的参数段 */
const computed = vi.hoisted(() => [] as string[])

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>()
  return {
    ...actual,
    hash: async (...args: Parameters<typeof actual.hash>) => {
      const [, options] = args
      computed.push(`m=${options?.memoryCost},t=${options?.timeCost},p=${options?.parallelism}`)
      return actual.hash(...args)
    },
    verify: async (...args: Parameters<typeof actual.verify>) => {
      computed.push(String(args[0]).split('$')[3] ?? '')
      return actual.verify(...args)
    },
  }
})

/** 应用的当前参数（默认值）与库里旧参数账户的参数：两组不同，算的组一比就看得出来 */
const CURRENT = 'm=19456,t=2,p=1'
const OLD = { memoryCost: 12_288, timeCost: 3, parallelism: 1 }
const OLD_GROUP = 'm=12288,t=3,p=1'
const WRONG = 'not the password at all'
/** 应用的连接池的 application_name（apps/api 的 database 模块）：只取消应用的语句 */
const APPLICATION_NAME = 'nerve-office-api'

/** 限流计数的键的摘要（与 auth 的 throttle-keys 一致；测试都从本机发出） */
function digest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

let database: TestDatabase
let app: TestApp | undefined

beforeAll(async () => {
  database = await createTestDatabase()
  await createAccount(database, { username: 'veteran', argon2: OLD })
})

afterAll(async () => {
  await app?.close()
  await database.drop()
})

function started(): TestApp {
  if (app === undefined)
    throw new Error('应用还没有启动')
  return app
}

/**
 * 应用读参数组的那条语句（users.repository.ts 的 passwordHashParameters）停在测试持着的表锁上时，取消它：
 * 数据库报 57014（语句被取消），应用按数据库繁忙处理。只认这条语句，且只能有一条在等
 */
async function cancelParameterRead(): Promise<void> {
  await vi.waitFor(async () => {
    const waiting = await database.query(async client => (await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock' AND query LIKE 'select distinct split_part(%'`,
      [APPLICATION_NAME],
    )).rows)
    expect(waiting).toHaveLength(1)
    const pid = waiting[0]?.pid
    expect(await database.query(async client => (await client.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0]?.cancelled)).toBe(true)
  }, { timeout: 10_000, interval: 20 })
}

/** 这个用户名在三个维度（账户、账户与地址、地址）上记着的失败次数（没有这一行时为 0） */
async function failuresOf(username: string): Promise<number[]> {
  const rows = await database.query(async client => (await client.query<{ key_hash: Buffer, failures: number }>('SELECT key_hash, failures FROM auth_login_throttles')).rows)
  const of = (key: Buffer): number => rows.find(row => row.key_hash.equals(key))?.failures ?? 0
  return [of(digest(`account:${username}`)), of(digest(`account-address:${username}|ip:127.0.0.1`)), of(digest('ip:127.0.0.1'))]
}

/** 一次错误密码的登录算了哪几组（排好序：只看组，不看先后与陪算还是比对） */
async function groupsOf(username: string): Promise<string[]> {
  computed.length = 0
  const response = await postLogin(started().baseUrl, { username, password: WRONG })
  expect(response.status, await response.clone().text()).toBe(401)
  return [...computed].sort()
}

describe('参数组读不出来时不进入密码验证（M2 Codex 评审 CX2，ADR-007）', () => {
  it('冷启动时读不出来：不存在与旧参数账户的登录都 503、一组也没算、名额退回；之后再登录，两条路径算的组相同', async () => {
    const pending: Promise<Response>[] = []
    await database.query(async (holder) => {
      await holder.query('BEGIN')
      try {
        await holder.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE')
        vi.resetModules()
        const { startTestApp } = await import('../support/api-app.ts')
        app = await startTestApp({ databaseUrl: database.url })
        // 启动时的那次读停在锁上，取消它：只记警告，应用照常起来
        await cancelParameterRead()
        await vi.waitFor(() => expect(started().logs.text()).toContain('没能读出现存密码哈希的参数'), { timeout: 5_000 })
        computed.length = 0
        for (const username of ['nobody', 'veteran']) {
          pending.push(postLogin(started().baseUrl, { username, password: WRONG }))
          // 验证时再读一次，又停在锁上：取消它
          await cancelParameterRead()
        }
      }
      finally {
        await holder.query('ROLLBACK')
      }
    })
    // 放锁之后才取结果：吞掉失败的写法这时才读到凭据、带着不全的参数组验证（401）；现在两次登录在取消时就已经是 503
    for (const [index, username] of ['nobody', 'veteran'].entries()) {
      const response = await pending[index]
      expect(response?.status, `${username}：${await response?.clone().text()}`).toBe(503)
      expect(response?.headers.get('retry-after')).toBe('5')
      // 还没有比对：三个维度的名额都退回
      expect(await failuresOf(username), username).toEqual([0, 0, 0])
    }
    expect(computed).toEqual([])

    // 读得到了：先不存在、再旧参数的账户、再不存在，三次算的组完全相同（当前参数与库里的旧参数各一次）
    const missing = await groupsOf('nobody')
    expect(missing).toEqual([CURRENT, OLD_GROUP].sort())
    expect(await groupsOf('veteran')).toEqual(missing)
    expect(await groupsOf('nobody')).toEqual(missing)
  })
})

// US-M3-17 本机密钥的并发与确定的交错（M3-P6 设计 §3.5，探索 A §1.6 在 PostgreSQL 18.6 上实测的几种先后）：
// - 第一次取用：并发的几次拿到同一把、只有一行（主键 + ON CONFLICT DO NOTHING，输的一方再读一次）；别的事务插了第 1 版还没提交时取用等它的结局；
// - 取用不锁账户行（停用、签发重置、吊销锁着账户行时不等它们），也不等还没提交的吊销（读到吊销之前的那一把，按"请求先于吊销"线性化）；
// - 两个并发的吊销：先锁账户行把它们串起来——只靠本机密钥行的锁时，后一个在 READ COMMITTED 的重新检查下拿到 0 行、被当成"没有可吊销的"；
//   两种先后（先开始的先做完、后开始的先做完）都得到第 2、第 3 版；
// - 吊销遇上还没提交的第一次取用：不等它、按"没有可吊销的"回答（那一刻还没有任何密钥发出过）；
// - 吊销开了事务、在锁上等着的时候，别的事务生成并提交了当前的那一把（本人第一次取用、另一个吊销生成的下一版）：吊销的时刻取执行那一刻，
//   不早于那一把的生成，下一版生成于这一刻（审查 A1：原来取事务开始的 now()，约束 revoked_at >= created_at 失败、吊销 500）；
// - 守卫之后、事务之前撤销这次登录（退出、签发重置、停用、别处修改密码、空闲过期）：事务的第一条语句按主键核对登录，401 SESSION_EXPIRED、
//   不动 Cookie、什么也不写（read-snapshot.test.ts 的闸门写法：在 TransactionRunner.run 停住）。
// 持锁的构造见 support/held-lock.ts（前提：应用等锁的时限是默认的 5 秒）
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { TransactionRunner } from '@nerve-office/api'
import { adminUserSchema, errorResponseSchema, localKeySchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_LOCAL_KEYS_MASTER_KEY } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { raceAgainstHeldLock, whileHolding } from '../support/held-lock.ts'
import { currentMaterialOf, fetchLocalKey, localKeyMomentsOf, localKeyRowsOf, revokeLocalKey, takeLocalKey, unwrapLocalKey, wrapLocalKey } from '../support/local-keys.ts'
import { asUser, login, SESSION_COOKIE, sessionSetCookie } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let rootSession: LoggedIn
let people = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'races-root', systemRole: 'admin' })
  rootSession = await login(app.baseUrl, root.username, root.password)
})

afterAll(async () => {
  vi.restoreAllMocks()
  try {
    const logs = app.logs.text()
    expect(logs.includes(TEST_LOCAL_KEYS_MASTER_KEY)).toBe(false)
    expect(logs.includes(Buffer.from(TEST_LOCAL_KEYS_MASTER_KEY, 'base64').toString('hex'))).toBe(false)
  }
  finally {
    await app.close()
    await database.drop()
  }
})

async function person(systemRole: 'admin' | 'member' = 'member'): Promise<{ account: TestAccount, session: LoggedIn }> {
  people += 1
  const account = await createAccount(database, { username: `races-${people}`, systemRole })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

async function keyOf(response: Response): Promise<{ version: number, key: string }> {
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(localKeySchema, await response.json())
}

async function errorOf(response: Response): Promise<[number, string | undefined]> {
  const text = await response.text()
  const parsed = errorResponseSchema.safeParse(text === '' ? undefined : JSON.parse(text))
  return [response.status, parsed.success ? parsed.data.error.code : undefined]
}

/**
 * 这个人的吊销审计。occurredAt 是写审计的事务开始的时刻（审计表的默认值 now()），带微秒的 UTC 文本：交错的用例据它核对前提——
 * 吊销的事务确实早于别的事务开始（审查 A1 的交错要的就是这个先后）
 */
async function revocationAuditsOf(userId: string): Promise<{ actor_id: string, details: unknown, occurredAt: string }[]> {
  return database.query(async client => (await client.query<{ actor_id: string, details: unknown, occurredAt: string }>(
    `SELECT actor_id, details, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
     FROM audit_events WHERE action = 'users.local_key_revoked' AND target_id = $1 ORDER BY occurred_at, id`,
    [userId],
  )).rows)
}

const INSERT_KEY = 'INSERT INTO user_local_keys (user_id, version, master_key_id, wrapped_key) VALUES ($1, $2, $3, $4)'

/** 闸门：走到这里时 arrived 兑现，等 release 之后才往下走 */
function gate() {
  let reach: () => void = () => {}
  let release: () => void = () => {}
  const arrived = new Promise<void>((resolve) => {
    reach = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { arrived, reach: () => reach(), wait, release: () => release() }
}

/**
 * 把发出的请求停在它的事务里，这期间执行 during，放开之后照常往下走；返回这个请求的响应。控制点（spy）：TransactionRunner.run 的
 * 下一次调用——这个请求的事务（守卫不用它，测试应用关了定时任务），BEGIN 已经返回、work 还没开始：事务的 now() 已经定下，还没取任何锁。
 * 没走到停点就结束了时立即失败
 */
async function pausedInTransaction(send: () => Promise<Response>, during: () => Promise<void>): Promise<Response> {
  const runner = app.runtime.get(TransactionRunner)
  const original = runner.run.bind(runner)
  const barrier = gate()
  const spy = vi.spyOn(runner, 'run').mockImplementationOnce(async (work, options) => original(async (transaction) => {
    barrier.reach()
    await barrier.wait
    return work(transaction)
  }, options))
  const pending = send()
  const ended = pending.then(response => `HTTP ${response.status}`, (error: unknown) => `失败：${String(error)}`)
  try {
    const reached = await Promise.race([barrier.arrived.then(() => true), ended.then(() => false)])
    if (!reached)
      throw new Error(`请求没有走到事务里的停点就结束了（${await ended}）`)
    // 停点之后不再拦：during 里的请求照常开事务
    spy.mockRestore()
    await during()
  }
  finally {
    barrier.release()
    spy.mockRestore()
  }
  return pending
}

/** 吊销成功，响应里账户的本机密钥是第几版 */
async function revokedTo(response: Response): Promise<number | undefined> {
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(adminUserSchema, await response.json()).localKey?.version
}

/**
 * 时间线（审查 A1）：每一版吊销的时刻不早于它的生成，下一版生成于上一版被吊销的那一刻；只有最后一版是当前的。
 * 按库里带微秒的文本比较（写法固定，字符串的先后就是时间的先后）
 */
async function expectMonotonicTimeline(userId: string, versions: number): Promise<void> {
  const moments = await localKeyMomentsOf(database, userId)
  expect(moments.map(moment => [moment.version, moment.revokedAt === null])).toEqual(Array.from({ length: versions }, (_, index) => [index + 1, index === versions - 1]))
  for (const [index, moment] of moments.entries()) {
    const next = moments[index + 1]
    if (next === undefined)
      continue
    expect((moment.revokedAt ?? '') >= moment.createdAt, `第 ${moment.version} 版吊销的时刻早于它的生成`).toBe(true)
    expect(next.createdAt, `第 ${next.version} 版不是生成于第 ${moment.version} 版被吊销的那一刻`).toBe(moment.revokedAt)
  }
}

describe('第一次取用的并发', () => {
  it('同一个人 8 次并发的第一次取用（同一次登录与另一台设备上的登录交替）：拿到的完全相同，都是第 1 版，库里只有一行', async () => {
    const { account, session } = await person()
    const other = await login(app.baseUrl, account.username, account.password)
    const responses = await Promise.all(Array.from({ length: 8 }, async (_, index) => fetchLocalKey(app.baseUrl, index % 2 === 0 ? session : other)))
    const keys = await Promise.all(responses.map(keyOf))
    expect(new Set(keys.map(key => JSON.stringify(key))).size).toBe(1)
    expect(keys[0]?.version).toBe(1)
    const rows = await localKeyRowsOf(database, account.id)
    expect(rows).toHaveLength(1)
    expect(unwrapLocalKey(await currentMaterialOf(database, account.id), { userId: account.id, version: 1 }).toString('base64')).toBe(keys[0]?.key)
  })

  it('别的事务插了第 1 版还没提交：取用的插入等它的结局；它提交了，取用不另插、再读一次，交出它的那一把', async () => {
    const { account, session } = await person()
    const theirs = randomBytes(32)
    const material = wrapLocalKey(theirs, { userId: account.id, version: 1 })
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query(INSERT_KEY, [account.id, 1, material.masterKeyId, material.wrappedKey]),
      request: async () => fetchLocalKey(app.baseUrl, session),
      change: async () => {},
    })
    expect(await keyOf(response)).toEqual({ version: 1, key: theirs.toString('base64') })
    expect(await localKeyRowsOf(database, account.id)).toHaveLength(1)
  })

  it('别的事务插了第 1 版、最终却没有留下它（插了又删再提交，与回滚同样的结果）：取用随后插进自己生成的第 1 版，交出它', async () => {
    const { account, session } = await person()
    const theirs = randomBytes(32)
    const material = wrapLocalKey(theirs, { userId: account.id, version: 1 })
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query(INSERT_KEY, [account.id, 1, material.masterKeyId, material.wrappedKey]),
      request: async () => fetchLocalKey(app.baseUrl, session),
      change: async client => client.query('DELETE FROM user_local_keys WHERE user_id = $1', [account.id]),
    })
    const key = await keyOf(response)
    expect(key.version).toBe(1)
    expect(key.key).not.toBe(theirs.toString('base64'))
    expect(unwrapLocalKey(await currentMaterialOf(database, account.id), { userId: account.id, version: 1 }).toString('base64')).toBe(key.key)
  })
})

describe('取用不等管理操作', () => {
  /**
   * 取用结束的那一刻，测试持着的锁确实还在（另一个连接 NOWAIT 地要同一把锁，立即得到 55P03）：取用是在锁还在的时候走完的，不是等到放开之后。
   * 没有这一步时，持锁的写法写错了（什么也没锁住）用例照样通过
   */
  async function expectStillLocked(query: string, values: unknown[]): Promise<void> {
    const failure = await database.query(async client => client.query(query, values).then(() => undefined, (error: unknown) => error))
    expect(failure, '测试持着的锁已经不在了：用例的前提不成立').toMatchObject({ code: '55P03' })
  }

  it('账户行被管理操作锁着（FOR NO KEY UPDATE：停用、签发重置、吊销都这样锁）：第一次取用与再取都不等它（插入的外键检查只取 FOR KEY SHARE）', async () => {
    const { account, session } = await person()
    const lockAccount = async (client: { query: (text: string, values: unknown[]) => Promise<unknown> }) => client.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [account.id])
    const fetchWhileLocked = async (): Promise<Response> => whileHolding(database, lockAccount, async () => {
      const response = await fetchLocalKey(app.baseUrl, session)
      await expectStillLocked('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [account.id])
      return response
    })
    const first = await keyOf(await fetchWhileLocked())
    expect(first.version).toBe(1)
    expect(await keyOf(await fetchWhileLocked())).toEqual(first)
  })

  it('吊销的事务还没提交（已经标记吊销、擦掉材料、插了下一版）：取用不等它，交出吊销之前的那一把（按"请求先于吊销"线性化）', async () => {
    const { account, session } = await person()
    const before = await takeLocalKey(app.baseUrl, session)
    const next = wrapLocalKey(randomBytes(32), { userId: account.id, version: 2 })
    const during = await whileHolding(database, async (client) => {
      await client.query('UPDATE user_local_keys SET revoked_at = now(), master_key_id = NULL, wrapped_key = NULL WHERE user_id = $1 AND revoked_at IS NULL', [account.id])
      await client.query(INSERT_KEY, [account.id, 2, next.masterKeyId, next.wrappedKey])
    }, async () => {
      const response = await fetchLocalKey(app.baseUrl, session)
      // 吊销的事务还开着：它改过的第 1 版那一行仍被它锁着
      await expectStillLocked('SELECT 1 FROM user_local_keys WHERE user_id = $1 AND version = 1 FOR UPDATE NOWAIT', [account.id])
      return response
    })
    expect(await keyOf(during)).toEqual(before)
  })
})

describe('吊销的并发', () => {
  it('两个并发的吊销（两位系统管理员几乎同时点）：先锁账户行把它们串起来——一个吊销第 1 版、生成第 2 版，另一个吊销第 2 版、生成第 3 版，两条审计', async () => {
    const { account, session } = await person()
    await takeLocalKey(app.baseUrl, session)
    const { account: other, session: otherSession } = await person('admin')
    const [first, second] = await raceAgainstHeldLock(database, {
      // 测试持着当前那一把本机密钥的行锁：先锁住账户行的那个吊销停在本机密钥行上，另一个停在账户行上（不先锁账户行的话，两个都停在本机密钥行上，
      // 放开之后后一个重新检查时那一行已经吊销，拿到 0 行）
      hold: async client => client.query('SELECT 1 FROM user_local_keys WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE', [account.id]),
      request: async ({ step, waitForWaiting }) => {
        const a = step(revokeLocalKey(app.baseUrl, rootSession, account.id))
        await waitForWaiting(1)
        const b = step(revokeLocalKey(app.baseUrl, otherSession, account.id))
        return Promise.all([a, b])
      },
      change: async () => {},
      waiting: 2,
    })
    const versions = await Promise.all([first, second].map(async (response) => {
      expect(response.status).toBe(200)
      return parseExact(adminUserSchema, await response.json()).localKey?.version
    }))
    expect(versions.toSorted()).toEqual([2, 3])
    expect((await localKeyRowsOf(database, account.id)).map(row => [row.version, row.revokedAt === null])).toEqual([[1, false], [2, false], [3, true]])
    await expectMonotonicTimeline(account.id, 3)
    const audits = await revocationAuditsOf(account.id)
    expect(audits.map(audit => audit.details)).toEqual([{ version: 1 }, { version: 2 }])
    expect(audits.map(audit => audit.actor_id).toSorted()).toEqual([root.id, other.id].toSorted())
  })

  it('两个并发的吊销、后开始的先做完（先开始的那个开了事务之后慢了一步，另一位管理员的吊销随后开始、先做完）：都 200，得到第 2、第 3 版（审查 A1：原来吊销记事务开始的 now()，先开始的那个吊销第 2 版时早于第 2 版的生成，约束失败、500）', async () => {
    const { account, session } = await person()
    await takeLocalKey(app.baseUrl, session)
    const { account: other, session: otherSession } = await person('admin')
    let laterVersion: number | undefined
    const earlier = await pausedInTransaction(async () => revokeLocalKey(app.baseUrl, rootSession, account.id), async () => {
      laterVersion = await revokedTo(await revokeLocalKey(app.baseUrl, otherSession, account.id))
    })
    expect(laterVersion).toBe(2)
    expect(await revokedTo(earlier)).toBe(3)
    await expectMonotonicTimeline(account.id, 3)
    // 先做完的是后开始的那位管理员：他吊销第 1 版，先开始的吊销第 2 版
    const audits = await revocationAuditsOf(account.id)
    const byVersion = new Map(audits.map(audit => [JSON.stringify(audit.details), audit]))
    const [ofFirst, ofSecond] = [byVersion.get(JSON.stringify({ version: 1 })), byVersion.get(JSON.stringify({ version: 2 }))]
    expect([audits.length, ofFirst?.actor_id, ofSecond?.actor_id]).toEqual([2, other.id, root.id])
    // 前提：吊销第 2 版的那个事务确实先开始（审计的时刻是事务开始的时刻）——停点在 BEGIN 之前的话两个就是一前一后，测不到这种交错
    expect((ofSecond?.occurredAt ?? '') < (ofFirst?.occurredAt ?? ''), '先发的吊销没有先开始事务：用例的前提不成立').toBe(true)
    expect((await takeLocalKey(app.baseUrl, session)).version).toBe(3)
  })

  it('吊销在账户行上等着（别的管理操作锁着它）的时候，本人第一次取用、提交了第 1 版：吊销 200，吊销的是第 1 版、生成第 2 版；第 2 版生成于第 1 版被吊销的那一刻，不早于第 1 版的生成（审查 A1：原来吊销记事务开始的 now()，早于这次取用的生成，约束失败、500）', async () => {
    const { account, session } = await person()
    let taken: number | undefined
    const response = await raceAgainstHeldLock(database, {
      // 别的管理操作（停用、签发重置、另一位管理员的吊销）锁着这个账户的行：吊销已经开了事务，停在这把锁上
      hold: async client => client.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [account.id]),
      request: async () => revokeLocalKey(app.baseUrl, rootSession, account.id),
      // 吊销等着的时候本人第一次取用（不锁账户行，外键检查只取 FOR KEY SHARE）：第 1 版生成、提交，生成的时刻晚于吊销的事务开始的时刻
      change: async () => {
        taken = (await takeLocalKey(app.baseUrl, session)).version
      },
    })
    expect(taken).toBe(1)
    expect(await revokedTo(response)).toBe(2)
    await expectMonotonicTimeline(account.id, 2)
    const audits = await revocationAuditsOf(account.id)
    expect(audits.map(audit => audit.details)).toEqual([{ version: 1 }])
    // 前提：吊销的事务早于第 1 版的生成开始（审计的时刻是吊销的事务开始的时刻）
    const [first] = await localKeyMomentsOf(database, account.id)
    expect((audits[0]?.occurredAt ?? '') < (first?.createdAt ?? ''), '吊销的事务没有早于第 1 版的生成开始：用例的前提不成立').toBe(true)
    expect((await takeLocalKey(app.baseUrl, session)).version).toBe(2)
  })

  it('吊销遇上还没提交的第一次取用（这个人还没有任何一行）：吊销不等它，按"没有可吊销的"原样返回、不记审计；那次取用随后提交第 1 版', async () => {
    const { account } = await person()
    const pending = wrapLocalKey(randomBytes(32), { userId: account.id, version: 1 })
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query(INSERT_KEY, [account.id, 1, pending.masterKeyId, pending.wrappedKey])
        const response = await revokeLocalKey(app.baseUrl, rootSession, account.id)
        expect(response.status).toBe(200)
        expect(parseExact(adminUserSchema, await response.json()).localKey).toBeNull()
        await client.query('COMMIT')
      }
      catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
    expect(await revocationAuditsOf(account.id)).toEqual([])
    expect((await localKeyRowsOf(database, account.id)).map(row => [row.version, row.revokedAt === null])).toEqual([[1, true]])
  })
})

describe('守卫之后、事务之前撤销这次登录（M3-P6 设计 §3.5）：事务的第一条语句核对登录，401 SESSION_EXPIRED、不动 Cookie、什么也不写', () => {
  /**
   * 取用停在开事务之前（TransactionRunner.run 的第一次调用：守卫已经放行，事务还没开），这期间执行 change（撤销这次登录），
   * 放开之后照常开事务；返回这次取用的响应。没走到停点就结束了时立即失败
   */
  async function pausedBeforeTransaction(session: LoggedIn, change: () => Promise<void>): Promise<Response> {
    const runner = app.runtime.get(TransactionRunner)
    const original = runner.run.bind(runner)
    const barrier = gate()
    const spy = vi.spyOn(runner, 'run').mockImplementationOnce(async (...args: Parameters<TransactionRunner['run']>) => {
      barrier.reach()
      await barrier.wait
      return original(...args)
    })
    const pending = fetchLocalKey(app.baseUrl, session)
    const ended = pending.then(response => `HTTP ${response.status}`, (error: unknown) => `失败：${String(error)}`)
    try {
      const reached = await Promise.race([barrier.arrived.then(() => true), ended.then(() => false)])
      if (!reached)
        throw new Error(`取用没有走到开事务就结束了（${await ended}）`)
      await change()
    }
    finally {
      barrier.release()
      spy.mockRestore()
    }
    return pending
  }

  function digestOf(session: LoggedIn): Buffer {
    return createHash('sha256').update(session.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
  }

  it.each([
    ['本人退出（同一个 Cookie）', async (_account: TestAccount, session: LoggedIn) => {
      expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    }],
    ['管理员签发重置链接（撤销这个人的全部登录，账户仍然有效）', async (account: TestAccount) => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/password-reset`, { method: 'POST' })).status).toBe(201)
    }],
    ['停用（同一个事务撤销全部登录）', async (account: TestAccount) => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/disable`, { method: 'POST' })).status).toBe(200)
    }],
    ['别的设备上修改密码', async (account: TestAccount) => {
      const elsewhere = await login(app.baseUrl, account.username, account.password)
      expect((await asUser(app.baseUrl, elsewhere, '/api/auth/password', { method: 'PUT', body: { currentPassword: account.password, newPassword: 'a brand new password 2026' } })).status).toBe(200)
    }],
    ['这次登录空闲过期（没有撤销）', async (_account: TestAccount, session: LoggedIn) => {
      expect(await database.query(async client => (await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [digestOf(session)])).rowCount)).toBe(1)
    }],
  ])('%s', async (_case, revoke) => {
    const { account, session } = await person()
    const response = await pausedBeforeTransaction(session, async () => {
      await revoke(account, session)
      // 撤销已经生效：新的取用被守卫挡住
      expect((await fetchLocalKey(app.baseUrl, session)).status).toBe(401)
    })
    expect(sessionSetCookie(response), '不动 Cookie').toBeUndefined()
    expect(await errorOf(response)).toEqual([401, 'SESSION_EXPIRED'])
    expect(await localKeyRowsOf(database, account.id)).toEqual([])
  })
})

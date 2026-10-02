// held-lock 的自测（M2-P1 复验 X3）：分几步发出请求时，登记过的任何一步没走到锁上就先结束了，等待立即失败并报出它的结果，
// 不空等到超时，也不丢掉那一步的状态码。持锁期间另发的请求"不等锁就走完"的判断（M2-P6 复验 N1）两个方向各一例。
// raceAgainstHeldLock 的前提（应用等锁的时限远长于测试的那段操作）由断言守着：前提不成立时直接失败（M2-P6 第 6 片复核 S4）。
import type { TestDatabase } from './database.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '@nerve-office/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testEnvironment } from './api-app.ts'
import { createTestDatabase } from './database.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from './held-lock.ts'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.drop()
})

const HOLD_ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:held-lock-self-test\', 0))'

/** 一个不碰数据库、立即结束的"请求" */
async function answeredAt(status: number): Promise<Response> {
  return new Response(null, { status })
}

describe('held-lock', () => {
  it('第一步没走到锁上就结束了：立即失败，报出它的状态码', async () => {
    const started = performance.now()
    const race = raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async ({ step, waitForWaiting }) => {
        const quick = step(answeredAt(403))
        await waitForWaiting(1)
        return quick
      },
      change: async () => undefined,
    })
    await expect(race).rejects.toThrow('HTTP 403')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('最后一步没走到锁上就结束了（整个请求还在等前一步）：同样立即失败，报出它的状态码', async () => {
    const started = performance.now()
    const race = raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      // 第一步真的在锁上等着（放开之后才结束）；要等的连接数比会有的多，只能靠"登记过的一步先结束"失败
      request: async ({ step }) => Promise.all([step(database.query(async client => client.query(HOLD_ADVISORY_LOCK))), step(answeredAt(409))]),
      waiting: 2,
      change: async () => undefined,
    })
    await expect(race).rejects.toThrow('HTTP 409')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('持锁期间另发的请求不碰那把锁：走完了，判断为 true', async () => {
    let completed: boolean | undefined
    await raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async () => database.query(async client => client.query(HOLD_ADVISORY_LOCK)),
      change: async () => {
        completed = await completesWithoutWaiting(database, answeredAt(200), 2)
      },
    })
    expect(completed).toBe(true)
  })

  it('持锁期间另发的请求也在锁上等着：判断为 false，放开之后它照常结束', async () => {
    let completed: boolean | undefined
    let second: Promise<unknown> | undefined
    await raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async () => database.query(async client => client.query(HOLD_ADVISORY_LOCK)),
      change: async () => {
        second = database.query(async client => client.query(HOLD_ADVISORY_LOCK))
        completed = await completesWithoutWaiting(database, second, 2)
      },
    })
    expect(completed).toBe(false)
    await expect(second).resolves.toBeDefined()
  })
})

describe('held-lock 的前提：应用等锁的时限远长于"等到请求 → 改数据 → 提交"这一段（M2-P6 第 6 片复核 S4）', () => {
  it('测试应用默认的等锁时限不短于 5 秒（raceAgainstHeldLock 的用例大都发给默认的应用）', () => {
    expect(loadConfig(testEnvironment(database.url)).database.lockTimeoutMs).toBeGreaterThanOrEqual(5_000)
  })

  it('被测的请求在测试提交之前就等锁超时了（等锁时限比改数据这一段短）：直接失败并写明前提不成立，不拿它超时之后的结果去比', async () => {
    const race = raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      // 被测的"请求"等锁 200 毫秒就放弃（相当于把应用的等锁时限调到几百毫秒）
      request: async () => database.query(async (client) => {
        await client.query('SET lock_timeout = \'200ms\'')
        return client.query(HOLD_ADVISORY_LOCK)
      }),
      // 改数据这一段比它等锁的时限长
      change: async () => delay(600),
    })
    await expect(race).rejects.toThrow('raceAgainstHeldLock 的前提不成立')
    await expect(race).rejects.toThrow('请求已经结束：失败')
  })

  it('被测的请求已经等锁超时结束，change 里另发的请求正在等同一把锁：等锁的连接数够了也不放过，照样报前提不成立（复核第二批 S-3）', async () => {
    let other: Promise<unknown> | undefined
    const race = raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async () => database.query(async (client) => {
        await client.query('SET lock_timeout = \'200ms\'')
        return client.query(HOLD_ADVISORY_LOCK)
      }),
      // 另一个连接在同一把锁上等着（只数等锁的连接时，会把它当成被测的请求），改数据这一段比被测的请求等锁的时限长
      change: async () => {
        other = database.query(async client => client.query(HOLD_ADVISORY_LOCK))
        await delay(600)
      },
    })
    await expect(race).rejects.toThrow('raceAgainstHeldLock 的前提不成立')
    await expect(race).rejects.toThrow('请求已经结束：失败')
    // 持锁的事务回滚之后，另发的那个请求拿到锁、照常结束
    await expect(other).resolves.toBeDefined()
  })
})

// held-lock 的自测（M2-P1 复验 X3）：分几步发出请求时，登记过的任何一步没走到锁上就先结束了，等待立即失败并报出它的结果，
// 不空等到超时，也不丢掉那一步的状态码。持锁期间另发的请求"不等锁就走完"的判断（M2-P6 复验 N1）两个方向各一例。
import type { TestDatabase } from './database.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

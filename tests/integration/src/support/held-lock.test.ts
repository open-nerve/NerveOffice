// held-lock 的自测（M2-P1 复验 X3）：分几步发出请求时，登记过的任何一步没走到锁上就先结束了，等待立即失败并报出它的结果，
// 不空等到超时，也不丢掉那一步的状态码。持锁期间另发的请求"不等锁就走完"的判断（M2-P6 复验 N1）两个方向各一例。
// raceAgainstHeldLock 的前提（应用等锁的时限远长于测试的那段操作）由断言守着：前提不成立时直接失败（M2-P6 第 6 片复核 S4）。
import type pg from 'pg'
import type { TestDatabase } from './database.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '@nerve-office/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testEnvironment } from './api-app.ts'
import { createTestDatabase } from './database.ts'
import { completesWithoutWaiting, interruptWhileHeldLock, raceAgainstHeldLock } from './held-lock.ts'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.drop()
})

const HOLD_ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:held-lock-self-test\', 0))'
const HOLD_OTHER_LOCK = 'SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:held-lock-other\', 0))'

type LockResult = 'acquired' | 'cancelled'

function deferred() {
  let complete: () => void
  const promise = new Promise<void>((resolve) => {
    complete = resolve
  })
  return { promise, resolve: () => complete() }
}

/** 拒绝必须保留实际前置错误；明确 unknown，避免 matcher 对象把 any 带入断言。 */
async function rejectionCause(promise: Promise<unknown>): Promise<Error> {
  const result = await promise.then(() => ({ completed: true }), (error: unknown) => ({ error }))
  if (!('error' in result))
    throw new Error('预期前置条件拒绝，实际请求完成了')
  if (!(result.error instanceof Error) || !(result.error.cause instanceof Error))
    throw new Error('拒绝未保留原前置错误', { cause: result.error })
  return result.error.cause
}

/** 真正的应用标识连接；所有连接仍由本测试数据库的 query finally 关闭。 */
async function applicationRequest<T>(work: (client: pg.Client, pid: number) => Promise<T>): Promise<T> {
  return database.query(async (client) => {
    await client.query('SET application_name = \'nerve-office-api\'')
    await client.query('SET lock_timeout = \'5s\'')
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    return work(client, pid)
  })
}

async function lockResult(client: pg.Client, sql: string): Promise<LockResult> {
  try {
    await client.query(sql)
    return 'acquired'
  }
  catch (error) {
    if ((error as { code?: unknown }).code === '57014')
      return 'cancelled'
    throw error
  }
}

async function cancelRequest(pid: number): Promise<void> {
  expect(pid).toBeGreaterThan(0)
  const cancelled = await database.query(async client => (await client.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0]!.cancelled)
  expect(cancelled).toBe(true)
}

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

describe('interruptWhileHeldLock：只在原请求仍被本轮 holder 阻塞时故意终止', () => {
  it('核对后取消真实等待语句，收取结局再放锁，不要求终止后的请求仍在等待', async () => {
    let pid = 0
    const phases: string[] = []
    const result = await interruptWhileHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async () => applicationRequest(async (client, target) => {
        pid = target
        return lockResult(client, HOLD_ADVISORY_LOCK)
      }),
      beforeInterrupt: async () => {
        phases.push('checked')
      },
      interrupt: async () => {
        phases.push('interrupt')
        await cancelRequest(pid)
      },
    })
    expect(result).toBe('cancelled')
    expect(phases).toEqual(['checked', 'interrupt'])
    expect(await applicationRequest(async client => lockResult(client, HOLD_ADVISORY_LOCK))).toBe('acquired')
  })

  it('请求还没等锁就结束：拒绝故意终止', async () => {
    let interrupted = false
    const cause = await rejectionCause(interruptWhileHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async () => answeredAt(403),
      interrupt: async () => {
        interrupted = true
      },
    }))
    expect(cause.message).toContain('结束')
    expect(interrupted).toBe(false)
  })

  it('唯一应用等待者被另一 holder 阻塞：不得把它当作本轮目标', async () => {
    let pid = 0
    let interrupted = false
    // 外层持有另一把真实锁，并在确认请求确实被它阻塞后释放；内层只能操作自己的 holder。
    const result = raceAgainstHeldLock(database, {
      hold: async client => client.query(HOLD_OTHER_LOCK),
      request: async () => interruptWhileHeldLock(database, {
        hold: async client => client.query(HOLD_ADVISORY_LOCK),
        request: async () => applicationRequest(async (client, target) => {
          pid = target
          return lockResult(client, HOLD_OTHER_LOCK)
        }),
        interrupt: async () => {
          interrupted = true
          await cancelRequest(pid)
        },
      }),
      change: async () => undefined,
    })
    await expect(result).rejects.toThrow()
    expect(interrupted).toBe(false)
  })

  it('初次观察有两个应用等待者：保持 count === 1，不对任意一个发信号', async () => {
    const pids: number[] = []
    let requests: Promise<LockResult>[] = []
    let interrupted = false
    const result = interruptWhileHeldLock(database, {
      hold: async (client) => {
        await client.query(HOLD_ADVISORY_LOCK)
        requests = [0, 1].map(async () => applicationRequest(async (application, pid) => {
          pids.push(pid)
          return lockResult(application, HOLD_ADVISORY_LOCK)
        }))
        expect(await completesWithoutWaiting(database, Promise.all(requests), 2)).toBe(false)
      },
      request: async () => Promise.all(requests),
      interrupt: async () => {
        interrupted = true
        await Promise.all(pids.map(cancelRequest))
      },
    })
    expect((await rejectionCause(result)).message).toContain('唯一')
    expect(interrupted).toBe(false)
    await expect(Promise.all(requests)).resolves.toEqual(['acquired', 'acquired'])
  })

  it('核对期间又来一个应用等待者：不得放宽为至少一个', async () => {
    const pids: number[] = []
    let other: Promise<LockResult> | undefined
    let interrupted = false
    const request = async (): Promise<LockResult> => applicationRequest(async (client, pid) => {
      pids.push(pid)
      return lockResult(client, HOLD_ADVISORY_LOCK)
    })
    const result = interruptWhileHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request,
      beforeInterrupt: async () => {
        other = request()
        expect(await completesWithoutWaiting(database, other, 2)).toBe(false)
      },
      interrupt: async () => {
        interrupted = true
        await Promise.all(pids.map(cancelRequest))
      },
    })
    expect((await rejectionCause(result)).message).toContain('唯一')
    expect(interrupted).toBe(false)
    await expect(other).resolves.toBe('acquired')
  })

  it.each(['另一连接', '同一连接的新语句'] as const)('核对期间目标换为%s，原请求整体还未结束：仍不得发信号', async (replacement) => {
    const firstCancelled = deferred()
    const startNext = deferred()
    const otherFinished = deferred()
    let firstPid = 0
    let nextPid = 0
    let interrupted = false
    let pending: Promise<LockResult> | undefined
    let other: Promise<LockResult> | undefined
    const result = interruptWhileHeldLock(database, {
      hold: async client => client.query(HOLD_ADVISORY_LOCK),
      request: async () => {
        pending = applicationRequest(async (client, pid) => {
          firstPid = pid
          expect(await lockResult(client, HOLD_ADVISORY_LOCK)).toBe('cancelled')
          firstCancelled.resolve()
          if (replacement === '同一连接的新语句') {
            await startNext.promise
            nextPid = pid
            return lockResult(client, HOLD_ADVISORY_LOCK)
          }
          await otherFinished.promise
          return 'cancelled'
        })
        return pending
      },
      beforeInterrupt: async () => {
        await cancelRequest(firstPid)
        await firstCancelled.promise
        if (replacement === '同一连接的新语句') {
          startNext.resolve()
          expect(await completesWithoutWaiting(database, pending!, 1)).toBe(false)
        }
        else {
          other = applicationRequest(async (client, pid) => {
            nextPid = pid
            return lockResult(client, HOLD_ADVISORY_LOCK)
          })
          void other.then(() => otherFinished.resolve(), () => otherFinished.resolve())
          expect(await completesWithoutWaiting(database, other, 1)).toBe(false)
        }
      },
      interrupt: async () => {
        interrupted = true
        await cancelRequest(nextPid)
      },
    })
    expect((await rejectionCause(result)).message).toContain('目标')
    expect(interrupted).toBe(false)
    if (replacement === '另一连接') {
      expect(nextPid).not.toBe(firstPid)
      await expect(other).resolves.toBe('acquired')
    }
    else {
      expect(nextPid).toBe(firstPid)
    }
  })
})

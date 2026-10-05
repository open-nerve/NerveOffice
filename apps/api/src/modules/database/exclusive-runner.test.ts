import type { SQL } from 'drizzle-orm'
import type pg from 'pg'
import type { Database, Transaction } from './database.ts'
import type { TransactionRunner } from './transaction-runner.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { ExclusiveRunner } from './exclusive-runner.ts'

const LOCK = 'nerve-office:trash-purge'

interface FakeOptions {
  /** 取锁的结果；默认拿得到 */
  locked?: boolean
  /** 释放锁的结果；默认释放成功 */
  unlocked?: boolean
  /** 释放锁时报错 */
  unlockFails?: boolean
}

/** 假的连接：记下执行过的语句（按函数名）与参数；取锁与释放的结果由用例给定。 */
function fakeClient(options: FakeOptions = {}) {
  const { locked = true, unlocked = true, unlockFails = false } = options
  const calls: { name: string, values: unknown[] }[] = []
  return {
    calls,
    release: vi.fn(),
    getTransactionStatus: vi.fn((): 'I' | 'T' | 'E' => 'I'),
    query: vi.fn(async (text: string, values: unknown[]) => {
      const isLock = text.includes('pg_try_advisory_lock')
      calls.push({ name: isLock ? 'lock' : 'unlock', values })
      if (!isLock && unlockFails)
        throw new Error('释放锁失败')
      return { rows: [isLock ? { locked } : { unlocked }], rowCount: 1, command: '', fields: [] }
    }),
  }
}

function runnerWith(client: ReturnType<typeof fakeClient>): ExclusiveRunner {
  const pool = { connect: vi.fn(async () => client) }
  return new ExclusiveRunner(pool as unknown as pg.Pool, {} as Database, {} as TransactionRunner)
}

const dialect = new PgDialect()

/** 事务级的版本：假的事务记下执行过的语句（SQL 文本与参数），取锁的结果由用例给定；假的事务运行器记下提交还是回滚 */
function transactional(locked: boolean) {
  const statements: { sql: string, params: unknown[] }[] = []
  const outcomes: ('committed' | 'rolled back')[] = []
  const transaction = {
    execute: vi.fn(async (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query)
      statements.push({ sql: text, params })
      return { rows: [{ locked }] }
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
      try {
        const result = await work(transaction as unknown as Transaction)
        outcomes.push('committed')
        return result
      }
      catch (error) {
        outcomes.push('rolled back')
        throw error
      }
    }),
  }
  const pool = { connect: vi.fn() }
  const runner = new ExclusiveRunner(pool as unknown as pg.Pool, {} as Database, transactions as unknown as TransactionRunner)
  return { runner, statements, outcomes, transaction, pool }
}

describe('ExclusiveRunner', () => {
  it('拿到锁：在同一个连接上取锁、执行、释放，连接照常放回', async () => {
    const client = fakeClient()
    const work = vi.fn(async () => 42)
    await expect(runnerWith(client).run(LOCK, work)).resolves.toEqual({ ran: true, result: 42 })
    expect(work).toHaveBeenCalledTimes(1)
    expect(client.calls).toEqual([{ name: 'lock', values: [LOCK] }, { name: 'unlock', values: [LOCK] }])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('锁在别处：不执行，也不发释放的语句，连接照常放回', async () => {
    const client = fakeClient({ locked: false })
    const work = vi.fn(async () => 42)
    await expect(runnerWith(client).run(LOCK, work)).resolves.toEqual({ ran: false })
    expect(work).not.toHaveBeenCalled()
    expect(client.calls.map(call => call.name)).toEqual(['lock'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('work 抛出：先释放锁，再把原来的错误抛给调用方，连接丢弃', async () => {
    const client = fakeClient()
    const failing = runnerWith(client).run(LOCK, async () => {
      throw new Error('一轮跑砸了')
    })
    await expect(failing).rejects.toThrow('一轮跑砸了')
    expect(client.calls.map(call => call.name)).toEqual(['lock', 'unlock'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('释放失败时丢弃连接：会话结束，数据库随即释放这把锁', async () => {
    const failed = fakeClient({ unlockFails: true })
    await expect(runnerWith(failed).run(LOCK, async () => 1)).resolves.toEqual({ ran: true, result: 1 })
    expect(failed.release).toHaveBeenCalledExactlyOnceWith(true)

    // 数据库说这个会话并没有持有它（不该发生）时同样丢弃
    const notHeld = fakeClient({ unlocked: false })
    await expect(runnerWith(notHeld).run(LOCK, async () => 1)).resolves.toEqual({ ran: true, result: 1 })
    expect(notHeld.release).toHaveBeenCalledExactlyOnceWith(true)
  })
})

describe('ExclusiveRunner.runTransaction（事务级的锁：一件本身就是一个短事务的事，M3-P3 设计 §3.9）', () => {
  const REVISION_LOCK = 'nerve-office:revision-purge'

  it('拿到锁：在同一个事务里先取锁、再执行 work，正常返回时提交；锁随事务结束释放，没有释放的语句，也不另借连接', async () => {
    const { runner, statements, outcomes, transaction, pool } = transactional(true)
    const work = vi.fn(async (tx: Transaction) => {
      // work 拿到的就是取锁的那个事务
      expect(tx).toBe(transaction)
      return 7
    })
    await expect(runner.runTransaction(REVISION_LOCK, work)).resolves.toEqual({ ran: true, result: 7 })
    expect(work).toHaveBeenCalledTimes(1)
    expect(statements).toEqual([{ sql: 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', params: [REVISION_LOCK] }])
    expect(outcomes).toEqual(['committed'])
    // 只用事务运行器借的那一个连接
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('锁在别处：不执行 work，空事务照常结束', async () => {
    const { runner, statements, outcomes } = transactional(false)
    const work = vi.fn(async () => 7)
    await expect(runner.runTransaction(REVISION_LOCK, work)).resolves.toEqual({ ran: false })
    expect(work).not.toHaveBeenCalled()
    expect(statements).toHaveLength(1)
    expect(outcomes).toEqual(['committed'])
  })

  it('work 抛出：事务回滚，原来的错误抛给调用方', async () => {
    const { runner, outcomes } = transactional(true)
    await expect(runner.runTransaction(REVISION_LOCK, async () => {
      throw new Error('这一批跑砸了')
    })).rejects.toThrow('这一批跑砸了')
    expect(outcomes).toEqual(['rolled back'])
  })
})

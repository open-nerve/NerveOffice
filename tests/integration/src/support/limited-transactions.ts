// 限时的事务（事务运行器的 limit，M3-P5 复验 C1、再复核 D1、D2）的测试替身：不加环境变量，在运行的应用上
// - 换掉限时事务的时限（包装 TransactionRunner.run：带着 limit 开启的事务按 patch 改，记下原来的 limit；不限时的事务原样执行）；
// - 让下一个借出的连接在执行设下时限的那一条语句之前停一会儿：模拟应用在 BEGIN 与第一条语句之间停住（事件循环卡死、进程被暂停）。
import type { Database } from '@nerve-office/api/testing'
import type pg from 'pg'
import type { TestApp } from './api-app.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { TransactionRunner } from '@nerve-office/api'
import { DATABASE } from '@nerve-office/api/testing'
import { vi } from 'vitest'

type RunOptions = NonNullable<Parameters<TransactionRunner['run']>[1]>
export type TransactionLimit = NonNullable<RunOptions['limit']>

export interface PatchedLimits {
  /** 限时的事务带来的原来的 limit（按先后） */
  readonly requested: readonly TransactionLimit[]
  /** 复原 */
  readonly restore: () => void
}

/** 带着 limit 开启的事务按 patch 改它的时限（例如把 60 秒换成 2 秒）；不限时的事务原样执行 */
export function patchTransactionLimits(app: TestApp, patch: Partial<TransactionLimit>): PatchedLimits {
  const runner = app.runtime.get(TransactionRunner)
  const run = runner.run.bind(runner)
  const requested: TransactionLimit[] = []
  const spy = vi.spyOn(runner, 'run').mockImplementation(async (work: Parameters<typeof run>[0], options?: RunOptions) => {
    const limit = options?.limit
    if (limit === undefined)
      return run(work, options)
    requested.push(limit)
    return run(work, { ...options, limit: { ...limit, ...patch } })
  })
  return { requested, restore: () => spy.mockRestore() }
}

/**
 * 这个应用接下来第一次执行设下时限的那一条语句（带 transaction_timeout 的）之前停 ms 毫秒：BEGIN 已经执行，数据库里这个事务"事务中空闲"
 * 了这么久。只包装以 Promise 形式借出的连接（事务运行器借连接的方式），连接池上的查询（回调形式）照旧；只停一次。交回复原的函数
 */
export function stallBeforeLimit(app: TestApp, ms: number): () => void {
  // Drizzle 实例上的 $client 就是应用的连接池（运行时有，导出的 Database 类型里没写）
  const pool = (app.runtime.get<Database>(DATABASE) as unknown as { readonly $client: pg.Pool }).$client
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown
  /** 包装过的连接：复原时去掉实例上的 query，回到 pg 原型上的方法 */
  const wrapped: pg.PoolClient[] = []
  let stalled = false
  const spy = vi.spyOn(pool, 'connect').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'function' || stalled)
      return connect(...args)
    return (connect() as Promise<pg.PoolClient>).then((client) => {
      const query = client.query.bind(client) as (config: { text: string }, values?: unknown[]) => Promise<unknown>
      wrapped.push(client)
      client.query = (async (config: { text: string }, values?: unknown[]) => {
        if (!stalled && typeof config === 'object' && config.text.includes('transaction_timeout')) {
          stalled = true
          await delay(ms)
        }
        return query(config, values)
      }) as typeof client.query
      return client
    })
  })
  return () => {
    spy.mockRestore()
    for (const client of wrapped)
      Reflect.deleteProperty(client, 'query')
  }
}

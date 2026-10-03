import type { Request, Response } from 'express'
import type pg from 'pg'
import type { DbTransaction, Transaction } from './database.ts'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { CommitLedger } from './commit-ledger.ts'
import { NESTED_IN_SNAPSHOT_MESSAGE, TRANSACTION_ABORTED_MESSAGE, TransactionRunner } from './transaction-runner.ts'

type TransactionStatus = 'I' | 'T' | 'E'

/**
 * 假的连接：记下执行过的语句；failOn 里的语句（按第一个词）执行时报错。
 * 事务状态按 PostgreSQL 的规则变化：BEGIN 之后在事务中，事务中的语句失败后事务中止，COMMIT、ROLLBACK 之后空闲；
 * 事务中止之后，除了 ROLLBACK，任何语句都报 25P02。
 */
function fakeClient(failOn: readonly string[] = []) {
  const statements: string[] = []
  let status: TransactionStatus = 'I'
  return {
    statements,
    release: vi.fn(),
    getTransactionStatus: vi.fn((): TransactionStatus => status),
    /** 模拟事务里有语句失败，而 work 把错误吞掉了 */
    abort: () => {
      status = 'E'
    },
    query: vi.fn(async (config: { text: string }) => {
      statements.push(config.text)
      const verb = prefix(config.text).toLowerCase()
      if (status === 'E' && verb !== 'rollback')
        throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' })
      if (failOn.includes(verb)) {
        if (status === 'T')
          status = 'E'
        throw new Error(`${verb} 失败`)
      }
      if (verb === 'begin')
        status = 'T'
      else if (verb === 'commit' || verb === 'rollback')
        status = 'I'
      return { rows: [], rowCount: 0, command: '', fields: [] }
    }),
  }
}

function prefix(text: string): string {
  return (text.split(' ')[0] ?? text).toLowerCase()
}

function runnerWith(client: ReturnType<typeof fakeClient>, commits = new CommitLedger()): TransactionRunner {
  const pool = { connect: vi.fn(async () => client) }
  return new TransactionRunner(pool as unknown as pg.Pool, commits)
}

/** 在一个请求的记录里执行 work：与 HTTP 管线里同一个中间件 */
async function inRequest<T>(commits: CommitLedger, work: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined
  commits.middleware()({} as Request, {} as Response, () => {
    pending = work()
  })
  if (pending === undefined)
    throw new Error('中间件没有往下走')
  return pending
}

describe('TransactionRunner', () => {
  it('work 正常结束：确认事务可用，提交，连接照常放回', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => 42)).resolves.toBe(42)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'commit'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('业务错误（AppError）：回滚成功，抛出原来的错误，连接照常放回', async () => {
    const client = fakeClient()
    const error = new AppError('NOT_FOUND')
    await expect(runnerWith(client).run(async () => {
      throw error
    })).rejects.toBe(error)
    expect(client.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('其他错误（例如查询超时）：回滚后丢弃连接，它可能已经断开或半开', async () => {
    const client = fakeClient()
    const error = new Error('Query read timeout')
    await expect(runnerWith(client).run(async () => {
      throw error
    })).rejects.toBe(error)
    expect(client.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('BEGIN 失败：连接同样归还并丢弃，不会泄漏（drizzle 自己的 transaction() 在这里不归还连接）', async () => {
    const client = fakeClient(['begin'])
    const work = vi.fn(async () => 1)
    await expect(runnerWith(client).run(work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('COMMIT 失败：丢弃连接', async () => {
    const client = fakeClient(['commit'])
    await expect(runnerWith(client).run(async () => 1)).rejects.toThrow()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('业务错误之后回滚也失败：抛出的是回滚的错误，丢弃连接', async () => {
    const client = fakeClient(['rollback'])
    await expect(runnerWith(client).run(async () => {
      throw new AppError('NOT_FOUND')
    })).rejects.not.toBeInstanceOf(AppError)
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('work 吞掉了失败的语句却正常返回：事务已中止，不当作成功，回滚并丢弃连接', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => {
      client.abort()
      return 1
    })).rejects.toThrow(TRANSACTION_ABORTED_MESSAGE)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('不依赖连接上记下的事务状态：状态还没更新（驱动先收到错误、后收到 ReadyForQuery）时同样发现事务已中止', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).run(async () => {
      client.abort()
      // 模拟状态还停在"事务中"：确认要靠真正执行一条语句
      client.getTransactionStatus.mockReturnValueOnce('T')
      return 1
    })).rejects.toThrow(TRANSACTION_ABORTED_MESSAGE)
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'rollback'])
  })

  it('确认的语句因为别的原因失败（例如连接断开）：原样抛出，丢弃连接', async () => {
    const client = fakeClient(['select'])
    await expect(runnerWith(client).run(async () => 1)).rejects.not.toThrow(TRANSACTION_ABORTED_MESSAGE)
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('归还时连接不是空闲状态（例如 ROLLBACK 没能发出）：即使是业务错误也丢弃', async () => {
    const client = fakeClient()
    client.getTransactionStatus.mockReturnValue('T')
    await expect(runnerWith(client).run(async () => {
      throw new AppError('NOT_FOUND')
    })).rejects.toBeInstanceOf(AppError)
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('取不到连接：直接抛出，没有要归还的连接', async () => {
    const pool = { connect: vi.fn(async () => {
      throw new Error('timeout exceeded when trying to connect')
    }) }
    await expect(new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger()).run(async () => 1)).rejects.toThrow('timeout exceeded')
  })
})

describe('TransactionRunner：提交之后在这个请求的记录上记一笔（CommitLedger，M2-P6 第 3 片复验）', () => {
  it('COMMIT 成功之后才记：work 里（还没提交）看到的是没有提交过，返回之后是提交过', async () => {
    const commits = new CommitLedger()
    const client = fakeClient()
    const seen = await inRequest(commits, async () => {
      const during = await runnerWith(client, commits).run(async () => commits.hasCommitted())
      return { during, after: commits.hasCommitted() }
    })
    expect(seen).toEqual({ during: false, after: true })
    expect(client.statements.map(prefix)).toEqual(['begin', 'select', 'commit'])
  })

  it('回滚（业务错误、意外错误、事务已中止）与 COMMIT 失败都不记', async () => {
    const outcomes: [string, ReturnType<typeof fakeClient>, () => Promise<unknown>][] = []
    const rolledBack = fakeClient()
    outcomes.push(['业务错误', rolledBack, async () => {
      throw new AppError('NOT_FOUND')
    }])
    const failed = fakeClient()
    outcomes.push(['意外错误', failed, async () => {
      throw new Error('Query read timeout')
    }])
    const aborted = fakeClient()
    outcomes.push(['事务已中止', aborted, async () => {
      aborted.abort()
    }])
    outcomes.push(['COMMIT 失败', fakeClient(['commit']), async () => 1])
    for (const [name, client, work] of outcomes) {
      const commits = new CommitLedger()
      const committed = await inRequest(commits, async () => {
        await runnerWith(client, commits).run(work).catch(() => undefined)
        return commits.hasCommitted()
      })
      expect(committed, name).toBe(false)
    }
  })

  it('不在请求里（命令行、定时任务）：照常提交，没有记录可记', async () => {
    const commits = new CommitLedger()
    await expect(runnerWith(fakeClient(), commits).run(async () => 1)).resolves.toBe(1)
    expect(commits.hasCommitted()).toBe(false)
  })
})

/** 在快照的事务上发一条语句：测试里把不透明的事务换回执行器（服务只能把事务原样传给仓储） */
async function select(transaction: Transaction, label: 'opening' | 'work'): Promise<void> {
  const executor = transaction as unknown as DbTransaction
  await (label === 'opening' ? executor.execute(sql`select 'opening'`) : executor.execute(sql`select 'work'`))
}

describe('TransactionRunner.readSnapshot：读请求的只读快照（M2 Codex 评审 CX1）', () => {
  it('REPEATABLE READ、READ ONLY：先执行登记的开场核对（第一条语句），再执行 work，COMMIT；不记提交、不另发确认的语句，连接照常放回', async () => {
    const client = fakeClient()
    const commits = new CommitLedger()
    const runner = runnerWith(client, commits)
    runner.registerSnapshotOpening(async transaction => select(transaction, 'opening'))
    const seen = await inRequest(commits, async () => {
      const value = await runner.readSnapshot(async (transaction) => {
        await select(transaction, 'work')
        return 7
      })
      return { value, committed: commits.hasCommitted() }
    })
    expect(seen).toEqual({ value: 7, committed: false })
    expect(client.statements).toEqual(['begin isolation level repeatable read read only', 'select \'opening\'', 'select \'work\'', 'commit'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('开场核对不通过（AppError，例如登录已过期）：work 不执行，回滚，连接照常放回', async () => {
    const client = fakeClient()
    const runner = runnerWith(client)
    const expired = new AppError('SESSION_EXPIRED')
    runner.registerSnapshotOpening(async () => {
      throw expired
    })
    const work = vi.fn(async () => 1)
    await expect(runner.readSnapshot(work)).rejects.toBe(expired)
    expect(work).not.toHaveBeenCalled()
    expect(client.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('归还连接的规则与 run() 一致：业务错误回滚后放回，其他错误回滚后丢弃，BEGIN 失败也归还并丢弃', async () => {
    const business = fakeClient()
    await expect(runnerWith(business).readSnapshot(async () => {
      throw new AppError('NOT_FOUND')
    })).rejects.toBeInstanceOf(AppError)
    expect(business.statements.map(prefix)).toEqual(['begin', 'rollback'])
    expect(business.release).toHaveBeenCalledExactlyOnceWith(false)

    const unexpected = fakeClient()
    await expect(runnerWith(unexpected).readSnapshot(async () => {
      throw new Error('Query read timeout')
    })).rejects.toThrow('Query read timeout')
    expect(unexpected.release).toHaveBeenCalledExactlyOnceWith(true)

    const beginFails = fakeClient(['begin'])
    const work = vi.fn(async () => 1)
    await expect(runnerWith(beginFails).readSnapshot(work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
    expect(beginFails.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('没有登记开场核对（单元测试、只组装了部分模块的命令行）：只执行 work', async () => {
    const client = fakeClient()
    await expect(runnerWith(client).readSnapshot(async (transaction) => {
      await select(transaction, 'work')
      return 'ok'
    })).resolves.toBe('ok')
    expect(client.statements).toEqual(['begin isolation level repeatable read read only', 'select \'work\'', 'commit'])
  })

  it('开场核对只能登记一次：再登记是接线错误，报错，不悄悄盖掉先登记的', () => {
    const runner = runnerWith(fakeClient())
    runner.registerSnapshotOpening(async () => {})
    expect(() => runner.registerSnapshotOpening(async () => {})).toThrow('只读快照的开场核对已经登记过')
  })

  it('一个请求只开一个快照：快照里再开快照或写事务直接报错，不另借连接（连接池满时会与外层互相等待）', async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const runner = new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger())
    await expect(runner.readSnapshot(async () => runner.readSnapshot(async () => 1))).rejects.toThrow(NESTED_IN_SNAPSHOT_MESSAGE)
    await expect(runner.readSnapshot(async () => runner.run(async () => 1))).rejects.toThrow(NESTED_IN_SNAPSHOT_MESSAGE)
    expect(pool.connect).toHaveBeenCalledTimes(2)
    // 快照结束之后照常
    await expect(runner.run(async () => 2)).resolves.toBe(2)
    await expect(runner.readSnapshot(async () => 3)).resolves.toBe(3)
  })

  it('快照里排下、快照结束之后才执行的事务（定时器、没有等的异步操作）不是嵌套：照常执行', async () => {
    const client = fakeClient()
    const pool = { connect: vi.fn(async () => client) }
    const runner = new TransactionRunner(pool as unknown as pg.Pool, new CommitLedger())
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let later: Promise<number> | undefined
    await runner.readSnapshot(async () => {
      later = released.then(async () => runner.run(async () => 4))
    })
    release()
    await expect(later).resolves.toBe(4)
  })
})
